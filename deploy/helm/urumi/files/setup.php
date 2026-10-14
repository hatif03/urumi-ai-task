<?php
if (!get_option('urumi_bootstrapped')) {
    update_option('woocommerce_coming_soon', 'no');
    update_option('woocommerce_store_pages_only', 'no');
    update_option('woocommerce_enable_guest_checkout', 'yes');
    update_option('woocommerce_enable_signup_and_login_from_checkout', 'no');
    update_option('woocommerce_currency', 'USD');
    update_option('woocommerce_cod_settings', array(
        'enabled' => 'yes',
        'title' => 'Cash on delivery',
        'description' => 'Pay with cash when the order arrives.',
        'instructions' => '',
        'enable_for_methods' => '',
        'enable_for_virtual' => 'yes',
    ));
    update_option('woocommerce_ship_to_countries', 'all');
}

$zone = new WC_Shipping_Zone();
$existing = WC_Shipping_Zones::get_zones();
$found = false;
foreach ($existing as $item) {
    if (($item['zone_name'] ?? '') === 'Everywhere') {
        $found = true;
    }
}
if (!$found) {
    $zone->set_zone_name('Everywhere');
    $zone->set_zone_order(1);
    $zone->save();
    $zone->add_shipping_method('flat_rate');
    $methods = $zone->get_shipping_methods();
    foreach ($methods as $method) {
        if ($method->id === 'flat_rate') {
            $method->update_option('cost', '0');
            $method->update_option('title', 'Flat rate');
        }
    }
}

global $wpdb;
$description = 'urumi-mcp';
$table = $wpdb->prefix . 'woocommerce_api_keys';
$exists = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM {$table} WHERE description = %s", $description));
if (!$exists) {
    $key = getenv('WC_CONSUMER_KEY');
    $secret = getenv('WC_CONSUMER_SECRET');
    $wpdb->insert($table, array(
        'user_id' => 1,
        'description' => $description,
        'permissions' => 'read_write',
        'consumer_key' => function_exists('wc_api_hash') ? wc_api_hash($key) : hash('sha256', $key),
        'consumer_secret' => $secret,
        'truncated_key' => substr($key, -7),
    ));
}

if (!wc_get_product_id_by_sku('urumi-sample')) {
    $product = new WC_Product_Simple();
    $product->set_name('Urumi Sample Mug');
    $product->set_regular_price('12.00');
    $product->set_sku('urumi-sample');
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->set_manage_stock(false);
    $product->save();
}

foreach (array('shop', 'cart', 'checkout', 'myaccount') as $page) {
    if (function_exists('wc_get_page_id') && wc_get_page_id($page) <= 0 && function_exists('wc_create_page')) {
        // WooCommerce creates these on activation. Leave them if they already exist.
    }
}
update_option('urumi_bootstrapped', 'yes');
echo "woocommerce configured\n";
