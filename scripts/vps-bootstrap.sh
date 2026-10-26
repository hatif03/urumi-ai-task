#!/usr/bin/env bash
# Turns one fresh Ubuntu VPS into a running Urumi: k3s, ingress-nginx, cert-manager, the Secrets, the chart.
# Run as root on the VPS, from a checkout of this repository:
#
#   DOMAIN=example.com EMAIL=ops@example.com REGISTRY=ghcr.io/you TAG=1.0.0 bash scripts/vps-bootstrap.sh
#
# Before you run it:
#   * DNS A records pointing at the VPS: dashboard.$DOMAIN, shop.$DOMAIN and *.stores.$DOMAIN
#   * the six images pushed to $REGISTRY as urumi-<name>:$TAG (see docs/vps-deploy.md)
#   * ports 80 and 443 open (Let's Encrypt HTTP-01 needs 80)
# It is safe to rerun: every step is `install if missing` or `helm upgrade --install`.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DOMAIN:?set DOMAIN, e.g. example.com}"
: "${EMAIL:?set EMAIL for the certificate issuer}"
: "${REGISTRY:?set REGISTRY, e.g. ghcr.io/you}"
: "${TAG:?set TAG, e.g. 1.0.0 (never latest: a rollback must restore the image that ran)}"
SECRETS_FILE="${SECRETS_FILE:-/root/urumi-secrets.env}"
ISSUER="${ISSUER:-letsencrypt}"
HELM_EXTRA="${HELM_EXTRA:-}"

if ! command -v k3s >/dev/null; then
  # Traefik is disabled: ingress-nginx is the ingress on both clusters (ADR 0005).
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik --write-kubeconfig-mode 644" sh -
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl wait --for=condition=Ready node --all --timeout=180s

command -v helm >/dev/null || curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
command -v unzip >/dev/null || { apt-get update -qq && apt-get install -y -qq unzip; }
if ! command -v bun >/dev/null; then curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; fi

helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx \
  -n ingress-nginx --create-namespace --set controller.watchIngressWithoutClass=true --wait
helm upgrade --install cert-manager cert-manager --repo https://charts.jetstack.io \
  -n cert-manager --create-namespace --set crds.enabled=true --wait

# shellcheck disable=SC1091
source scripts/lib/secrets.sh
urumi_generate_secrets "$SECRETS_FILE"
urumi_apply_secrets "$SECRETS_FILE" "admin@shop.${DOMAIN}"
# The Secrets script creates the namespaces first; Helm 3 only adopts a namespace that carries its ownership metadata.
for ns in platform store; do
  kubectl label ns "$ns" app.kubernetes.io/managed-by=Helm --overwrite
  kubectl annotate ns "$ns" meta.helm.sh/release-name=urumi meta.helm.sh/release-namespace=platform --overwrite
done
echo "Secrets are in $SECRETS_FILE (mode 600). Back it up: losing CREDENTIAL makes stored upstream credentials unreadable."

images=()
for name in gateway dashboard provisioner woocommerce-mcp utility-mcp policy-mcp; do
  key="${name//-mcp/Mcp}"
  key="$(echo "${key:0:1}" | tr '[:upper:]' '[:lower:]')${key:1}"
  images+=(--set "images.${key}.repository=${REGISTRY}/urumi-${name}" --set "images.${key}.tag=${TAG}" --set "images.${key}.pullPolicy=IfNotPresent")
done

# Everything below is the complete list of values that differ from the local install. See docs/vps-deploy.md.
# shellcheck disable=SC2086
helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-prod.yaml \
  --atomic --wait --timeout 15m \
  --set ingress.dashboardHost="dashboard.${DOMAIN}" \
  --set ingress.shopHost="shop.${DOMAIN}" \
  --set wordpress.url="https://shop.${DOMAIN}" \
  --set publicBaseUrl="https://dashboard.${DOMAIN}" \
  --set provisioner.storesDomain="stores.${DOMAIN}" \
  --set provisioner.hostedRegistries="${REGISTRY}/" \
  --set certManager.issuerName="${ISSUER}" \
  --set ingress.tls.clusterIssuer="${ISSUER}" \
  --set certManager.acmeEmail="${EMAIL}" \
  "${images[@]}" ${HELM_EXTRA}

helm test urumi -n platform
echo
echo "Dashboard: https://dashboard.${DOMAIN}   user: ada   password: $(grep '^ADMIN_PASSWORD=' "$SECRETS_FILE" | cut -d= -f2)"
