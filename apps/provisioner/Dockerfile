# Build context is the repository root.
FROM alpine:3.20 AS helm
ARG HELM_VERSION=v3.18.6
ARG TARGETARCH=amd64
RUN apk add --no-cache curl \
 && curl -fsSLo /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && curl -fsSLo /tmp/helm.sha "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz.sha256sum" \
 && cd /tmp && sed "s#helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz#helm.tgz#" helm.sha | sha256sum -c - \
 && tar -xzf helm.tgz && mv linux-${TARGETARCH}/helm /helm

FROM oven/bun:1.4.3-alpine
WORKDIR /app
COPY --from=helm /helm /usr/local/bin/helm
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY packages ./packages
COPY apps/mcp-http/package.json ./apps/mcp-http/package.json
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/woocommerce-mcp/package.json ./apps/woocommerce-mcp/package.json
COPY apps/utility-mcp/package.json ./apps/utility-mcp/package.json
COPY apps/policy-mcp/package.json ./apps/policy-mcp/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/provisioner/package.json ./apps/provisioner/package.json
RUN bun install --frozen-lockfile --production
COPY apps/provisioner ./apps/provisioner
# The charts the provisioner installs travel inside the image, so a store install needs no network.
COPY deploy/helm/urumi-store /charts/urumi-store
COPY deploy/helm/urumi-hosted-mcp /charts/urumi-hosted-mcp
USER bun
EXPOSE 8080 9090
CMD ["bun", "apps/provisioner/src/index.ts"]
