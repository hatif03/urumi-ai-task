#!/bin/sh
set -eu
cd /var/www/html
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if wp core version --allow-root >/dev/null 2>&1; then
    break
  fi
  sleep 10
done
if ! wp core is-installed --allow-root; then
  wp core install --allow-root \
    --url="$WP_URL" \
    --title="${STORE_NAME:-Urumi} Shop" \
    --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email
fi
wp rewrite structure '/%postname%/' --allow-root
wp rewrite flush --allow-root
if ! wp plugin is-installed woocommerce --allow-root; then
  wp plugin install woocommerce --activate --allow-root
fi
wp plugin is-active woocommerce --allow-root || wp plugin activate woocommerce --allow-root
mkdir -p /var/www/html/wp-content/mu-plugins
cat > /var/www/html/wp-content/mu-plugins/urumi-http-basic.php <<'PHP'
<?php
/**
 * Plugin Name: Urumi HTTP basic auth
 * WooCommerce accepts consumer-key basic auth only when the request looks like HTTPS.
 * The chart marks /wp-json/wc/ as HTTPS for that check. If the public site URL is http,
 * drop that flag after authentication so product permalinks stay on the public scheme.
 */
add_filter('determine_current_user', function ($user_id) {
    if (defined('WP_HOME') && str_starts_with(WP_HOME, 'http://')) {
        unset($_SERVER['HTTPS']);
    }
    return $user_id;
}, 100);
PHP
wp eval-file /bootstrap/setup.php --allow-root
# Alpine CLI www-data is uid 82. The Apache image owns the tree as Debian www-data (33).
chown -R 33:33 /var/www/html/wp-content
echo "bootstrap complete"
