// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"reflect"
	"testing"
)

func TestReviewProductSourceCandidatesIncludesCommerceSourceForms(t *testing.T) {
	got := reviewProductSourceCandidates(ReviewInput{
		Metadata: map[string]any{
			"external_product_id": "123",
			"provider_product_id": "gid://shopify/Product/456",
		},
	})
	wantContains := []string{
		"123",
		"gid://shopify/Product/456",
		"gid://shopify/Product/123",
		"bigcommerce://product/123",
		"woocommerce://product/123",
	}
	for _, want := range wantContains {
		if !containsString(got, want) {
			t.Fatalf("candidates missing %q: %+v", want, got)
		}
	}
}

func TestReviewProductSourceCandidatesDedupes(t *testing.T) {
	got := reviewProductSourceCandidates(ReviewInput{
		Metadata: map[string]any{
			"external_product_id": "P-1",
			"provider_product_id": "P-1",
		},
	})
	if reflect.DeepEqual(got, []string{"P-1", "P-1"}) {
		t.Fatalf("candidates were not deduped: %+v", got)
	}
	if countString(got, "P-1") != 1 {
		t.Fatalf("candidate P-1 count=%d in %+v", countString(got, "P-1"), got)
	}
}

func TestReviewOrderLineProductCandidateMatchesExplicitCandidate(t *testing.T) {
	lineItems := []map[string]any{
		{"product_id": "P-1", "sku": "SKU-1"},
		{"product_id": "P-2", "sku": "SKU-2"},
	}
	got, ok := reviewOrderLineProductCandidate(ReviewInput{
		Metadata: map[string]any{"external_product_id": "P-2"},
	}, lineItems)
	if !ok || got["product_id"] != "P-2" {
		t.Fatalf("candidate line item = %+v ok=%v", got, ok)
	}
}

func TestReviewOrderLineProductCandidateUsesSingleLineOrder(t *testing.T) {
	lineItems := []map[string]any{{"product_id": "P-1", "sku": "SKU-1"}}
	got, ok := reviewOrderLineProductCandidate(ReviewInput{
		Metadata: map[string]any{"external_product_id": "NO-MATCH"},
	}, lineItems)
	if !ok || got["product_id"] != "P-1" {
		t.Fatalf("single line item = %+v ok=%v", got, ok)
	}
}

func TestReviewOrderLineProductCandidateRejectsAmbiguousMultiLineOrder(t *testing.T) {
	lineItems := []map[string]any{
		{"product_id": "P-1", "sku": "SKU-1"},
		{"product_id": "P-2", "sku": "SKU-2"},
	}
	got, ok := reviewOrderLineProductCandidate(ReviewInput{
		Metadata: map[string]any{"external_product_id": "NO-MATCH"},
	}, lineItems)
	if ok || got != nil {
		t.Fatalf("ambiguous line item = %+v ok=%v", got, ok)
	}
}

func TestReviewOrderLineSourceCandidatesIncludeCommerceFormsAndSKU(t *testing.T) {
	lineItem := map[string]any{
		"product_id": "123",
		"variant_id": "456",
		"sku":        "Sku-Blue",
	}
	productRefs := reviewOrderLineProductSourceCandidates(lineItem)
	variantRefs := reviewOrderLineVariantSourceCandidates(lineItem)
	skus := reviewOrderLineSKUCandidates(lineItem)
	for _, want := range []string{"123", "gid://shopify/Product/123", "bigcommerce://product/123"} {
		if !containsString(productRefs, want) {
			t.Fatalf("product refs missing %q: %+v", want, productRefs)
		}
	}
	for _, want := range []string{"456", "gid://shopify/ProductVariant/456", "woocommerce://variation/456"} {
		if !containsString(variantRefs, want) {
			t.Fatalf("variant refs missing %q: %+v", want, variantRefs)
		}
	}
	if len(skus) != 1 || skus[0] != "sku-blue" {
		t.Fatalf("skus=%+v", skus)
	}
}

func TestReviewOrderSourceCandidatesIncludesCommerceSourceForms(t *testing.T) {
	got := reviewOrderSourceCandidates(ReviewInput{
		Metadata: map[string]any{
			"external_order_id": "1001",
			"provider_order_id": "gid://shopify/Order/2002",
		},
	})
	wantContains := []string{
		"1001",
		"gid://shopify/Order/2002",
		"gid://shopify/Order/1001",
		"bigcommerce://order/1001",
		"woocommerce://order/1001",
	}
	for _, want := range wantContains {
		if !containsString(got, want) {
			t.Fatalf("order candidates missing %q: %+v", want, got)
		}
	}
}

func TestReviewCustomerSourceCandidatesIncludesCommerceSourceForms(t *testing.T) {
	got := reviewCustomerSourceCandidates(ReviewInput{
		Metadata: map[string]any{
			"external_customer_id": "42",
			"provider_customer_id": "gid://shopify/Customer/84",
		},
	})
	wantContains := []string{
		"42",
		"gid://shopify/Customer/84",
		"gid://shopify/Customer/42",
		"bigcommerce://customer/42",
		"woocommerce://customer/42",
	}
	for _, want := range wantContains {
		if !containsString(got, want) {
			t.Fatalf("customer candidates missing %q: %+v", want, got)
		}
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func countString(values []string, want string) int {
	count := 0
	for _, value := range values {
		if value == want {
			count++
		}
	}
	return count
}
