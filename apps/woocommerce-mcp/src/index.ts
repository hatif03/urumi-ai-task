import { z } from "zod";
import { createMcpApp, listen, type ToolResult } from "@urumi/mcp-http";
import { childSpan, currentTrace, log } from "@urumi/obs";

const base = process.env.WC_BASE_URL ?? "http://wordpress.store.svc.cluster.local";
const key = process.env.WC_CONSUMER_KEY ?? "";
const secret = process.env.WC_CONSUMER_SECRET ?? "";
const timeoutMs = Number(process.env.WC_TIMEOUT_MS ?? 5000);

let storeTimezone = "UTC";
let timezoneFetchedAt = 0;

type WcError = Error & { status?: number; code?: string };

async function wc(path: string, init: RequestInit = {}): Promise<unknown> {
  const parent = currentTrace();
  return parent ? childSpan(parent, "woocommerce.http", { path: path.split("?")[0]! }, () => wcRequest(path, init)) : wcRequest(path, init);
}

async function wcRequest(path: string, init: RequestInit): Promise<unknown> {
  const traceparent = currentTrace()?.traceparent;
  const started = performance.now();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Basic ${btoa(`${key}:${secret}`)}`);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (traceparent) headers.set("traceparent", traceparent);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  } catch (error) {
    const failed = new Error(error instanceof Error ? error.message : "store unreachable") as WcError;
    failed.code = /timeout|aborted/i.test(failed.message) ? "upstream_timeout" : "upstream_unreachable";
    throw failed;
  }
  const text = await response.text();
  log("info", "woocommerce", { path, status: response.status, durationMs: Math.round(performance.now() - started) });
  if (response.status === 401 || response.status === 403) {
    const error = new Error("store rejected the MCP server credential") as WcError;
    error.status = response.status;
    throw error;
  }
  const body = text ? JSON.parse(text) as { message?: string; code?: string } : {};
  if (!response.ok) {
    const error = new Error(body.message || `woocommerce ${response.status}`) as WcError;
    error.status = response.status;
    throw error;
  }
  return body;
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function result(value: unknown): ToolResult {
  const structured = Array.isArray(value) ? { items: value } : value as Record<string, unknown>;
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: structured };
}

async function timezone(): Promise<string> {
  if (Date.now() - timezoneFetchedAt < 60 * 60 * 1000 && timezoneFetchedAt) return storeTimezone;
  try {
    const status = await wc("/wp-json/wc/v3/system_status") as { environment?: { default_timezone?: string } };
    storeTimezone = status.environment?.default_timezone || "UTC";
  } catch {
    storeTimezone = storeTimezone || "UTC";
  }
  timezoneFetchedAt = Date.now();
  return storeTimezone;
}

function slimProduct(product: Record<string, unknown>) {
  return { id: product.id, name: product.name, sku: product.sku, price: product.price, status: product.status, permalink: product.permalink, stock_status: product.stock_status };
}

function slimOrder(order: Record<string, unknown>) {
  const billing = (order.billing ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(order.line_items) ? order.line_items.map((item) => {
    const row = item as Record<string, unknown>;
    return { name: row.name, quantity: row.quantity };
  }) : [];
  return { id: order.id, number: order.number, status: order.status, total: order.total, currency: order.currency, date_created: order.date_created, billing_first_name: billing.first_name, line_items: lines };
}

async function mapWc<T>(fn: () => Promise<T>): Promise<ToolResult> {
  try {
    return result(await fn());
  } catch (error) {
    const status = (error as WcError).status;
    const code = (error as WcError).code;
    if (code === "upstream_timeout" || code === "upstream_unreachable") throw error;
    if (status === 401 || status === 403) return toolError("store rejected the MCP server credential");
    if (status === 404) return toolError("not found");
    return toolError(error instanceof Error ? error.message : "store request failed");
  }
}

let storeHealthy = false;
let storeCheckedAt = 0;
async function checkStore(): Promise<void> {
  try {
    await wc("/wp-json/wc/v3/products?per_page=1");
    storeHealthy = true;
  } catch {
    storeHealthy = false;
  }
  storeCheckedAt = Date.now();
}
setInterval(checkStore, 10_000);
void checkStore();

const app = createMcpApp({
  name: "woocommerce",
  version: "0.1.0",
  // Readiness reflects the store, but is answered from a check that runs in the background: a probe must
  // return in milliseconds even when WordPress takes a couple of seconds, or Kubernetes marks the pod
  // NotReady and the gateway loses the server for a slow page, not a dead one.
  ready: async () => storeHealthy && Date.now() - storeCheckedAt < 45_000,
  tools: async () => {
    const zone = await timezone();
    return [
      {
        name: "list_products",
        annotations: { readOnlyHint: true },
        description: "List published and other WooCommerce products. Returns id, name, sku, price, status, permalink, and stock status.",
        inputSchema: z.object({
          search: z.string().optional(),
          per_page: z.number().int().min(1).max(50).optional(),
          page: z.number().int().min(1).optional(),
        }),
        handler: (args) => mapWc(async () => {
          const params = new URLSearchParams();
          if (args.search) params.set("search", String(args.search));
          params.set("per_page", String(args.per_page ?? 20));
          params.set("page", String(args.page ?? 1));
          const products = await wc(`/wp-json/wc/v3/products?${params}`) as Record<string, unknown>[];
          return products.map(slimProduct);
        }),
      },
      {
        name: "create_product",
        annotations: { readOnlyHint: false, destructiveHint: false },
        description: "Create a published simple product. regular_price is a decimal string such as \"21.99\".",
        inputSchema: z.object({
          name: z.string().min(1),
          regular_price: z.string().min(1),
          description: z.string().optional(),
        }),
        handler: (args) => mapWc(async () => {
          const created = await wc("/wp-json/wc/v3/products", {
            method: "POST",
            body: JSON.stringify({ name: args.name, regular_price: args.regular_price, description: args.description ?? "", type: "simple", status: "publish", catalog_visibility: "visible" }),
          }) as Record<string, unknown>;
          return { id: created.id, name: created.name, permalink: created.permalink, price: created.price };
        }),
      },
      {
        name: "list_orders",
        annotations: { readOnlyHint: true },
        description: `List WooCommerce orders. The store timezone is ${zone}. For "today", set after to the start of the current day in that timezone and before to the end of that day. Default statuses include pending, processing, on-hold, and completed so a cash-on-delivery order is visible.`,
        inputSchema: z.object({
          after: z.string().optional(),
          before: z.string().optional(),
          status: z.array(z.string()).optional(),
          per_page: z.number().int().min(1).max(50).optional(),
          page: z.number().int().min(1).optional(),
        }),
        handler: (args) => mapWc(async () => {
          const params = new URLSearchParams();
          if (args.after) params.set("after", String(args.after));
          if (args.before) params.set("before", String(args.before));
          const statuses = (args.status as string[] | undefined) ?? ["pending", "processing", "on-hold", "completed"];
          params.set("status", statuses.join(","));
          params.set("per_page", String(args.per_page ?? 20));
          params.set("page", String(args.page ?? 1));
          const orders = await wc(`/wp-json/wc/v3/orders?${params}`) as Record<string, unknown>[];
          return orders.map(slimOrder);
        }),
      },
      {
        name: "get_order",
        annotations: { readOnlyHint: true },
        description: "Get one WooCommerce order by id.",
        inputSchema: z.object({ id: z.number().int() }),
        handler: (args) => mapWc(async () => slimOrder(await wc(`/wp-json/wc/v3/orders/${args.id}`) as Record<string, unknown>)),
      },
      {
        name: "update_order_status",
        annotations: { readOnlyHint: false, destructiveHint: true },
        description: "Set an order status.",
        inputSchema: z.object({
          id: z.number().int(),
          status: z.enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]),
        }),
        handler: (args) => mapWc(async () => {
          const updated = await wc(`/wp-json/wc/v3/orders/${args.id}`, { method: "PUT", body: JSON.stringify({ status: args.status }) }) as Record<string, unknown>;
          return { id: updated.id, status: updated.status };
        }),
      },
    ];
  },
});

process.env.OTEL_SERVICE_NAME ??= "woocommerce-mcp";
listen(app);
