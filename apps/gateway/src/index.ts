import { listen } from "@urumi/mcp-http";
import { log } from "@urumi/obs";
import { createGatewayApp } from "./app.ts";
import { createPostgresStore } from "./postgres.ts";
import { ToolRouter } from "./router.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sessionSecret = process.env.SESSION_SECRET;
const credentialKey = process.env.CREDENTIAL_KEY;
if (!sessionSecret || !credentialKey) throw new Error("SESSION_SECRET and CREDENTIAL_KEY are required");

const store = createPostgresStore(databaseUrl);
const allowlist = (process.env.UPSTREAM_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const router = new ToolRouter(store, {
  credentialKey,
  credentialKeyPrevious: process.env.CREDENTIAL_KEY_PREVIOUS || undefined,
  allowlist,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
  maxResultBytes: Number(process.env.MAX_RESULT_BYTES ?? 1_000_000),
  maxInflight: Number(process.env.MAX_INFLIGHT_CALLS ?? 24),
});
const app = createGatewayApp(store, router, {
  sessionSecret,
  credentialKey,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  allowlist,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  internalToken: process.env.INTERNAL_TOKEN,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  provisionerUrl: process.env.PROVISIONER_URL,
  provisionerToken: process.env.PROVISIONER_TOKEN,
});

process.env.OTEL_SERVICE_NAME ??= "gateway";
listen(app);
setInterval(() => {
  router.probeOwned().catch((error) => log("error", "probe failed", { error: error instanceof Error ? error.message : "probe failed" }));
}, 15_000);
log("info", "gateway started");
