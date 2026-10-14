#!/usr/bin/env bash
set -euo pipefail
BASE="${BASE:-http://dashboard.local}"
KEY="${KEY:?set KEY to a umk_ token}"

post() {
  curl -fsS -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -H "mcp-protocol-version: 2025-06-18" -d "$1" "$BASE/mcp"
}

post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"seed-check","version":"0"}}}' >/dev/null
LIST=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
echo "$LIST" | grep -q woocommerce__list_products
echo "$LIST" | grep -q policy__get_return_policy
echo "tools/list ok"

CREATED=$(post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"woocommerce__create_product","arguments":{"name":"Seed Check Mug","regular_price":"9.50"}}}')
echo "$CREATED" | grep -q permalink
echo "create_product ok"

echo "Disable utility in the dashboard, then rerun with EXPECT_DISABLED=1"
if [ "${EXPECT_DISABLED:-}" = "1" ]; then
  echo "$LIST" | grep -q utility__ && { echo "utility tools still listed"; exit 1; }
  echo "utility hidden"
fi

echo "Revoke the key in the dashboard, then rerun with EXPECT_REVOKED=1"
if [ "${EXPECT_REVOKED:-}" = "1" ]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":4,"method":"tools/list"}' "$BASE/mcp")
  [ "$code" = "401" ]
  echo "revoked key rejected"
fi
