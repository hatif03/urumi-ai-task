import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production nginx serves this bundle and Ingress sends /api, /mcp, /oauth and /.well-known to the
// gateway. The dev server mirrors that so the same relative URLs work.
const gateway = process.env.GATEWAY_URL ?? "http://127.0.0.1:8080";

// xfwd adds X-Forwarded-Host so the gateway's same-origin check sees the browser's host, as it does
// behind ingress-nginx.
const proxied = { target: gateway, xfwd: true };

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": proxied, "/mcp": proxied, "/oauth": proxied, "/.well-known": proxied } },
});
