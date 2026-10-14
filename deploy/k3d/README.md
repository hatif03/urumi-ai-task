# Local cluster

Traefik is disabled in `cluster.yaml`. Install ingress-nginx after the cluster exists, before the chart:

```sh
helm upgrade --install ingress-nginx ingress-nginx \
  --repo https://kubernetes.github.io/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.watchIngressWithoutClass=true
```

k3d publishes port 80 on the load balancer. Add `127.0.0.1 shop.local dashboard.local` to the hosts file. `scripts/dev-up.sh` does this sequence.

With `--set skeletonOnly=true` the chart routes `shop.local` to a placeholder nginx so the ingress path can be checked before WordPress is installed.
