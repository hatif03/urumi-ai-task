#!/usr/bin/env bash
# Upgrade to a gateway image that dies on start, with --atomic, and show that
#   1. Helm reverts the release by itself,
#   2. the old pods keep serving the whole time (rolling update with maxUnavailable 0),
#   3. the audit log is untouched,
#   4. helm test passes afterwards.
# Local cluster only. Output is what docs/evidence/rollback-*.txt keeps.
set -uo pipefail
cd "$(dirname "$0")/.."
CLUSTER="${CLUSTER:-urumi}"
NS=platform
pg() { kubectl -n "$NS" exec deploy/postgres -- psql -U urumi -d urumi -At -c "$1"; }
revision() { helm history urumi -n "$NS" -o json | bun -e 'const h=JSON.parse(await Bun.stdin.text());console.log(h.at(-1).revision+" "+h.at(-1).status)'; }

echo "== before"
helm history urumi -n "$NS" | tail -3
echo "audit rows: $(pg 'select count(*) from audit_log')"
echo "gateway image: $(kubectl -n $NS get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].image}')"

echo "== build a release that cannot start"
printf 'FROM urumi-gateway:local\nCMD ["bun","-e","console.error(\\"simulated bad release\\"); process.exit(1)"]\n' | docker build -q -t urumi-gateway:broken -
k3d image import urumi-gateway:broken -c "$CLUSTER" >/dev/null

echo "== probe /mcp every second while the upgrade runs"
( ok=0; bad=0; for _ in $(seq 1 150); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'Host: dashboard.local' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' http://127.0.0.1/mcp)
    # 401 is the gateway answering an unauthenticated ping: the service is up
    if [ "$code" = "401" ] || [ "$code" = "200" ]; then ok=$((ok+1)); else bad=$((bad+1)); fi; sleep 1
  done; echo "probe: $ok answers from the gateway, $bad failures or timeouts" > /tmp/rollback-probe.txt ) &
PROBE=$!

echo "== helm upgrade --atomic to the broken image (expected to fail and roll back)"
helm upgrade urumi deploy/helm/urumi -n "$NS" -f deploy/helm/urumi/values-local.yaml \
  --set images.gateway.repository=urumi-gateway --set images.gateway.tag=broken \
  --atomic --wait --timeout 150s
echo "helm exit code: $?"
wait "$PROBE"; cat /tmp/rollback-probe.txt

echo "== after"
helm history urumi -n "$NS" | tail -4
echo "gateway image: $(kubectl -n $NS get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].image}')"
kubectl -n "$NS" get pods -l app=gateway
echo "audit rows: $(pg 'select count(*) from audit_log')"
helm test urumi -n "$NS" 2>&1 | grep -E "Phase|NAME:"
docker rmi -f urumi-gateway:broken >/dev/null 2>&1 || true
