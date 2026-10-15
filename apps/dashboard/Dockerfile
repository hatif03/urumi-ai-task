FROM oven/bun:1.4.3-alpine AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps/mcp-http/package.json ./apps/mcp-http/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/woocommerce-mcp/package.json ./apps/woocommerce-mcp/package.json
COPY apps/utility-mcp/package.json ./apps/utility-mcp/package.json
COPY apps/policy-mcp/package.json ./apps/policy-mcp/package.json
COPY apps/provisioner/package.json ./apps/provisioner/package.json
COPY apps/dashboard ./apps/dashboard
RUN bun install --frozen-lockfile
WORKDIR /app/apps/dashboard
RUN bun run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
