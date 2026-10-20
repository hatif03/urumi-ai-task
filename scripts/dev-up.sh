#!/usr/bin/env bash
# Brings up (or upgrades) the whole platform on a local k3d cluster. Safe to rerun.
#   SKIP_BUILD=1       reuse the images already imported into the cluster
#   ONLY=gateway,...   rebuild just these images (gateway dashboard provisioner woocommerce-mcp utility-mcp policy-mcp)
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-urumi}"
if ! command -v docker >/dev/null; then echo "docker is required"; exit 1; fi
if ! docker info >/dev/null 2>&1; then echo "start Docker first"; exit 1; fi

if ! k3d cluster list | grep -q "^${CLUSTER} "; then
  k3d cluster create --config deploy/k3d/cluster.yaml
fi
# Some Docker Desktop setups publish the API on an address the host cannot reach; the loopback port always works.
PORT="$(docker port "k3d-${CLUSTER}-serverlb" 6443/tcp | head -n1 | sed 's/.*://')"
kubectl config set-cluster "k3d-${CLUSTER}" --server="https://127.0.0.1:${PORT}" >/dev/null

helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.watchIngressWithoutClass=true

mkdir -p deploy/secrets
chmod 700 deploy/secrets
touch deploy/secrets/generated.env
gen() { bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array($2))).toString('$3'))"; }
# Each value is generated once and kept: rotating DB_PASSWORD or CREDENTIAL would orphan existing data.
ensure() { grep -q "^$1=" deploy/secrets/generated.env || echo "$1=$2" >> deploy/secrets/generated.env; }
ensure DB_PASSWORD "$(gen x 24 base64url)"
ensure DB_ROOT "$(gen x 24 base64url)"
ensure WP_ADMIN_PASSWORD "$(gen x 18 base64url)"
ensure WC_KEY "ck_$(gen x 24 base64url)"
ensure WC_SECRET "cs_$(gen x 24 base64url)"
ensure ADMIN_PASSWORD "$(gen x 18 base64url)"
ensure SESSION "$(gen x 32 base64url)"
ensure CREDENTIAL "$(gen x 32 base64)"
ensure PG_PASSWORD "$(gen x 24 base64url)"
ensure INTERNAL_TOKEN "$(gen x 32 base64url)"
ensure PROVISIONER_TOKEN "$(gen x 32 base64url)"
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
  --from-literal=internal-token="$INTERNAL_TOKEN" \
  --from-literal=provisioner-token="$PROVISIONER_TOKEN" \
  --from-literal=postgres-user=urumi \
  --from-literal=postgres-password="$PG_PASSWORD" \
  --from-literal=database-url="postgres://urumi:${PG_PASSWORD}@postgres.platform.svc.cluster.local:5432/urumi" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n platform create secret generic gateway-llm \
  --from-literal=provider="${LLM_PROVIDER:-openai}" \
  --from-literal=model="${LLM_MODEL:-gpt-4o-mini}" \
  --from-literal=api-key="${LLM_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

if ! kubectl -n store get deploy skeleton >/dev/null 2>&1 && ! kubectl -n store get deploy wordpress >/dev/null 2>&1; then
  echo "Proving shop.local reaches the placeholder nginx"
  helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-local.yaml --set skeletonOnly=true
  kubectl -n store rollout status deploy/skeleton --timeout=180s
  curl -fsS -H "Host: shop.local" http://127.0.0.1/ | head -n 5
fi

IMAGES="${ONLY:-gateway dashboard provisioner woocommerce-mcp utility-mcp policy-mcp}"
IMAGES="${IMAGES//,/ }"
if [ -z "${SKIP_BUILD:-}" ]; then
  for image in $IMAGES; do
    docker build -f "apps/${image}/Dockerfile" -t "urumi-${image}:local" .
    k3d image import "urumi-${image}:local" -c "$CLUSTER"
  done
fi

# Helm 4 applies server-side and refuses fields another manager owns (HPA owns replicas, kubectl owns the restart
# annotation). The chart is the source of truth here, so it wins the conflict.
FORCE=""; helm upgrade --help 2>/dev/null | grep -q -- "--force-conflicts" && FORCE="--force-conflicts"
helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-local.yaml --set-string gateway.llmBaseUrl="${LLM_BASE_URL:-}" $FORCE

# The tag is always "local", so a rebuilt image is only picked up when its pods restart.
if [ -z "${SKIP_BUILD:-}" ]; then
  for image in $IMAGES; do
    ns=platform; [ "$image" = "woocommerce-mcp" ] && ns=store
    kubectl -n "$ns" get deploy "$image" >/dev/null 2>&1 && kubectl -n "$ns" rollout restart "deploy/$image" >/dev/null
  done
fi
echo "Hosts file lines (or rely on *.localhost for stores): 127.0.0.1 shop.local dashboard.local"
echo "Admin password is in deploy/secrets/generated.env (ADMIN_PASSWORD), user: ada"
