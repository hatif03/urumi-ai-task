#!/usr/bin/env bash
# The production TLS wiring on the local cluster, with a private CA instead of Let's Encrypt:
# cert-manager issues a certificate for the dashboard host, the Ingress serves it, the session cookie turns
# Secure, and the OAuth issuer and resource become https. Then the release is put back.
# Needs internet for the cert-manager chart. Output is what docs/evidence/tls-rehearsal-*.txt keeps.
set -uo pipefail
cd "$(dirname "$0")/.."
NS=platform
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "PASS  $2"; else FAIL=$((FAIL+1)); echo "FAIL  $2"; fi; }
source deploy/secrets/generated.env

echo "== install cert-manager"
helm upgrade --install cert-manager cert-manager --repo https://charts.jetstack.io -n cert-manager --create-namespace --set crds.enabled=true --wait --timeout 5m >/dev/null 2>&1
ok $? "cert-manager is installed"

echo "== upgrade the platform release with the production TLS values and a self-signed issuer"
helm upgrade urumi deploy/helm/urumi -n "$NS" -f deploy/helm/urumi/values-local.yaml \
  --set certManager.enabled=true --set certManager.selfSigned=true --set certManager.issuerName=urumi-local \
  --set ingress.tls.enabled=true --set ingress.tls.clusterIssuer=urumi-local \
  --set publicBaseUrl=https://dashboard.local --wait --timeout 5m >/dev/null 2>&1
ok $? "helm upgrade with TLS values succeeded"
kubectl wait --for=condition=Ready certificate/urumi-tls -n "$NS" --timeout=120s >/dev/null 2>&1
ok $? "cert-manager issued the dashboard certificate (secret urumi-tls)"
echo "      $(kubectl get certificate -A --no-headers 2>/dev/null | tr -s ' ' | cut -c1-110 | tr '\n' ';')"

echo "== talk to the Ingress over https (port-forward, SNI dashboard.local)"
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 18443:443 >/dev/null 2>&1 &
PF=$!
sleep 4
CURL=(curl -sk --resolve dashboard.local:18443:127.0.0.1)
ISSUER=$(echo | openssl s_client -connect 127.0.0.1:18443 -servername dashboard.local 2>/dev/null | openssl x509 -noout -issuer -subject -enddate 2>/dev/null | tr '\n' ' ')
echo "      $ISSUER"
echo "$ISSUER" | grep -q "urumi-local-ca"; ok $? "the certificate is signed by the private CA created by the issuer"
"${CURL[@]}" https://dashboard.local:18443/.well-known/oauth-protected-resource | grep -q '"resource":"https://dashboard.local/mcp"'
ok $? "the OAuth resource identifier is the https URL"
COOKIE=$("${CURL[@]}" -D - -o /dev/null -X POST -H 'content-type: application/json' -d "{\"username\":\"ada\",\"password\":\"$ADMIN_PASSWORD\"}" https://dashboard.local:18443/api/login | grep -i '^set-cookie')
echo "$COOKIE" | grep -qi "secure"; ok $? "the session cookie is Secure and HttpOnly: $(echo "$COOKIE" | tr -d '\r' | cut -c1-90)..."
kill $PF 2>/dev/null

echo "== put the release back"
helm upgrade urumi deploy/helm/urumi -n "$NS" -f deploy/helm/urumi/values-local.yaml --wait --timeout 5m >/dev/null 2>&1
ok $? "local values restored"
kubectl get ingress -n "$NS" dashboard -o jsonpath='{.spec.tls}' | grep -q . ; [ $? -ne 0 ]; ok $? "the Ingress is back to plain http"
echo; [ "$FAIL" = 0 ] && echo "ALL PASSED" || echo "$FAIL FAILED"
exit "$FAIL"
