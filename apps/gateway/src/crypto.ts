import { timingSafeEqual } from "node:crypto";

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

export function createApiToken(): { token: string; prefix: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `umk_${bytesToBase64Url(bytes)}`;
  return { token, prefix: token.slice(0, 12) };
}

async function aesKey(encoded: string): Promise<CryptoKey> {
  const raw = base64ToBytes(encoded);
  if (raw.byteLength !== 32) throw new Error("CREDENTIAL_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  const key = await aesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  const tag = cipher.slice(cipher.length - 16);
  const data = cipher.slice(0, cipher.length - 16);
  return JSON.stringify({
    iv: Buffer.from(iv).toString("base64"),
    tag: Buffer.from(tag).toString("base64"),
    ciphertext: Buffer.from(data).toString("base64"),
  });
}

// Rotation: set CREDENTIAL_KEY to the new key and CREDENTIAL_KEY_PREVIOUS to the old one, deploy, run
// `bun apps/gateway/src/rekey.ts` to re-encrypt every stored credential, then remove the old key. AES-GCM
// authenticates, so decrypting with the wrong key fails loudly instead of returning garbage.
export async function decryptSecret(payload: string, keyB64: string, previousKeyB64?: string): Promise<string> {
  try {
    return await decryptWith(payload, keyB64);
  } catch (error) {
    if (!previousKeyB64) throw error;
    return decryptWith(payload, previousKeyB64);
  }
}

async function decryptWith(payload: string, keyB64: string): Promise<string> {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; ciphertext: string };
  const key = await aesKey(keyB64);
  const iv = base64ToBytes(parsed.iv);
  const data = base64ToBytes(parsed.ciphertext);
  const tag = base64ToBytes(parsed.tag);
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(plain);
}

type SessionPayload = { uid: string; role: "admin" | "member"; exp: number };

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

export async function readSession(token: string, secret: string): Promise<SessionPayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = await hmac(body, secret);
  if (!safeEqual(signature, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
  if (payload.exp < Date.now()) return null;
  return payload;
}

export async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(signature).toString("base64url");
}
