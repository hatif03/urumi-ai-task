export type LogFields = Record<string, unknown>;

const REDACTED_KEYS = new Set(["authorization", "cookie", "x-api-key", "password", "consumer_secret", "credential"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(inner);
    }
    return out;
  }
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(redact(fields) as LogFields),
  };
  console.log(JSON.stringify(line));
}
