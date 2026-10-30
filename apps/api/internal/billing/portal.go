package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type billingStateLoader func(context.Context, string) (*BillingState, error)

type stripePortalSessionResponse struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// Portal creates a short-lived provider-hosted customer portal session for the
// authenticated tenant. A static portal URL cannot safely identify a tenant
// and is therefore intentionally not supported.
func (h *Handlers) Portal(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}

	if configuredProvider() == ProviderDodo {
		h.dodoPortal(w, r, tenant.ID)
		return
	}

	secret := strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	if secret == "" && !isProtectedBillingRuntime() {
		writeJSON(w, http.StatusOK, map[string]string{
			"url": localBillingURL("/app/billing?portal=local"),
		})
		return
	}
	if secret == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("portal_not_configured", "Stripe Billing Portal is not configured"))
		return
	}

	state, err := h.loadBillingState(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	if state == nil || strings.TrimSpace(state.StripeCustomerID) == "" {
		writeJSON(w, http.StatusConflict, errEnv("billing_customer_missing", "no Stripe customer is associated with this tenant"))
		return
	}

	session, err := createStripePortalSession(
		r.Context(),
		secret,
		strings.TrimSpace(state.StripeCustomerID),
		localBillingURL("/app/billing"),
	)
	if err != nil {
		if h.Logger != nil {
			h.Logger.Error("billing portal stripe session create failed", "tenant_id", tenant.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "stripe_request_failed", "upstream Stripe request failed")
		return
	}
	writeJSON(w, http.StatusOK, PublicCheckoutResponse{URL: session.URL, SessionID: session.ID})
}

type dodoPortalSessionResponse struct {
	Link string `json:"link"`
}

func (h *Handlers) dodoPortal(w http.ResponseWriter, r *http.Request, tenantID string) {
	apiKey := strings.TrimSpace(os.Getenv("DODO_PAYMENTS_API_KEY"))
	if apiKey == "" && !isProtectedBillingRuntime() {
		writeJSON(w, http.StatusOK, map[string]string{"url": localBillingURL("/app/billing?portal=local")})
		return
	}
	if apiKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("portal_not_configured", "Dodo Payments customer portal is not configured"))
		return
	}
	state, err := h.loadBillingState(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	customerID := providerCustomerID(state, ProviderDodo)
	if customerID == "" {
		writeJSON(w, http.StatusConflict, errEnv("billing_customer_missing", "no Dodo Payments customer is associated with this tenant"))
		return
	}
	session, err := createDodoPortalSession(r.Context(), apiKey, customerID)
	if err != nil {
		if h.Logger != nil {
			h.Logger.Error("Dodo Payments customer portal session create failed", "tenant_id", tenantID, "err", err.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "payment_provider_request_failed", "upstream payment provider request failed")
		return
	}
	writeJSON(w, http.StatusOK, PublicCheckoutResponse{URL: session.Link})
}

func createDodoPortalSession(ctx context.Context, apiKey, customerID string) (*dodoPortalSessionResponse, error) {
	base, err := dodoAPIBase()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/customers/"+url.PathEscape(customerID)+"/customer-portal/session", nil)
	if err != nil {
		return nil, fmt.Errorf("build Dodo Payments portal request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	resp, err := dodoHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Dodo Payments portal HTTP: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, dodoCheckoutResponseMaxBytes)
	if readErr != nil {
		return nil, fmt.Errorf("read Dodo Payments portal response: %w", readErr)
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, fmt.Errorf("Dodo Payments portal HTTP %d", resp.StatusCode)
	}
	var session dodoPortalSessionResponse
	if err := json.Unmarshal(body, &session); err != nil {
		return nil, fmt.Errorf("decode Dodo Payments portal response: %w", err)
	}
	parsed, err := url.Parse(session.Link)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, errors.New("Dodo Payments portal response missing a valid link")
	}
	return &session, nil
}

func (h *Handlers) loadBillingState(ctx context.Context, tenantID string) (*BillingState, error) {
	if h != nil && h.stateLoader != nil {
		return h.stateLoader(ctx, tenantID)
	}
	if h == nil || h.Repo == nil {
		return nil, nil
	}
	return h.Repo.GetState(ctx, tenantID)
}

func createStripePortalSession(
	ctx context.Context,
	secret string,
	customerID string,
	returnURL string,
) (*stripePortalSessionResponse, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", returnURL)
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		stripeAPIBase+"/v1/billing_portal/sessions",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return nil, fmt.Errorf("build stripe portal request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if version := strings.TrimSpace(os.Getenv("STRIPE_API_VERSION")); version != "" {
		req.Header.Set("Stripe-Version", version)
	}

	resp, err := stripeHTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stripe portal http: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, stripeCheckoutResponseMaxBytes)
	if resp.StatusCode >= http.StatusBadRequest {
		if readErr != nil {
			return nil, fmt.Errorf("stripe portal HTTP %d: %w", resp.StatusCode, readErr)
		}
		var stripeErr stripeErrorResponse
		_ = json.Unmarshal(body, &stripeErr)
		message := strings.TrimSpace(stripeErr.Error.Message)
		if message == "" {
			message = fmt.Sprintf("stripe portal HTTP %d", resp.StatusCode)
		}
		return nil, errors.New(message)
	}
	if readErr != nil {
		return nil, fmt.Errorf("decode stripe portal response: %w", readErr)
	}

	var session stripePortalSessionResponse
	if err := json.Unmarshal(body, &session); err != nil {
		return nil, fmt.Errorf("decode stripe portal response: %w", err)
	}
	if strings.TrimSpace(session.URL) == "" {
		return nil, errors.New("stripe portal response missing url")
	}
	return &session, nil
}
