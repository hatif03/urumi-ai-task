import { AsyncLocalStorage } from "node:async_hooks";

// The span a piece of code is running in. childSpan() sets it for the function it runs, so a fetch made
// deep inside (to an upstream MCP server, to WooCommerce) can send `traceparent` without every function
// in between passing it along.
const current = new AsyncLocalStorage<TraceContext>();
export const currentTrace = (): TraceContext | undefined => current.getStore();
export const withTrace = <T>(context: TraceContext, fn: () => T): T => current.run(context, fn);

export type TraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceparent: string;
};

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseTraceparent(header: string | null): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(header.trim());
  if (!match) return null;
  return { traceId: match[1]!.toLowerCase(), spanId: match[2]!.toLowerCase() };
}

export function traceFromHeaders(headers: Headers): TraceContext {
  const incoming = parseTraceparent(headers.get("traceparent"));
  const traceId = incoming?.traceId ?? hex(16);
  const spanId = hex(8);
  return {
    traceId,
    spanId,
    parentSpanId: incoming?.spanId,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

export async function childSpan<T>(
  parent: TraceContext,
  name: string,
  attributes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const spanId = hex(8);
  const started = Date.now();
  const child: TraceContext = { traceId: parent.traceId, spanId, parentSpanId: parent.spanId, traceparent: `00-${parent.traceId}-${spanId}-01` };
  try {
    const result = await current.run(child, fn);
    void exportSpan(parent.traceId, spanId, parent.spanId, name, started, Date.now(), attributes, "ok");
    return result;
  } catch (error) {
    void exportSpan(parent.traceId, spanId, parent.spanId, name, started, Date.now(), attributes, "error");
    throw error;
  }
}

type PendingSpan = { traceId: string; spanId: string; parentSpanId: string; name: string; startMs: number; endMs: number; attributes: Record<string, string>; status: "ok" | "error" };

// Spans are queued and sent as one OTLP request a second (or when 100 are waiting). One HTTP request per span
// cost more CPU than the tool call it described: see docs/experiments/0006-span-export-cost.md.
let queue: PendingSpan[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

async function exportSpan(
  traceId: string,
  spanId: string,
  parentSpanId: string,
  name: string,
  startMs: number,
  endMs: number,
  attributes: Record<string, string>,
  status: "ok" | "error",
): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  if (queue.length >= 1000) return; // the collector is down; drop rather than grow without bound
  queue.push({ traceId, spanId, parentSpanId, name, startMs, endMs, attributes, status });
  if (queue.length >= 100) void flush();
  else timer ??= setTimeout(() => void flush(), 1000);
}

export async function flush(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const batch = queue;
  queue = [];
  if (!endpoint || !batch.length) return;
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: process.env.OTEL_SERVICE_NAME ?? "urumi" } }] },
        scopeSpans: [
          {
            spans: batch.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              startTimeUnixNano: String(span.startMs * 1_000_000),
              endTimeUnixNano: String(span.endMs * 1_000_000),
              attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
              status: { code: span.status === "ok" ? 1 : 2 },
            })),
          },
        ],
      },
    ],
  };
  try {
    await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // Tracing must not fail the request.
  }
}
