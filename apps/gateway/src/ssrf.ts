import { BlockList, isIP } from "node:net";
import { currentTrace } from "@urumi/obs";

// Where an admin-supplied MCP URL may point. Three layers cooperate:
//   1. this file validates the URL and every address its name resolves to,
//   2. the connection goes to the address that passed (pinnedFetch), so a second DNS answer
//      cannot swap in a private address between check and use,
//   3. the gateway's NetworkPolicy denies egress to private ranges except the in-cluster
//      namespaces that host MCP servers.
// Layer 3 is what still holds for https upstreams, where connecting by IP would break the
// certificate name check. See docs/adr/0011-ssrf-resolve-and-pin.md.

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const BLOCKED_HOSTS = new Set(["kubernetes.default.svc.cluster.local", "kubernetes.default.svc", "kubernetes.default", "metadata.google.internal", "metadata", "instance-data"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet"];

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
] as const) blocked.addSubnet(net, prefix, "ipv6");

// ::ffff:a.b.c.d and the NAT64 prefix 64:ff9b::/96 carry an IPv4 address. Judge that address.
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all: refuse rather than guess
  const inner = family === 6 ? embeddedIpv4(address) : null;
  if (inner) return blocked.check(inner, "ipv4");
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
}

function isClusterHost(host: string): boolean {
  return host.endsWith(".svc.cluster.local") && !BLOCKED_HOSTS.has(host);
}

export type ResolvedUpstream = { url: URL; address: string | null };

export async function resolveUpstream(raw: string, allowlist: string[] = []): Promise<ResolvedUpstream> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("unsupported scheme");
  if (url.username || url.password) throw new SsrfError("userinfo is not allowed");
  const host = normalizeHost(url.hostname);
  if (!host) throw new SsrfError("invalid url");
  if (BLOCKED_HOSTS.has(host)) throw new SsrfError("blocked host");

  const allowed = allowlist.some((entry) => entry.toLowerCase() === host);

  if (isIP(host)) {
    if (isBlockedIp(host) && !allowed) throw new SsrfError("blocked address");
    return { url, address: host };
  }

  if (!allowed && !isClusterHost(host) && (host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
    throw new SsrfError("blocked host");
  }

  let addresses: string[];
  try {
    const answers = await Bun.dns.lookup(host, { family: 0 });
    addresses = (Array.isArray(answers) ? answers : [answers]).map((entry) => (typeof entry === "string" ? entry : entry.address));
  } catch {
    if (allowed || isClusterHost(host)) return { url, address: null };
    throw new SsrfError("dns lookup failed");
  }
  if (!addresses.length) throw new SsrfError("dns lookup failed");

  if (!allowed && !isClusterHost(host)) {
    // Every answer must be public: a name that also resolves to a private address is refused.
    for (const address of addresses) if (isBlockedIp(address)) throw new SsrfError("blocked address");
  }
  return { url, address: addresses[0]! };
}

export async function assertSafeUpstreamUrl(raw: string, allowlist: string[] = []): Promise<URL> {
  return (await resolveUpstream(raw, allowlist)).url;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

// http upstreams connect to the checked address and keep the original Host header.
// https upstreams are returned unpinned (see the header comment); the caller re-resolves on every
// new connection, and the network layer is the backstop.
export function pinnedFetch(resolved: ResolvedUpstream): FetchLike {
  const { url, address } = resolved;
  // W3C trace context: the upstream's spans join the gateway's trace.
  const traced = (init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const trace = currentTrace();
    if (trace) headers.set("traceparent", trace.traceparent);
    return { ...init, headers };
  };
  if (!address || url.protocol !== "http:") return (input, init) => fetch(input, traced(init));
  return (input, init) => {
    const target = new URL(typeof input === "string" ? input : input.href);
    if (target.host !== url.host) throw new SsrfError("request left the validated origin");
    const headers = new Headers(traced(init).headers);
    headers.set("host", url.host);
    target.hostname = address.includes(":") ? `[${address}]` : address;
    return fetch(target, { ...init, headers });
  };
}
