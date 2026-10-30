// SPDX-License-Identifier: AGPL-3.0-only

package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const dodoCheckoutResponseMaxBytes int64 = 1 << 20

var (
	dodoHTTPClient              = &http.Client{Timeout: 10 * time.Second}
	dodoAPIBaseOverride         string
	errDodoProductNotConfigured = errors.New("Dodo Payments product configuration is incomplete")
)

type dodoProductItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}

type dodoCustomerRequest struct {
	CustomerID string `json:"customer_id,omitempty"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
}

type dodoCheckoutRequest struct {
	ProductCart  []dodoProductItem   `json:"product_cart"`
	Customer     dodoCustomerRequest `json:"customer"`
	ReturnURL    string              `json:"return_url"`
	CancelURL    string              `json:"cancel_url,omitempty"`
	Metadata     map[string]string   `json:"metadata,omitempty"`
	FeatureFlags dodoCheckoutFlags   `json:"feature_flags"`
}

type dodoCheckoutFlags struct {
	RedirectImmediately bool `json:"redirect_immediately"`
}

type dodoCheckoutResponse struct {
	SessionID   string `json:"session_id"`
	CheckoutURL string `json:"checkout_url"`
}

type dodoAPIError struct {
	Message string `json:"message"`
	Detail  any    `json:"detail"`
}

type dodoCheckoutCreate struct {
	ProductID     string
	CustomerID    string
	CustomerEmail string
	CustomerName  string
	TenantID      string
	Tier          string
	Origin        string
	ReturnURL     string
	CancelURL     string
}

func (h *Handlers) publicDodoCheckout(w http.ResponseWriter, r *http.Request, in PublicCheckoutInput) {
	productID, tier, err := resolveDodoProduct(in)
	if err != nil {
		if errors.Is(err, errDodoProductNotConfigured) {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_not_configured", "the selected plan is not configured for Dodo Payments checkout"))
			return
		}
		httperror.Write(w, http.StatusBadRequest, "invalid_product", err.Error())
		return
	}
	apiKey := strings.TrimSpace(os.Getenv("DODO_PAYMENTS_API_KEY"))
	if apiKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv(
			"checkout_not_configured",
			"Dodo Payments checkout is not configured on this Moosewave server."))
		return
	}
	returnURL, err := trustedCheckoutReturnURL(in.SuccessURL, defaultDodoSuccessURL())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_return_url", err.Error()))
		return
	}
	cancelURL, err := trustedCheckoutReturnURL(in.CancelURL, defaultCancelURL())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_return_url", err.Error()))
		return
	}
	session, err := createDodoCheckoutSession(r.Context(), apiKey, dodoCheckoutCreate{
		ProductID:     productID,
		CustomerEmail: in.CustomerEmail,
		Tier:          tier,
		Origin:        "marketing_pricing_page",
		ReturnURL:     returnURL,
		CancelURL:     cancelURL,
	})
	if err != nil {
		if h.Logger != nil {
			h.Logger.Error("public checkout Dodo Payments session create failed", "err", err.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "payment_provider_request_failed", "upstream payment provider request failed")
		return
	}
	writeJSON(w, http.StatusOK, PublicCheckoutResponse{URL: session.CheckoutURL, SessionID: session.SessionID})
}

func resolveDodoProduct(in PublicCheckoutInput) (productID, tier string, err error) {
	candidate := strings.TrimSpace(in.ProductID)
	if candidate == "" && strings.HasPrefix(strings.TrimSpace(in.PriceID), "pdt_") {
		candidate = strings.TrimSpace(in.PriceID)
	}
	if candidate != "" {
		if !strings.HasPrefix(candidate, "pdt_") {
			return "", "", errors.New("productId must be a Dodo Payments product ID")
		}
		for _, item := range dodoProducts() {
			if item.id == candidate {
				return candidate, item.tier, nil
			}
		}
		return "", "", fmt.Errorf("productId %q is not in the configured DODO_PAYMENTS_PRODUCT_ID_* environment variables", candidate)
	}

	tier = strings.ToLower(strings.TrimSpace(in.Tier))
	var envName string
	switch tier {
	case "launch":
		envName = "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY"
	case "growth":
		envName = "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY"
	case "scale":
		envName = "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"
	default:
		return "", "", fmt.Errorf("either productId or a launch, growth, or scale tier must be set (got tier=%q)", in.Tier)
	}
	productID = strings.TrimSpace(os.Getenv(envName))
	if !strings.HasPrefix(productID, "pdt_") || dodoProductRoleCount(productID) != 1 {
		return "", "", fmt.Errorf("%w: %s must contain one unique Dodo Payments product ID", errDodoProductNotConfigured, envName)
	}
	return productID, tier, nil
}

type dodoProductConfig struct {
	id   string
	tier string
}

func dodoProducts() []dodoProductConfig {
	return []dodoProductConfig{
		{id: strings.TrimSpace(os.Getenv("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY")), tier: "launch"},
		{id: strings.TrimSpace(os.Getenv("DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY")), tier: "growth"},
		{id: strings.TrimSpace(os.Getenv("DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY")), tier: "scale"},
	}
}

func dodoProductRoleCount(candidate string) int {
	count := 0
	for _, product := range dodoProducts() {
		if candidate != "" && product.id == candidate {
			count++
		}
	}
	return count
}

func tierForDodoProduct(productID string) Tier {
	for _, product := range dodoProducts() {
		if product.id != "" && product.id == strings.TrimSpace(productID) {
			switch product.tier {
			case "launch":
				return TierLaunch
			case "growth":
				return TierGrowth
			case "scale":
				return TierScale
			}
		}
	}
	return ""
}

func defaultDodoSuccessURL() string {
	if v := strings.TrimSpace(os.Getenv("PRICING_SUCCESS_URL")); v != "" {
		return v
	}
	base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/")
	if base == "" {
		base = "https://moosewave.com"
	}
	return base + "/pricing/success?checkout=dodo"
}

func dodoAPIBase() (string, error) {
	if dodoAPIBaseOverride != "" {
		return strings.TrimRight(dodoAPIBaseOverride, "/"), nil
	}
	switch strings.ToLower(strings.TrimSpace(os.Getenv("DODO_PAYMENTS_ENVIRONMENT"))) {
	case "live_mode", "live", "production":
		return "https://live.dodopayments.com", nil
	case "test_mode", "test", "sandbox", "":
		if isProtectedBillingRuntime() && strings.TrimSpace(os.Getenv("DODO_PAYMENTS_ENVIRONMENT")) == "" {
			return "", errors.New("DODO_PAYMENTS_ENVIRONMENT is required in protected runtimes")
		}
		return "https://test.dodopayments.com", nil
	default:
		return "", errors.New("DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode")
	}
}

func createDodoCheckoutSession(ctx context.Context, apiKey string, in dodoCheckoutCreate) (*dodoCheckoutResponse, error) {
	base, err := dodoAPIBase()
	if err != nil {
		return nil, err
	}
	customer := dodoCustomerRequest{CustomerID: strings.TrimSpace(in.CustomerID)}
	if customer.CustomerID == "" {
		customer.Email = strings.TrimSpace(in.CustomerEmail)
		customer.Name = strings.TrimSpace(in.CustomerName)
	}
	metadata := map[string]string{
		"origin": "moosewave",
		"tier":   strings.TrimSpace(in.Tier),
	}
	if origin := strings.TrimSpace(in.Origin); origin != "" {
		metadata["origin"] = origin
	}
	if tenantID := strings.TrimSpace(in.TenantID); tenantID != "" {
		metadata["tenant_id"] = tenantID
	}
	if email := strings.TrimSpace(in.CustomerEmail); email != "" {
		metadata["customer_email"] = email
	}
	payload, err := json.Marshal(dodoCheckoutRequest{
		ProductCart:  []dodoProductItem{{ProductID: in.ProductID, Quantity: 1}},
		Customer:     customer,
		ReturnURL:    in.ReturnURL,
		CancelURL:    in.CancelURL,
		Metadata:     metadata,
		FeatureFlags: dodoCheckoutFlags{RedirectImmediately: true},
	})
	if err != nil {
		return nil, fmt.Errorf("encode Dodo Payments checkout: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/checkouts", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build Dodo Payments checkout request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	req.Header.Set("Content-Type", "application/json")
	resp, err := dodoHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Dodo Payments checkout HTTP: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, dodoCheckoutResponseMaxBytes)
	if readErr != nil {
		return nil, fmt.Errorf("read Dodo Payments checkout response: %w", readErr)
	}
	if resp.StatusCode >= 400 {
		var upstream dodoAPIError
		_ = json.Unmarshal(body, &upstream)
		message := strings.TrimSpace(upstream.Message)
		if message == "" {
			message = fmt.Sprintf("Dodo Payments HTTP %d", resp.StatusCode)
		}
		return nil, errors.New(message)
	}
	var out dodoCheckoutResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("decode Dodo Payments checkout response: %w", err)
	}
	if strings.TrimSpace(out.SessionID) == "" || strings.TrimSpace(out.CheckoutURL) == "" {
		return nil, errors.New("Dodo Payments response missing session_id or checkout_url")
	}
	if checkoutURL, err := url.Parse(out.CheckoutURL); err != nil || checkoutURL.Scheme != "https" || checkoutURL.Host == "" {
		return nil, errors.New("Dodo Payments response contained an invalid checkout_url")
	}
	return &out, nil
}
