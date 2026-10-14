const BLOCKED_HOSTS = new Set(["kubernetes.default.svc.cluster.local", "metadata.google.internal"]);

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

function isBlockedAddress(address: string): boolean {
  if (address === "0.0.0.0" || address === "::" || address === "::1" || address === "localhost") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("169.254.")) return true;
  if (address.startsWith("fe80:") || address.startsWith("ff")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)) {
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

function allowsPrivate(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_HOSTS.has(host)) return false;
  if (allowlist.some((entry) => entry.toLowerCase() === host)) return true;
  return host.endsWith(".svc.cluster.local") && host !== "kubernetes.default.svc.cluster.local";
}

export async function assertSafeUpstreamUrl(raw: string, allowlist: string[] = []): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("unsupported scheme");
  if (url.username || url.password) throw new SsrfError("userinfo is not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || BLOCKED_HOSTS.has(hostname)) throw new SsrfError("blocked host");
  if (isBlockedAddress(hostname) && !allowsPrivate(hostname, allowlist)) {
    throw new SsrfError("blocked address");
  }

  let addresses: string[] = [];
  if (!isBlockedAddress(hostname)) {
    try {
      const lookedUp = await Bun.dns.lookup(hostname, { family: 0 });
      addresses = (Array.isArray(lookedUp) ? lookedUp : [lookedUp]).map((entry) =>
        typeof entry === "string" ? entry : entry.address,
      );
    } catch {
      if (!allowsPrivate(hostname, allowlist)) throw new SsrfError("dns lookup failed");
    }
  } else {
    addresses = [hostname];
  }

  for (const address of addresses) {
    if (isBlockedAddress(address) && !allowsPrivate(hostname, allowlist)) {
      throw new SsrfError("blocked address");
    }
  }

  return url;
}

export function pinnedFetchUrl(url: URL, address: string | undefined): { href: string; hostHeader: string } {
  const hostHeader = url.host;
  if (!address || url.protocol !== "http:") return { href: url.href, hostHeader };
  const port = url.port || "80";
  const pinned = new URL(url.href);
  pinned.hostname = address;
  pinned.port = port;
  return { href: pinned.href, hostHeader };
}
