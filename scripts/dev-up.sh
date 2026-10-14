#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-urumi}"
if ! command -v docker >/dev/null; then echo "docker is required"; exit 1; fi
if ! docker info >/dev/null 2>&1; then echo "start Docker first"; exit 1; fi

if ! k3d cluster list | grep -q "^${CLUSTER} "; then
  k3d cluster create --config deploy/k3d/cluster.yaml
fi

helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.watchIngressWithoutClass=true

mkdir -p deploy/secrets
chmod 700 deploy/secrets
if [ ! -f deploy/secrets/generated.env ]; then
  bun -e '
    const b = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");
    const lines = [
      `DB_PASSWORD=${b(24)}`,
      `DB_ROOT=${b(24)}`,
      `WP_ADMIN_PASSWORD=${b(18)}`,
      `WC_KEY=ck_${b(24)}`,
      `WC_SECRET=cs_${b(24)}`,
      `ADMIN_PASSWORD=${b(18)}`,
      `SESSION=${b(32)}`,
      `CREDENTIAL=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`,
      `PG_PASSWORD=${b(24)}`,
    ];
    await Bun.write("deploy/secrets/generated.env", lines.join("\n") + "\n");
  '
fi
set -a
# shellcheck disable=SC1091
source deploy/secrets/generated.env
set +a

kubectl create namespace store --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace platform --dry-run=client -o yaml | kubectl apply -f -
kubectl -n store create secret generic store-db --from-literal=password="$DB_PASSWORD" --from-literal=root-password="$DB_ROOT" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n store create secret generic store-admin --from-literal=username=admin --from-literal=password="$WP_ADMIN_PASSWORD" --from-literal=email=admin@shop.local --dry-run=client -o yaml | kubectl apply -f -
kubectl -n store create secret generic store-wc-api --from-literal=consumer-key="$WC_KEY" --from-literal=consumer-secret="$WC_SECRET" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n platform create secret generic gateway-bootstrap --from-literal=username=ada --from-literal=password="$ADMIN_PASSWORD" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n platform create secret generic gateway-secrets \
  --from-literal=session-secret="$SESSION" \
  --from-literal=credential-key="$CREDENTIAL" \
  --from-literal=postgres-user=urumi \
  --from-literal=postgres-password="$PG_PASSWORD" \
  --from-literal=database-url="postgres://urumi:${PG_PASSWORD}@postgres.platform.svc.cluster.local:5432/urumi" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n platform create secret generic gateway-llm \
  --from-literal=provider="${LLM_PROVIDER:-openai}" \
  --from-literal=model="${LLM_MODEL:-gpt-4o-mini}" \
  --from-literal=api-key="${LLM_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Proving shop.local reaches the placeholder nginx"
helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-local.yaml --set skeletonOnly=true
kubectl -n store rollout status deploy/skeleton --timeout=180s
curl -fsS -H "Host: shop.local" http://127.0.0.1/ | head -n 5

for image in gateway dashboard woocommerce-mcp utility-mcp policy-mcp; do
  docker build -f "apps/${image}/Dockerfile" -t "urumi-${image}:local" .
  k3d image import "urumi-${image}:local" -c "$CLUSTER"
done

helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-local.yaml
echo "Add these hosts-file lines if curl by name fails: 127.0.0.1 shop.local dashboard.local"
echo "Admin password is in deploy/secrets/generated.env"
