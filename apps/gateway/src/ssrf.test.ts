import { describe, expect, test } from "bun:test";
import { assertSafeUpstreamUrl, isBlockedIp, pinnedFetch, resolveUpstream, SsrfError } from "./ssrf.ts";

const rejects = (url: string, allowlist: string[] = []) => expect(assertSafeUpstreamUrl(url, allowlist)).rejects.toBeInstanceOf(SsrfError);

describe("ssrf", () => {
  test("rejects the cloud metadata address, loopback, and the kubernetes API", async () => {
    await rejects("http://169.254.169.254/latest");
    await rejects("http://127.0.0.1:8080/mcp");
    await rejects("http://kubernetes.default.svc.cluster.local/api");
    await rejects("http://metadata.google.internal/computeMetadata/v1/");
  });

  test("rejects every private and special range, IPv4 and IPv6", async () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "[::1]", "[fe80::1]", "[fd00::1]", "[::]"]) {
      await rejects(`http://${ip}/mcp`);
    }
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  test("sees an IPv4 address hidden in an IPv6 literal", async () => {
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true);
    await rejects("http://[::ffff:169.254.169.254]/latest");
  });

  test("rejects local-only names but not a public name that merely starts with ff", async () => {
    await rejects("http://localhost:8080/mcp");
    await rejects("http://printer.local/mcp");
    await rejects("http://db.internal/mcp");
    // regression: a hostname starting with "ff" was treated as an IPv6 multicast prefix
    const error = await assertSafeUpstreamUrl("http://ffmpeg.example.com/mcp").catch((caught) => caught);
    if (error instanceof Error) expect(error.message).not.toMatch(/blocked/);
  });

  test("allows the in-cluster WooCommerce MCP hostname without DNS", async () => {
    const resolved = await resolveUpstream("http://woocommerce-mcp.store.svc.cluster.local:8080/mcp");
    expect(resolved.url.hostname).toBe("woocommerce-mcp.store.svc.cluster.local");
  });

  test("an allowlisted host may be private", async () => {
    const resolved = await resolveUpstream("http://127.0.0.1:9/mcp", ["127.0.0.1"]);
    expect(resolved.address).toBe("127.0.0.1");
  });

  test("rejects userinfo and non-http schemes", async () => {
    await rejects("http://user:pass@example.com/mcp");
    await rejects("file:///etc/passwd");
    await rejects("gopher://example.com/");
  });

  test("pinned fetch connects to the checked address and keeps the Host header", async () => {
    let seenHost = "";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { seenHost = req.headers.get("host") ?? ""; return new Response("ok"); } });
    try {
      const url = new URL(`http://mcp.example.test:${server.port}/mcp`);
      const fetcher = pinnedFetch({ url, address: "127.0.0.1" });
      expect(await (await fetcher(url.href)).text()).toBe("ok");
      expect(seenHost).toBe(`mcp.example.test:${server.port}`);
      expect(() => fetcher("http://other.example.test/mcp")).toThrow(SsrfError);
    } finally {
      server.stop(true);
    }
  });
});
