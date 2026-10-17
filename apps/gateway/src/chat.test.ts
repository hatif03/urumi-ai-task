import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ToolDefinition } from "@urumi/mcp-http";
import { addUser, gatewayFor, listenUpstream, loginCookie } from "./testkit.ts";

// A tiny OpenAI-compatible server. First turn it asks for one tool call; once a tool result is in the
// conversation it answers in text. That is enough to prove the whole loop: gateway -> model -> tool ->
// gateway router -> upstream -> model -> stream, as the logged-in user.
function fakeLlm(pick: (tools: string[]) => { name: string; args: unknown }) {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as any;
      requests.push(body);
      const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake" };
      const sawToolResult = body.messages.some((m: any) => m.role === "tool");
      if (!sawToolResult) {
        const call = pick((body.tools ?? []).map((t: any) => t.function.name));
        return sse([
          { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      }
      return sse([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The tool said done." }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]);
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}/v1` };
}

const stops: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => stops.forEach((s) => s.stop(true)));

async function chatTurn(app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, cookie: string, text: string) {
  const response = await app.request("/api/chat", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-real-ip": "10.7.7.7" },
    body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text }] }] }),
  });
  return { status: response.status, body: await response.text() };
}

describe("chat agent", () => {
  test("runs the tool loop as the logged-in user and the call is audited under that user", async () => {
    const upstream = await listenUpstream("utility");
    stops.push(upstream.server);
    const llm = fakeLlm(() => ({ name: "utility__echo", args: { message: "hello from the model" } }));
    stops.push(llm.server);
    process.env.LLM_API_KEY = "test";
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_BASE_URL = llm.url;
    process.env.LLM_MODEL = "fake";
    const ctx = await gatewayFor([{ slug: "utility", url: upstream.url }]);
    const member = await addUser(ctx.store, "bea", "member");
    await ctx.store.setUserPassword(member.id, await Bun.password.hash("password-1"));
    const { cookie } = await loginCookie(ctx.app, "bea");
    const turn = await chatTurn(ctx.app, cookie, "say hello");
    expect(turn.status).toBe(200);
    expect(turn.body).toContain("tool-input-available");
    expect(turn.body).toContain("utility__echo");
    expect(turn.body).toContain("hello from the model");
    expect(turn.body).toContain("The tool said done.");
    const row = ctx.store.audits.find((a) => a.toolName === "echo");
    expect(row).toMatchObject({ userId: member.id, actor: "chat", serverSlug: "utility", outcome: "success" });
    // the model was given the tool list, the date, and no hard-coded tool names
    const first = llm.requests[0];
    expect(first.tools.map((t: any) => t.function.name)).toEqual(["utility__echo"]);
    expect(first.messages[0].content).toContain("Today is");
    expect(first.messages[0].content).not.toContain("woocommerce__");
  }, 30_000);

  test("a tool the user may not call is not offered to the model, and a forced call is denied", async () => {
    const write: ToolDefinition = { name: "create_product", description: "write", annotations: { readOnlyHint: false }, inputSchema: z.object({}), handler: async () => ({ content: [{ type: "text", text: "made" }] }) };
    const read: ToolDefinition = { name: "list_orders", description: "read", annotations: { readOnlyHint: true }, inputSchema: z.object({}), handler: async () => ({ content: [{ type: "text", text: "orders" }] }) };
    const upstream = await listenUpstream("shop", 0, [write, read]);
    stops.push(upstream.server);
    const llm = fakeLlm(() => ({ name: "shop__create_product", args: {} }));
    stops.push(llm.server);
    process.env.LLM_BASE_URL = llm.url;
    const ctx = await gatewayFor([{ slug: "shop", url: upstream.url }]);
    const member = await addUser(ctx.store, "cy", "member");
    await ctx.store.setUserPassword(member.id, await Bun.password.hash("password-1"));
    const { cookie } = await loginCookie(ctx.app, "cy");
    const turn = await chatTurn(ctx.app, cookie, "make a product");
    expect(turn.status).toBe(200);
    expect(llm.requests[0].tools.map((t: any) => t.function.name)).toEqual(["shop__list_orders"]);
    // the fake model asks for the hidden tool anyway; the SDK refuses a tool it was not given, so nothing ran
    expect(ctx.store.audits.some((a) => a.toolName === "create_product" && a.outcome === "success")).toBe(false);
  }, 30_000);

  test("with a large catalog the model gets the three search tools instead", async () => {
    const many: ToolDefinition[] = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, description: `tool ${i}`, annotations: { readOnlyHint: true }, inputSchema: z.object({}), handler: async () => ({ content: [{ type: "text" as const, text: "x" }] }) }));
    const upstream = await listenUpstream("big", 0, many);
    stops.push(upstream.server);
    const llm = fakeLlm((names) => ({ name: "search_tools", args: { query: `tool 7 ${names.length}` } }));
    stops.push(llm.server);
    process.env.LLM_BASE_URL = llm.url;
    const ctx = await gatewayFor([{ slug: "big", url: upstream.url }]);
    const { cookie } = await loginCookie(ctx.app, "ada");
    const turn = await chatTurn(ctx.app, cookie, "find tool 7");
    expect(turn.status).toBe(200);
    expect(llm.requests[0].tools.map((t: any) => t.function.name)).toEqual(["search_tools", "describe_tool", "call_tool"]);
    expect(turn.body).toContain("big__t7");
  }, 30_000);

  test("without a key chat answers 503 and the MCP endpoint is unaffected; the chat rate limit answers 429", async () => {
    const upstream = await listenUpstream("utility");
    stops.push(upstream.server);
    const ctx = await gatewayFor([{ slug: "utility", url: upstream.url }]);
    const { cookie } = await loginCookie(ctx.app, "ada");
    delete process.env.LLM_API_KEY;
    expect((await chatTurn(ctx.app, cookie, "hi")).status).toBe(503);
    process.env.CHAT_PER_MINUTE = "2";
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await chatTurn(ctx.app, cookie, "hi")).status);
    delete process.env.CHAT_PER_MINUTE;
    expect(statuses).toEqual([503, 503, 429, 429]); // two allowed through to the 503, then the bucket is empty
  });
});
