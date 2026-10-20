#!/usr/bin/env bash
# Shared by dev-up.sh and vps-bootstrap.sh. Generates every secret once, keeps it in an env file with mode
# 600, and creates the Kubernetes Secrets the chart references by name. Secrets never appear in a values file.
# Rotating DB_PASSWORD or CREDENTIAL by editing the file would orphan existing data: see the runbook.

gen() { bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array($1))).toString('$2'))"; }

# urumi_generate_secrets <env-file>: fills in only the keys that are missing.
urumi_generate_secrets() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  chmod 600 "$file"
  ensure() { grep -q "^$1=" "$file" || echo "$1=$2" >> "$file"; }
  ensure DB_PASSWORD "$(gen 24 base64url)"
  ensure DB_ROOT "$(gen 24 base64url)"
  ensure WP_ADMIN_PASSWORD "$(gen 18 base64url)"
  ensure WC_KEY "ck_$(gen 24 base64url)"
  ensure WC_SECRET "cs_$(gen 24 base64url)"
  ensure ADMIN_PASSWORD "$(gen 18 base64url)"
  ensure SESSION "$(gen 32 base64url)"
  ensure CREDENTIAL "$(gen 32 base64)"
  ensure PG_PASSWORD "$(gen 24 base64url)"
  ensure INTERNAL_TOKEN "$(gen 32 base64url)"
  ensure PROVISIONER_TOKEN "$(gen 32 base64url)"
}

# urumi_apply_secrets <env-file> <store-admin-email>: creates or updates the Secrets (idempotent).
urumi_apply_secrets() {
  local file="$1" email="${2:-admin@shop.local}"
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
  local apply="kubectl apply -f -"
  kubectl create namespace store --dry-run=client -o yaml | $apply
  kubectl create namespace platform --dry-run=client -o yaml | $apply
  kubectl -n store create secret generic store-db --from-literal=password="$DB_PASSWORD" --from-literal=root-password="$DB_ROOT" --dry-run=client -o yaml | $apply
  kubectl -n store create secret generic store-admin --from-literal=username=admin --from-literal=password="$WP_ADMIN_PASSWORD" --from-literal=email="$email" --dry-run=client -o yaml | $apply
  kubectl -n store create secret generic store-wc-api --from-literal=consumer-key="$WC_KEY" --from-literal=consumer-secret="$WC_SECRET" --dry-run=client -o yaml | $apply
  kubectl -n platform create secret generic gateway-bootstrap --from-literal=username="${ADMIN_USERNAME:-ada}" --from-literal=password="$ADMIN_PASSWORD" --dry-run=client -o yaml | $apply
  kubectl -n platform create secret generic gateway-secrets \
    --from-literal=session-secret="$SESSION" \
    --from-literal=credential-key="$CREDENTIAL" \
    --from-literal=internal-token="$INTERNAL_TOKEN" \
    --from-literal=provisioner-token="$PROVISIONER_TOKEN" \
    --from-literal=postgres-user=urumi \
    --from-literal=postgres-password="$PG_PASSWORD" \
    --from-literal=database-url="postgres://urumi:${PG_PASSWORD}@postgres.platform.svc.cluster.local:5432/urumi" \
    ${CREDENTIAL_PREVIOUS:+--from-literal=credential-key-previous="$CREDENTIAL_PREVIOUS"} \
    --dry-run=client -o yaml | $apply
  kubectl -n platform create secret generic gateway-llm \
    --from-literal=provider="${LLM_PROVIDER:-openai}" \
    --from-literal=model="${LLM_MODEL:-gpt-4o-mini}" \
    --from-literal=api-key="${LLM_API_KEY:-}" \
    --dry-run=client -o yaml | $apply
}
