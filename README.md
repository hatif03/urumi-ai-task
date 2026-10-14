# Urumi

A WooCommerce store and a team MCP gateway on Kubernetes. One Helm chart runs locally on k3d and, with `values-prod.yaml`, on k3s.

## Local setup

Install Docker, kubectl, Helm, k3d, and Bun. Open a new terminal if Helm or k3d were just installed so they are on `PATH`.

Add to the hosts file:

```text
127.0.0.1 shop.local dashboard.local
```

Then:

```sh
bash scripts/dev-up.sh
```

The script creates the k3d cluster with Traefik disabled, installs ingress-nginx, proves `shop.local` reaches a placeholder, builds the five images, and upgrades the chart to the full release. Generated passwords stay in `deploy/secrets/generated.env`, which is gitignored. The dashboard admin username is `ada`.

Open `http://shop.local` for the storefront and `http://dashboard.local` for the gateway UI. Cash on delivery is enabled. A sample product SKU `urumi-sample` is created by the bootstrap Job.

## Place an order

On `http://shop.local`, add the sample mug to the cart, open checkout as a guest, choose cash on delivery, and place the order. The order is stored in MariaDB and remains after the WordPress pod is deleted.

## Connect Cursor or Inspector

In the dashboard, create an API key and copy the `umk_` token. It is shown once. Point the client at the gateway only:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://dashboard.local/mcp",
      "headers": {
        "Authorization": "Bearer umk_..."
      }
    }
  }
}
```

Tool names look like `woocommerce__list_orders` and `policy__get_return_policy`. Revoking the key makes the next call return 401.

## Chat

The chat page calls the same gateway router as `/mcp`, as the logged-in user, and shows each tool call. If `gateway-llm` has an empty `api-key`, chat returns 503 and `/mcp` keeps working. Set `LLM_API_KEY`, `LLM_PROVIDER` (`openai`, `google`, or `anthropic`), and `LLM_MODEL` before `dev-up.sh`, or update the `gateway-llm` Secret.

## Production

On a k3s node with Traefik disabled and ingress-nginx installed, create the same Secret names with new values. Push the images and set their repositories in `values-prod.yaml`. Install with:

```sh
helm upgrade --install urumi deploy/helm/urumi -n platform -f deploy/helm/urumi/values-prod.yaml
```

The template does not change between environments. Hosts, image repositories, disk size, resource limits, the HPA maximum, and the Secrets do.

## Checks

`bun test` covers the MCP wire protocol, tool prefixing, a slow upstream, a dead upstream, revoked keys, and SSRF. `scripts/seed-check.sh` is the cluster check. Set `KEY` to a live token.

Deleting the Helm release does not delete PVCs. Snapshot them before a WooCommerce plugin upgrade. Database migrations from the plugin are forward-only.
