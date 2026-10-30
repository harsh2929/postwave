// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"encoding/json"
	"testing"
)

// Adobe Commerce now materialises a stock-bearing variant from the Magento
// stock_item, so inventory drives availability and back-in-stock can fire on
// restock — the same capability the other commerce platforms already have, and
// one more genuine back-in-stock platform than Klaviyo's e-commerce set.
func TestAdobeCommerceProductVariantsInventory(t *testing.T) {
	cases := []struct {
		name          string
		stock         map[string]any
		wantAvailable bool
	}{
		{"in_stock_managed", map[string]any{"is_in_stock": true, "manage_stock": true, "qty": 5.0, "backorders": 0.0}, true},
		{"out_of_stock", map[string]any{"is_in_stock": false, "manage_stock": true, "qty": 0.0}, false},
		{"backorders_allowed", map[string]any{"is_in_stock": false, "manage_stock": true, "qty": 0.0, "backorders": 1.0}, true},
		{"untracked", map[string]any{"is_in_stock": true, "manage_stock": false}, true},
		// PRODUCTION shape: the Adobe decoder uses UseNumber, so qty is a decimal
		// json.Number. A naive Int64() parse would collapse "5.0000" to 0 and
		// wrongly mark an in-stock product unavailable — guard that regression.
		{"in_stock_jsonnumber_decimal", map[string]any{"is_in_stock": true, "manage_stock": true, "qty": json.Number("5.0000")}, true},
		{"out_of_stock_jsonnumber", map[string]any{"is_in_stock": false, "manage_stock": true, "qty": json.Number("0.0000")}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw := map[string]any{
				"sku": "SKU1", "name": "Widget", "price": 19.99,
				"extension_attributes": map[string]any{"stock_item": c.stock},
			}
			in := adobeCommerceProductInput(raw)
			variants, _ := in.Raw["variants"].([]any)
			if len(variants) != 1 {
				t.Fatalf("want exactly 1 variant, got %d", len(variants))
			}
			v := variants[0].(map[string]any)
			// Drive the SAME availability computation the upsert path uses.
			avail := variantAvailable(nullableInt(v["inventory_quantity"]), normalizeInventoryPolicy(stringField(v, "inventory_policy")))
			if avail != c.wantAvailable {
				t.Fatalf("available=%v want %v (variant=%+v)", avail, c.wantAvailable, v)
			}
		})
	}
}

// The decisive fix: an out-of-stock Magento product must report unavailable so a
// later restock can flip it (previously the synthetic fallback variant was
// always available, so back-in-stock never fired for Adobe Commerce).
func TestAdobeCommerceOutOfStockThenRestock(t *testing.T) {
	base := map[string]any{"sku": "SKU1", "name": "Widget", "price": 19.99}

	oos := map[string]any{"is_in_stock": false, "manage_stock": true, "qty": 0.0}
	raw := map[string]any{"extension_attributes": map[string]any{"stock_item": oos}}
	for k, v := range base {
		raw[k] = v
	}
	v := adobeCommerceProductInput(raw).Raw["variants"].([]any)[0].(map[string]any)
	if variantAvailable(nullableInt(v["inventory_quantity"]), normalizeInventoryPolicy(stringField(v, "inventory_policy"))) {
		t.Fatal("out-of-stock product must be unavailable")
	}

	restock := map[string]any{"is_in_stock": true, "manage_stock": true, "qty": 3.0}
	raw2 := map[string]any{"extension_attributes": map[string]any{"stock_item": restock}}
	for k, val := range base {
		raw2[k] = val
	}
	v2 := adobeCommerceProductInput(raw2).Raw["variants"].([]any)[0].(map[string]any)
	if !variantAvailable(nullableInt(v2["inventory_quantity"]), normalizeInventoryPolicy(stringField(v2, "inventory_policy"))) {
		t.Fatal("restocked product must become available (this is what triggers back-in-stock)")
	}
}
