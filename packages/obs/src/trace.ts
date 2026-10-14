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
  try {
    const result = await fn();
    void exportSpan(parent.traceId, spanId, parent.spanId, name, started, Date.now(), attributes, "ok");
    return result;
  } catch (error) {
    void exportSpan(parent.traceId, spanId, parent.spanId, name, started, Date.now(), attributes, "error");
    throw error;
  }
}

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
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: process.env.OTEL_SERVICE_NAME ?? "urumi" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                parentSpanId,
                name,
                startTimeUnixNano: String(startMs * 1_000_000),
                endTimeUnixNano: String(endMs * 1_000_000),
                attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
                status: { code: status === "ok" ? 1 : 2 },
              },
            ],
          },
        ],
      },
    ],
  };
  try {
    await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Tracing must not fail the request.
  }
}
