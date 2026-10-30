package compat

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

var defaultShopifyScopes = []string{"read_products", "read_customers", "read_orders"}

var shopifyTokenHTTPClient = &http.Client{Timeout: 10 * time.Second}

func (d *Deps) StartShopifyOAuth(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	shop := normalizeShopDomain(r.URL.Query().Get("shop"))
	if shop == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "shop is required"))
		return
	}
	scopes := scopesFromQuery(r.URL.Query().Get("scopes"))
	redirectURI := strings.TrimSpace(r.URL.Query().Get("redirect_uri"))
	if redirectURI == "" {
		redirectURI = publicBaseURL(r) + "/api/v1/mailchimp-compat/ecommerce/shopify/oauth/callback"
	}
	state, expiresAt, err := d.Repo.CreateCommerceOAuthState(r.Context(), tenant.ID, "shopify", shop, scopes, redirectURI)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	clientID := strings.TrimSpace(os.Getenv("SHOPIFY_CLIENT_ID"))
	localDemo := clientID == "" || strings.EqualFold(r.URL.Query().Get("demo"), "true")
	authURL := publicBaseURL(r) + "/api/v1/mailchimp-compat/ecommerce/shopify/oauth/callback?shop=" + url.QueryEscape(shop) + "&code=local_demo&state=" + url.QueryEscape(state)
	if !localDemo {
		v := url.Values{}
		v.Set("client_id", clientID)
		v.Set("scope", strings.Join(scopes, ","))
		v.Set("redirect_uri", redirectURI)
		v.Set("state", state)
		authURL = "https://" + shop + "/admin/oauth/authorize?" + v.Encode()
	}
	writeJSON(w, http.StatusOK, CommerceOAuthStart{
		AuthorizeURL: authURL,
		State:        state,
		ShopDomain:   shop,
		Scopes:       scopes,
		ExpiresAt:    expiresAt,
		LocalDemo:    localDemo,
	})
}

func (d *Deps) ShopifyOAuthCallback(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	shop := normalizeShopDomain(r.URL.Query().Get("shop"))
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if shop == "" || code == "" || state == "" {
		writeJSON(w, http.StatusUnprocessableEntity, errEnv("validation_failed", "shop, code, and state are required"))
		return
	}
	secret := strings.TrimSpace(os.Getenv("SHOPIFY_CLIENT_SECRET"))
	if secret != "" && !verifyShopifyOAuthHMAC(secret, r.URL.Query()) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Shopify OAuth hmac"))
		return
	}
	st, err := d.Repo.ConsumeCommerceOAuthState(r.Context(), tenant.ID, state, "shopify", shop)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_state", "OAuth state expired or already used"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	settings := map[string]any{
		"auth_mode":               "local_demo",
		"oauth_connected_at":      time.Now().UTC().Format(time.RFC3339),
		"webhooks_expected":       []string{"customers/create", "products/create", "orders/create", "orders/paid", "orders/cancelled", "refunds/create"},
		"access_token_configured": false,
	}
	status := "connected"
	if code != "local_demo" && secret != "" && strings.TrimSpace(os.Getenv("SHOPIFY_CLIENT_ID")) != "" {
		token, grantedScopes, err := exchangeShopifyToken(r.Context(), shop, code)
		if err != nil {
			status = "needs_auth"
			settings["auth_error"] = err.Error()
		} else {
			settings["auth_mode"] = "oauth"
			settings["access_token_configured"] = token != ""
			settings["granted_scope"] = grantedScopes
			// Deliberately avoid storing raw access tokens until the commerce
			// secret envelope is wired; sync workers can request reconnect if absent.
		}
	}
	in := CommerceIntegrationInput{
		Provider:   "shopify",
		ShopDomain: shop,
		Status:     status,
		Scopes:     st.Scopes,
		Settings:   settings,
	}
	out, err := d.Repo.CreateCommerceIntegration(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ShopifyWebhook(w http.ResponseWriter, r *http.Request) {
	const maxBodyBytes int64 = 2 << 20
	body, err := httpbody.ReadAtMost(r.Body, maxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("payload_too_large", "Shopify webhook payload exceeds 2 MiB"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret := strings.TrimSpace(os.Getenv("SHOPIFY_WEBHOOK_SECRET"))
	if secret == "" {
		secret = strings.TrimSpace(os.Getenv("SHOPIFY_CLIENT_SECRET"))
	}
	if secret != "" && !verifyShopifyWebhookHMAC(secret, body, r.Header.Get("X-Shopify-Hmac-Sha256")) {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "invalid Shopify webhook hmac"))
		return
	}
	shop := normalizeShopDomain(r.Header.Get("X-Shopify-Shop-Domain"))
	topic := strings.TrimSpace(r.Header.Get("X-Shopify-Topic"))
	eventID := firstNonEmpty(r.Header.Get("X-Shopify-Event-Id"), r.Header.Get("X-Shopify-Webhook-Id"))
	if shop == "" || topic == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_header", "Shopify shop and topic headers required"))
		return
	}
	result, err := d.Repo.UpsertShopifyWebhook(r.Context(), shop, topic, eventID, body)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("integration_not_found", "Shopify integration not found for shop"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type oauthStateRow struct {
	Scopes      []string
	RedirectURI string
	ExpiresAt   time.Time
}

func (r *Repo) CreateCommerceOAuthState(ctx context.Context, tenantID, provider, shop string, scopes []string, redirectURI string) (string, time.Time, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state := randomToken()
	expiresAt := time.Now().UTC().Add(15 * time.Minute)
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_oauth_states (state, tenant_id, provider, shop_domain, scopes, redirect_uri, expires_at)
VALUES ($1, $2::uuid, $3, $4, $5, NULLIF($6, ''), $7)`,
		state, tenantID, provider, shop, scopes, redirectURI, expiresAt); err != nil {
		return "", time.Time{}, err
	}
	return state, expiresAt, tx.Commit(ctx)
}

func (r *Repo) ConsumeCommerceOAuthState(ctx context.Context, tenantID, state, provider, shop string) (*oauthStateRow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out oauthStateRow
	err = tx.QueryRow(ctx, `
UPDATE commerce_oauth_states
   SET used_at = now()
 WHERE tenant_id = $1::uuid
   AND state = $2
   AND provider = $3
   AND COALESCE(shop_domain, '') = COALESCE(NULLIF($4, ''), shop_domain, '')
   AND used_at IS NULL
   AND expires_at > now()
RETURNING scopes, COALESCE(redirect_uri, ''), expires_at`,
		tenantID, state, provider, shop).Scan(&out.Scopes, &out.RedirectURI, &out.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(out.Scopes) == 0 {
		out.Scopes = defaultShopifyScopes
	}
	return &out, tx.Commit(ctx)
}

func (r *Repo) UpsertShopifyWebhook(ctx context.Context, shop, topic, eventID string, body []byte) (*CommerceWebhookResult, error) {
	tenantID, integrationID, err := r.lookupCommerceIntegrationByShop(ctx, "shopify", shop)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw := json.RawMessage(body)
	result := &CommerceWebhookResult{Accepted: true, Provider: "shopify", Topic: topic, IntegrationID: integrationID}
	switch {
	case strings.HasPrefix(topic, "customers/"):
		if err := upsertShopifyCustomer(ctx, tx, tenantID, integrationID, raw); err != nil {
			return nil, err
		}
		result.Customers = 1
	case strings.HasPrefix(topic, "products/"):
		if err := upsertShopifyProduct(ctx, tx, tenantID, integrationID, raw); err != nil {
			return nil, err
		}
		result.Products = 1
	case strings.HasPrefix(topic, "orders/"):
		if err := upsertShopifyOrder(ctx, tx, tenantID, integrationID, raw); err != nil {
			return nil, err
		}
		result.Orders = 1
	case strings.HasPrefix(topic, "refunds/"):
		if err := markShopifyRefund(ctx, tx, tenantID, integrationID, raw); err != nil {
			return nil, err
		}
		result.Orders = 1
	}
	meta, _ := json.Marshal(map[string]any{"topic": topic, "shop": shop})
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, provider_event_id, provider_topic, metadata)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5, $6::jsonb)
ON CONFLICT (tenant_id, integration_id, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING`,
		tenantID, integrationID, commerceEventType(topic), eventID, topic, string(meta)); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func (r *Repo) lookupCommerceIntegrationByShop(ctx context.Context, provider, shop string) (string, string, error) {
	var tenantID, integrationID string
	err := r.Pool.QueryRow(ctx, `
SELECT tenant_id::text, id::text
  FROM commerce_integrations
 WHERE provider = $1 AND lower(COALESCE(shop_domain, '')) = lower($2)
 ORDER BY updated_at DESC
 LIMIT 1`, provider, shop).Scan(&tenantID, &integrationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return tenantID, integrationID, err
}

type shopifyCustomer struct {
	ID               any    `json:"id"`
	Email            string `json:"email"`
	FirstName        string `json:"first_name"`
	LastName         string `json:"last_name"`
	AcceptsMarketing bool   `json:"accepts_marketing"`
	Tags             string `json:"tags"`
}

func upsertShopifyCustomer(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, raw json.RawMessage) error {
	var c shopifyCustomer
	if err := json.Unmarshal(raw, &c); err != nil {
		return err
	}
	rawJSON, _ := json.Marshal(c)
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_customers (tenant_id, integration_id, source_id, email, first_name, last_name, accepts_marketing, tags, raw)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  email = EXCLUDED.email,
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  accepts_marketing = EXCLUDED.accepts_marketing,
  tags = EXCLUDED.tags,
  raw = EXCLUDED.raw,
  updated_at = now()`,
		tenantID, integrationID, fmt.Sprint(c.ID), strings.ToLower(strings.TrimSpace(c.Email)),
		c.FirstName, c.LastName, c.AcceptsMarketing, splitCSVTags(c.Tags), string(rawJSON))
	return err
}

type shopifyProduct struct {
	ID     any    `json:"id"`
	Title  string `json:"title"`
	Handle string `json:"handle"`
	Image  *struct {
		Src string `json:"src"`
	} `json:"image"`
	Variants []struct {
		Price string `json:"price"`
	} `json:"variants"`
}

func upsertShopifyProduct(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, raw json.RawMessage) error {
	var p shopifyProduct
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	imageURL := ""
	if p.Image != nil {
		imageURL = p.Image.Src
	}
	price := 0
	if len(p.Variants) > 0 {
		price = centsFromDecimal(p.Variants[0].Price)
	}
	rawJSON, _ := json.Marshal(p)
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title, url, image_url, price_cents, currency, raw)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, 'USD', $8::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  url = EXCLUDED.url,
  image_url = EXCLUDED.image_url,
  price_cents = EXCLUDED.price_cents,
  raw = EXCLUDED.raw,
  updated_at = now()`,
		tenantID, integrationID, fmt.Sprint(p.ID), firstNonEmpty(p.Title, "Untitled product"),
		p.Handle, imageURL, price, string(rawJSON))
	return err
}

type shopifyOrder struct {
	ID                    any    `json:"id"`
	Email                 string `json:"email"`
	ContactEmail          string `json:"contact_email"`
	FinancialStatus       string `json:"financial_status"`
	Currency              string `json:"currency"`
	SubtotalPrice         string `json:"subtotal_price"`
	TotalDiscounts        string `json:"total_discounts"`
	TotalShippingPriceSet struct {
		ShopMoney struct {
			Amount string `json:"amount"`
		} `json:"shop_money"`
	} `json:"total_shipping_price_set"`
	TotalTax   string           `json:"total_tax"`
	TotalPrice string           `json:"total_price"`
	CreatedAt  time.Time        `json:"created_at"`
	LineItems  []map[string]any `json:"line_items"`
	Customer   *shopifyCustomer `json:"customer"`
}

func upsertShopifyOrder(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, raw json.RawMessage) error {
	var o shopifyOrder
	if err := json.Unmarshal(raw, &o); err != nil {
		return err
	}
	if o.Customer != nil {
		customerRaw, _ := json.Marshal(o.Customer)
		if err := upsertShopifyCustomer(ctx, tx, tenantID, integrationID, customerRaw); err != nil {
			return err
		}
	}
	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(o.Email, o.ContactEmail)))
	status := mapOrderStatus(o.FinancialStatus)
	orderedAt := o.CreatedAt
	if orderedAt.IsZero() {
		orderedAt = time.Now().UTC()
	}
	currency := firstNonEmpty(o.Currency, "USD")
	rawJSON, _ := json.Marshal(o)
	lineItems, _ := json.Marshal(o.LineItems)
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_orders (
    tenant_id, integration_id, source_id, customer_email, status, subtotal_cents,
    discount_cents, shipping_cents, tax_cents, total_cents, currency, attribution,
    line_items, raw, ordered_at
)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11,
        '{}'::jsonb, $12::jsonb, $13::jsonb, $14)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  customer_email = EXCLUDED.customer_email,
  status = EXCLUDED.status,
  subtotal_cents = EXCLUDED.subtotal_cents,
  discount_cents = EXCLUDED.discount_cents,
  shipping_cents = EXCLUDED.shipping_cents,
  tax_cents = EXCLUDED.tax_cents,
  total_cents = EXCLUDED.total_cents,
  currency = EXCLUDED.currency,
  line_items = EXCLUDED.line_items,
  raw = EXCLUDED.raw,
  ordered_at = EXCLUDED.ordered_at,
  updated_at = now()`,
		tenantID, integrationID, fmt.Sprint(o.ID), email, status,
		centsFromDecimal(o.SubtotalPrice), centsFromDecimal(o.TotalDiscounts),
		centsFromDecimal(o.TotalShippingPriceSet.ShopMoney.Amount), centsFromDecimal(o.TotalTax),
		centsFromDecimal(o.TotalPrice), currency, string(lineItems), string(rawJSON), orderedAt)
	return err
}

func markShopifyRefund(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, raw json.RawMessage) error {
	var payload struct {
		OrderID any `json:"order_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return err
	}
	if fmt.Sprint(payload.OrderID) == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `
UPDATE commerce_orders
   SET status = 'refunded', updated_at = now()
 WHERE tenant_id = $1::uuid AND integration_id = $2::uuid AND source_id = $3`,
		tenantID, integrationID, fmt.Sprint(payload.OrderID))
	return err
}

func (d *Deps) MailchimpRoot(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"account_id": "postwave",
		"login_id":   "postwave",
		"links": []map[string]string{
			{"rel": "lists", "href": "/api/mailchimp/3.0/lists", "method": "GET"},
		},
	})
}

func (d *Deps) MailchimpLists(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	total, err := d.Repo.CountSubscribers(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"lists": []map[string]any{{
			"id":   tenant.Slug,
			"name": firstNonEmpty(tenant.Name, tenant.Slug, "Moosewave audience"),
			"stats": map[string]any{
				"member_count": total,
			},
		}},
		"total_items": 1,
	})
}

func (d *Deps) MailchimpMembers(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	count := intParam(r.URL.Query().Get("count"), 100)
	offset := intParam(r.URL.Query().Get("offset"), 0)
	page := offset/count + 1
	rows, err := d.Repo.ListMailchimpMembers(r.Context(), tenant.ID, page, count)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	members := make([]map[string]any, 0, len(rows.Items))
	for _, sub := range rows.Items {
		members = append(members, mailchimpMemberEnvelope(sub, chi.URLParam(r, "listID")))
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members, "total_items": rows.Total})
}

func (d *Deps) MailchimpMember(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	sub, err := d.Repo.GetSubscriberByHash(r.Context(), tenant.ID, chi.URLParam(r, "subscriberHash"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeMailchimpProblem(w, r, http.StatusNotFound, "member not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, mailchimpMemberEnvelope(*sub, chi.URLParam(r, "listID")))
}

func (d *Deps) MailchimpCreateMember(w http.ResponseWriter, r *http.Request) {
	d.upsertMailchimpMember(w, r, "")
}

func (d *Deps) MailchimpUpdateMember(w http.ResponseWriter, r *http.Request) {
	d.upsertMailchimpMember(w, r, chi.URLParam(r, "subscriberHash"))
}

func (d *Deps) upsertMailchimpMember(w http.ResponseWriter, r *http.Request, hash string) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	var body struct {
		EmailAddress string          `json:"email_address"`
		Status       string          `json:"status"`
		StatusIfNew  string          `json:"status_if_new"`
		MergeFields  map[string]any  `json:"merge_fields"`
		Tags         []string        `json:"tags"`
		Interests    map[string]bool `json:"interests"`
	}
	if !decode(w, r, &body) {
		return
	}
	email := strings.TrimSpace(strings.ToLower(body.EmailAddress))
	if email == "" && hash != "" {
		if sub, err := d.Repo.GetSubscriberByHash(r.Context(), tenant.ID, hash); err == nil {
			email = sub.Email
		}
	}
	if _, err := mail.ParseAddress(email); err != nil {
		writeMailchimpProblem(w, r, http.StatusBadRequest, "email_address must be valid")
		return
	}
	status := firstNonEmpty(body.Status, body.StatusIfNew, "subscribed")
	if !validMailchimpMemberStatus(status) {
		writeMailchimpProblem(w, r, http.StatusBadRequest, "status must be subscribed, unsubscribed, non_subscribed, pending, transactional, cleaned, archived, or deleted")
		return
	}
	if d.Limits != nil {
		exists, err := (&subscribers.Repo{Pool: d.Repo.Pool}).ExistsByEmail(r.Context(), tenant.ID, email)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
			return
		}
		if !exists {
			if err := d.Limits.Check(r.Context(), tenant.ID, limits.ResourceContacts, 1); err != nil {
				if limits.WriteExceeded(w, err) {
					return
				}
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
				return
			}
		}
	}
	in := subscribers.CreateInput{
		Email:           email,
		Status:          listmonkStatusFromMailchimp(status),
		MailchimpStatus: normalizeMailchimpMemberStatus(status),
		ConsentSource:   subscribers.ConsentAPI,
		CustomFields:    nonNilMap(body.MergeFields),
		// Preserve the nil-vs-empty distinction for PATCH: omitted means keep
		// the member's current audience fields, while {} is an intentional clear.
		MergeFields: body.MergeFields,
		Tags:        body.Tags,
		Groups:      interestsToGroups(body.Interests),
	}
	sub, err := d.Repo.UpsertSubscriber(r.Context(), tenant.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, mailchimpMemberEnvelope(*sub, chi.URLParam(r, "listID")))
}

func (d *Deps) MailchimpTags(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	var body struct {
		Tags []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"tags"`
	}
	if !decode(w, r, &body) {
		return
	}
	sub, err := d.Repo.GetSubscriberByHash(r.Context(), tenant.ID, chi.URLParam(r, "subscriberHash"))
	if err != nil {
		writeMailchimpProblem(w, r, http.StatusNotFound, "member not found")
		return
	}
	tags := map[string]bool{}
	for _, t := range sub.Tags {
		tags[t] = true
	}
	for _, t := range body.Tags {
		name := strings.TrimSpace(t.Name)
		if name == "" {
			continue
		}
		if strings.EqualFold(t.Status, "inactive") {
			delete(tags, name)
		} else {
			tags[name] = true
		}
	}
	next := make([]string, 0, len(tags))
	for tag := range tags {
		next = append(next, tag)
	}
	sort.Strings(next)
	if err := d.Repo.UpdateSubscriberTags(r.Context(), tenant.ID, sub.ID, next); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) MailchimpReport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := tenant(r)
	if !ok {
		writeMailchimpProblem(w, r, http.StatusUnauthorized, "tenant required")
		return
	}
	report, err := d.Repo.CampaignReport(r.Context(), tenant.ID, chi.URLParam(r, "campaignID"))
	if err != nil {
		writeMailchimpProblem(w, r, http.StatusNotFound, "report not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":            report.CampaignID,
		"emails_sent":   report.Sent,
		"abuse_reports": report.Complained,
		"unsubscribed":  report.Unsubscribed,
		"opens": map[string]any{
			"opens_total":  report.Opened,
			"unique_opens": report.Opened,
			"open_rate":    report.OpenRate,
		},
		"clicks": map[string]any{
			"clicks_total":  report.Clicked,
			"unique_clicks": report.Clicked,
			"click_rate":    report.ClickRate,
		},
		"bounces": map[string]any{
			"hard_bounces": report.Bounced,
		},
		"ecommerce": map[string]any{
			"total_revenue": float64(report.RevenueCents) / 100,
		},
	})
}

func (r *Repo) CountSubscribers(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&total); err != nil {
		return 0, err
	}
	return total, tx.Commit(ctx)
}

func (r *Repo) ListMailchimpMembers(ctx context.Context, tenantID string, page, count int) (*subscribers.Page, error) {
	return (&subscribers.Repo{Pool: r.Pool}).List(ctx, tenantID, page, count)
}

func (r *Repo) UpsertSubscriber(ctx context.Context, tenantID string, in subscribers.CreateInput) (*subscribers.Subscriber, error) {
	return (&subscribers.Repo{Pool: r.Pool}).Upsert(ctx, tenantID, in)
}

func (r *Repo) GetSubscriberByHash(ctx context.Context, tenantID, hash string) (*subscribers.Subscriber, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT email::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND md5(lower(email::text)) = lower($2)
 LIMIT 1`, tenantID, hash)
	var email string
	if err := row.Scan(&email); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	sub, err := (&subscribers.Repo{Pool: r.Pool}).Get(ctx, tenantID, email)
	if errors.Is(err, subscribers.ErrNotFound) {
		return nil, ErrNotFound
	}
	return sub, err
}

func (r *Repo) UpdateSubscriberTags(ctx context.Context, tenantID, id string, tags []string) error {
	repo := &subscribers.Repo{Pool: r.Pool}
	_, err := repo.Update(ctx, tenantID, id, subscribers.UpdateInput{Tags: tags})
	return err
}

func mailchimpMemberEnvelope(sub subscribers.Subscriber, listID string) map[string]any {
	status := sub.MailchimpStatus
	if status == "" {
		status = normalizeMailchimpMemberStatus(sub.Status)
	}
	tags := make([]map[string]string, 0, len(sub.Tags))
	for _, tag := range sub.Tags {
		tags = append(tags, map[string]string{"name": tag, "status": "active"})
	}
	return map[string]any{
		"id":               subscriberHash(sub.Email),
		"email_address":    sub.Email,
		"unique_email_id":  subscriberHash(sub.Email),
		"web_id":           sub.ID,
		"status":           status,
		"merge_fields":     sub.MergeFields,
		"tags":             tags,
		"interests":        groupsToInterests(sub.Groups),
		"list_id":          listID,
		"timestamp_signup": sub.CreatedAt,
		"last_changed":     sub.UpdatedAt,
	}
}

func writeMailchimpProblem(w http.ResponseWriter, r *http.Request, status int, detail string) {
	writeJSON(w, status, MailchimpProblem{
		Type:     "https://mailchimp.com/developer/marketing/docs/errors/",
		Title:    http.StatusText(status),
		Status:   status,
		Detail:   detail,
		Instance: r.URL.Path,
	})
}

func verifyShopifyOAuthHMAC(secret string, q url.Values) bool {
	got := q.Get("hmac")
	if got == "" {
		return false
	}
	parts := make([]string, 0, len(q))
	for key, values := range q {
		if key == "hmac" || key == "signature" {
			continue
		}
		sort.Strings(values)
		for _, value := range values {
			parts = append(parts, key+"="+value)
		}
	}
	sort.Strings(parts)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strings.Join(parts, "&")))
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(got))
}

func verifyShopifyWebhookHMAC(secret string, body []byte, got string) bool {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(got))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), raw)
}

func exchangeShopifyToken(ctx context.Context, shop, code string) (string, string, error) {
	const shopifyTokenResponseMaxBytes int64 = 64 << 10 // 64 KiB

	payload, _ := json.Marshal(map[string]string{
		"client_id":     os.Getenv("SHOPIFY_CLIENT_ID"),
		"client_secret": os.Getenv("SHOPIFY_CLIENT_SECRET"),
		"code":          code,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+shop+"/admin/oauth/access_token", bytes.NewReader(payload))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := shopifyTokenHTTPClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return "", "", fmt.Errorf("token exchange failed: %s", resp.Status)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
	}
	if resp.ContentLength > shopifyTokenResponseMaxBytes {
		return "", "", fmt.Errorf("token exchange response body too large")
	}
	if err := decodeJSONLimited(resp.Body, shopifyTokenResponseMaxBytes, &out); err != nil {
		return "", "", err
	}
	return out.AccessToken, out.Scope, nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return fmt.Errorf("response body too large")
	}
	return json.Unmarshal(buf, out)
}

func randomToken() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("state_%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func normalizeShopDomain(raw string) string {
	raw = strings.ToLower(strings.TrimSpace(raw))
	raw = strings.TrimPrefix(raw, "https://")
	raw = strings.TrimPrefix(raw, "http://")
	raw = strings.TrimSuffix(raw, "/")
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, ".") {
		raw += ".myshopify.com"
	}
	if !strings.HasSuffix(raw, ".myshopify.com") && strings.Contains(raw, "/") {
		return ""
	}
	return raw
}

func scopesFromQuery(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return append([]string{}, defaultShopifyScopes...)
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	if len(out) == 0 {
		return append([]string{}, defaultShopifyScopes...)
	}
	return out
}

func publicBaseURL(r *http.Request) string {
	proto := firstNonEmpty(r.Header.Get("X-Forwarded-Proto"), "http")
	host := firstNonEmpty(r.Header.Get("X-Forwarded-Host"), r.Host)
	return proto + "://" + host
}

func commerceEventType(topic string) string {
	switch {
	case strings.HasPrefix(topic, "customers/"):
		return "customer_created"
	case strings.HasPrefix(topic, "products/"):
		return "product_created"
	case strings.HasPrefix(topic, "orders/"):
		if strings.Contains(topic, "cancelled") {
			return "order_refunded"
		}
		return "order_created"
	case strings.HasPrefix(topic, "refunds/"):
		return "order_refunded"
	default:
		return "sync_completed"
	}
}

func splitCSVTags(raw string) []string {
	parts := strings.Split(raw, ",")
	out := []string{}
	for _, part := range parts {
		if tag := strings.TrimSpace(part); tag != "" {
			out = append(out, tag)
		}
	}
	return out
}

func centsFromDecimal(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return int(f*100 + 0.5)
}

func mapOrderStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "paid", "authorized", "partially_paid":
		return "paid"
	case "refunded", "partially_refunded":
		return "refunded"
	case "voided", "cancelled":
		return "cancelled"
	default:
		return "pending"
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func intParam(raw string, fallback int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return fallback
	}
	if n > 1000 {
		return 1000
	}
	return n
}

func subscriberHash(email string) string {
	sum := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}

func listmonkStatusFromMailchimp(status string) string {
	switch normalizeMailchimpMemberStatus(status) {
	case "subscribed":
		return subscribers.StatusEnabled
	case "unsubscribed", "transactional", "archived", "deleted":
		return subscribers.StatusDisabled
	case "cleaned":
		return subscribers.StatusBlocklisted
	default:
		return subscribers.StatusUnconfirmed
	}
}

func validMailchimpMemberStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "subscribed", "unsubscribed", "non_subscribed", "pending", "transactional", "cleaned", "archived", "deleted":
		return true
	default:
		return false
	}
}

func normalizeMailchimpMemberStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "subscribed", "unsubscribed", "non_subscribed", "pending", "transactional", "cleaned", "archived", "deleted":
		return strings.ToLower(strings.TrimSpace(status))
	case subscribers.StatusEnabled:
		return "subscribed"
	case subscribers.StatusDisabled:
		return "unsubscribed"
	case subscribers.StatusBlocklisted:
		return "cleaned"
	default:
		return "non_subscribed"
	}
}

func interestsToGroups(interests map[string]bool) []map[string]any {
	out := []map[string]any{}
	for id, active := range interests {
		if active {
			out = append(out, map[string]any{"source_id": id, "name": id})
		}
	}
	return out
}

func groupsToInterests(groups []map[string]any) map[string]bool {
	out := map[string]bool{}
	for _, group := range groups {
		id := fmt.Sprint(firstNonEmpty(fmt.Sprint(group["source_id"]), fmt.Sprint(group["id"]), fmt.Sprint(group["name"])))
		if id != "" && id != "<nil>" {
			out[id] = true
		}
	}
	return out
}
