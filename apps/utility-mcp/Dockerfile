FROM oven/bun:1.2.19-alpine
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps/mcp-http ./apps/mcp-http
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/woocommerce-mcp/package.json ./apps/woocommerce-mcp/package.json
COPY apps/utility-mcp ./apps/utility-mcp
COPY apps/policy-mcp/package.json ./apps/policy-mcp/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN bun install --frozen-lockfile --production
USER bun
EXPOSE 8080 9090
CMD ["bun", "apps/utility-mcp/src/index.ts"]
