FROM oven/bun:1.2.19-alpine
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps/mcp-http ./apps/mcp-http
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/woocommerce-mcp/package.json ./apps/woocommerce-mcp/package.json
COPY apps/utility-mcp/package.json ./apps/utility-mcp/package.json
COPY apps/policy-mcp/package.json ./apps/policy-mcp/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN bun install --frozen-lockfile --production
COPY apps/gateway ./apps/gateway
USER bun
EXPOSE 8080 9090
CMD ["bun", "apps/gateway/src/index.ts"]
