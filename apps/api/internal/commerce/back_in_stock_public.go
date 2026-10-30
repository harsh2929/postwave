// SPDX-License-Identifier: AGPL-3.0-only
//
// back_in_stock_public.go — the unauthenticated storefront intake for back-in-
// stock. A shopper on a connected Shopify store submits their email for an
// out-of-stock product and enters the loop (waiting -> eligible on restock ->
// notify -> flow -> email) that already exists end-to-end server-side. Without
// this endpoint that whole loop is unreachable by shoppers — the admin-only
// CreateBackInStockSubscription has no public counterpart. Tenant is resolved
// from the shop domain (the same shop-scoped lookup the Shopify webhooks use);
// product + variant resolve by their storefront source ids.
package commerce

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const publicBackInStockMaxBody = 16 << 10

func (d *Deps) PublicBackInStockSubscribe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ShopDomain string `json:"shop_domain"`
		ProductID  string `json:"product_id"`
		VariantID  string `json:"variant_id"`
		Email      string `json:"email"`
		Proof      string `json:"proof_token"`
	}
	if err := httpbody.DecodeJSON(w, r, publicBackInStockMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	shop := NormalizeShopDomain(in.ShopDomain)
	email := strings.ToLower(strings.TrimSpace(in.Email))
	product := strings.TrimSpace(in.ProductID)
	if shop == "" || product == "" || email == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_fields", "shop_domain, product_id and email are required")
		return
	}
	if _, err := mail.ParseAddress(email); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_email", "a valid email address is required")
		return
	}
	if d == nil || d.VerifyBackInStockProof == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "storefront_proof_unavailable", "back-in-stock signup is unavailable")
		return
	}
	if err := d.VerifyBackInStockProof(r.Context(), shop, product, email, strings.TrimSpace(in.Proof)); err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "invalid_storefront_proof", "complete storefront verification before subscribing")
		return
	}

	integration, err := d.Repo.FindShopifyIntegrationByShop(r.Context(), shop)
	if err != nil || integration == nil {
		// Don't distinguish "store unknown" from a lookup error to an anonymous
		// caller — both mean "we can't take this request".
		httperror.Write(w, http.StatusNotFound, "store_not_connected", "this store isn't connected to Moosewave")
		return
	}

	out, err := d.Repo.CreateBackInStockSubscription(r.Context(), integration.TenantID, integration.ID, product,
		BackInStockSubscriptionInput{
			VariantID:       strings.TrimSpace(in.VariantID),
			SubscriberEmail: email,
			Metadata: map[string]any{
				"source":         "onsite_widget",
				"consent_source": "onsite_back_in_stock",
			},
		})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "product_not_found", "that product isn't in the store catalog")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"ok":      true,
		"status":  out.Status,
		"message": "You're on the list — we'll email you the moment it's back in stock.",
	})
}
