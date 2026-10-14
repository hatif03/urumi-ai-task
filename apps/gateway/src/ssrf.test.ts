import { describe, expect, test } from "bun:test";
import { assertSafeUpstreamUrl, SsrfError } from "./ssrf.ts";

describe("ssrf", () => {
  test("rejects the cloud metadata address, loopback, and the kubernetes API", async () => {
    await expect(assertSafeUpstreamUrl("http://169.254.169.254/latest")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUpstreamUrl("http://127.0.0.1:8080/mcp")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUpstreamUrl("http://kubernetes.default.svc.cluster.local/api")).rejects.toBeInstanceOf(SsrfError);
  });

  test("allows the in-cluster WooCommerce MCP hostname", async () => {
    const url = await assertSafeUpstreamUrl("http://woocommerce-mcp.store.svc.cluster.local:8080/mcp");
    expect(url.hostname).toBe("woocommerce-mcp.store.svc.cluster.local");
  });

  test("rejects userinfo and non-http schemes", async () => {
    await expect(assertSafeUpstreamUrl("http://user:pass@example.com/mcp")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUpstreamUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
  });
});
