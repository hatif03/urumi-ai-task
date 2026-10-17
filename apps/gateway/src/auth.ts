import type { Context } from "hono";
import { readSession, safeEqual, sha256Hex } from "./crypto.ts";
import type { Store } from "./store.ts";
import type { Actor, Role, User } from "./types.ts";

export type GatewayEnv = {
  sessionSecret: string;
  credentialKey: string;
  cookieSecure: boolean;
  allowlist: string[];
  // Extra browser origins allowed to call /api and /mcp (the request's own host is always allowed).
  allowedOrigins?: string[];
  // Shared secret for service-to-service calls from the provisioner (see routes/internal.ts).
  internalToken?: string;
  // Where the provisioner listens and the shared token for it. Unset means stores and hosted servers are off.
  provisionerUrl?: string;
  provisionerToken?: string;
  publicBaseUrl?: string;
};

export const SESSION_COOKIE = "urumi_session";
export const SESSION_SECONDS = 60 * 60 * 12;

export type McpCaller = { userId: string; role: Role; apiKeyId: string | null; oauthTokenId?: string | null; actor: Actor; lastUsedAt?: string | null };

export async function userFromCookie(request: Request, store: Store, env: GatewayEnv): Promise<User | null> {
  const header = request.headers.get("cookie") ?? "";
  const token = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return null;
  const session = await readSession(decodeURIComponent(token), env.sessionSecret);
  if (!session) return null;
  const user = await store.getUser(session.uid);
  if (!user || user.disabledAt) return null;
  return user;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

// Member API keys. The token is "umk_" + 32 random bytes; the database holds the first 12 characters
// (to find the row) and the SHA-256 of the whole token (to check it). Comparison is constant time.
export async function callerFromApiKey(token: string, store: Store): Promise<McpCaller | null> {
  if (!token.startsWith("umk_")) return null;
  const key = await store.findLiveKeyByPrefix(token.slice(0, 12));
  if (!key || !safeEqual(key.keyHash, await sha256Hex(token))) return null;
  const user = await store.getUser(key.userId);
  if (!user || user.disabledAt) return null;
  return { userId: user.id, role: user.role, apiKeyId: key.id, actor: "mcp", lastUsedAt: key.lastUsedAt };
}

export function clientIp(request: Request): string {
  // ingress-nginx overwrites X-Real-IP with the connection's address, so a client cannot set it.
  return request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// Browsers send Origin on cross-site requests. A page on another origin must not drive the API with
// the admin's cookie, and must not talk to /mcp from a victim's machine (DNS rebinding).
export function originAllowed(request: Request, env: GatewayEnv): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  return host === own || (env.allowedOrigins ?? []).includes(origin);
}

export function publicBase(c: Context | Request, env: GatewayEnv): string {
  if (env.publicBaseUrl) return env.publicBaseUrl.replace(/\/$/, "");
  const request = c instanceof Request ? c : c.req.raw;
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  return `${proto}://${host}`;
}
