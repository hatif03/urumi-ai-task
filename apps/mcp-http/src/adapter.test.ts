import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createMcpApp } from "./adapter.ts";

const app = createMcpApp({
  name: "protocol-test",
  version: "0.0.1",
  tools: () => [
    {
      name: "echo",
      description: "Echo a message",
      inputSchema: z.object({ message: z.string() }),
      handler: async (args) => ({
        content: [{ type: "text", text: String(args.message) }],
        structuredContent: { message: String(args.message) },
      }),
    },
  ],
});

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

describe("stateless streamable http", () => {
  test("initialize returns one JSON object and 2025-06-18", async () => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(Array.isArray(body)).toBe(false);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  test("a batch body returns 400", async () => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    });
    expect(response.status).toBe(400);
  });

  test("tools/call with a bad schema returns -32602", async () => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { ...headers, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } }),
    });
    const body = await response.json();
    expect(body.error.code).toBe(-32602);
  });

  test("GET /mcp returns 405", async () => {
    const response = await app.request("/mcp", { method: "GET" });
    expect(response.status).toBe(405);
  });
});
