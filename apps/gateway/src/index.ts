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
  allowlist,
  rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60),
});
const app = createGatewayApp(store, router, {
  sessionSecret,
  credentialKey,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  allowlist,
});

process.env.OTEL_SERVICE_NAME ??= "gateway";
listen(app);
setInterval(() => {
  router.probeOwned().catch((error) => log("error", "probe failed", { error: error instanceof Error ? error.message : "probe failed" }));
}, 15_000);
log("info", "gateway started");
