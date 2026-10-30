package billing

import (
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Handlers struct {
	Repo        *Repo
	Logger      *slog.Logger
	stateLoader billingStateLoader
}

const billingJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

type dashboardState struct {
	Tier         string         `json:"tier"`
	StartedAt    string         `json:"startedAt"`
	SendingAddon *sendingAddon  `json:"sendingAddon"`
	Card         map[string]any `json:"card"`
}

type sendingAddon struct {
	MonthlyCap     int  `json:"monthlyCap"`
	Used           int  `json:"used"`
	DaysRemaining  int  `json:"daysRemaining"`
	OverageEnabled bool `json:"overageEnabled"`
	// OverageUnits is how far Used is past MonthlyCap this period (0 when under).
	OverageUnits int `json:"overageUnits"`
	// OverageCap is the user's optional ceiling on billable overage units.
	OverageCap *int `json:"overageCap,omitempty"`
	// OverageChargeable is true only when overage would actually bill — the
	// preference is on and the active provider's metering is configured.
	OverageChargeable bool `json:"overageChargeable"`
	// OverageBillingConfigured reflects ONLY whether provider metered billing is
	// wired (independent of the preference), so the UI can distinguish "off"
	// from "on but not yet charged".
	OverageBillingConfigured bool `json:"overageBillingConfigured"`
}

func (h *Handlers) State(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	st, err := h.Repo.GetState(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	used, err := h.Repo.CurrentMonthUsage(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, toDashboardState(st, t.Tier, used))
}

// SetOverage persists the tenant's overage preference (opt-in + optional unit
// ceiling) and returns the refreshed dashboard state. It deliberately does NOT
// hard-block when Stripe is unconfigured — self-host tenants may still record
// the toggle; whether it actually bills is surfaced via OverageChargeable.
func (h *Handlers) SetOverage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in struct {
		OverageEnabled bool `json:"overageEnabled"`
		OverageCap     *int `json:"overageCap"`
	}
	if err := httpbody.DecodeJSON(w, r, billingJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// Bound the ceiling to a sane, in-range value: a negative cap is nonsense
	// and a value past int32 would overflow the integer column (opaque 500).
	if in.OverageCap != nil && (*in.OverageCap < 0 || *in.OverageCap > math.MaxInt32) {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_overage_cap", "overage cap must be between 0 and 2147483647"))
		return
	}
	if in.OverageEnabled {
		writeJSON(w, http.StatusConflict, errEnv("overage_not_available", "Moosewave plans use hard monthly caps and do not offer paid overage"))
		return
	}
	if err := h.Repo.SetOverage(r.Context(), t.ID, in.OverageEnabled, in.OverageCap); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	st, err := h.Repo.GetState(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	used, err := h.Repo.CurrentMonthUsage(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, toDashboardState(st, t.Tier, used))
}

func (h *Handlers) Checkout(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	user, ok := middleware.UserFromContext(r.Context())
	if !ok || strings.TrimSpace(user.Email) == "" {
		writeJSON(w, http.StatusUnauthorized, errEnv("user_required", "a signed-in user email is required for checkout"))
		return
	}
	var in struct {
		Tier string `json:"tier"`
	}
	if err := httpbody.DecodeJSON(w, r, billingJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	tier := normalizeDashboardTier(in.Tier)
	if tier == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_tier", "unknown billing tier"))
		return
	}
	tierSlug := dashboardTierSlug(tier)
	if !billingLaunchApproved() {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_launch_blocked", "paid checkout is disabled until the approved billing launch record is configured"))
		return
	}
	if configuredProvider() == ProviderDodo {
		apiKey := strings.TrimSpace(os.Getenv("DODO_PAYMENTS_API_KEY"))
		if apiKey == "" {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_not_configured", "Dodo Payments checkout is not configured"))
			return
		}
		productID, canonicalTier, err := resolveDodoProduct(PublicCheckoutInput{Tier: tierSlug})
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_not_configured", "the selected plan is not configured for Dodo Payments checkout"))
			return
		}
		state, err := h.loadBillingState(r.Context(), tenant.ID)
		if err != nil {
			httperror.WriteInternal(w, h.Logger, err, r.Context())
			return
		}
		session, err := createDodoCheckoutSession(r.Context(), apiKey, dodoCheckoutCreate{
			ProductID:     productID,
			CustomerID:    providerCustomerID(state, ProviderDodo),
			CustomerEmail: strings.TrimSpace(user.Email),
			TenantID:      tenant.ID,
			Tier:          canonicalTier,
			ReturnURL:     localBillingURL("/app/billing?checkout=success"),
			CancelURL:     localBillingURL("/app/billing/upgrade?checkout=cancelled"),
			Origin:        "authenticated_dashboard",
		})
		if err != nil {
			if h.Logger != nil {
				h.Logger.Error("dashboard checkout Dodo Payments session create failed", "tenant_id", tenant.ID, "err", err.Error())
			}
			httperror.Write(w, http.StatusBadGateway, "payment_provider_request_failed", "upstream payment provider request failed")
			return
		}
		writeJSON(w, http.StatusOK, PublicCheckoutResponse{URL: session.CheckoutURL, SessionID: session.SessionID})
		return
	}
	secret := strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY"))
	if secret == "" && !isProtectedBillingRuntime() {
		writeJSON(w, http.StatusOK, map[string]string{
			"url": localBillingURL("/app/billing/upgrade?checkout=" + tierSlug),
		})
		return
	}
	if secret == "" {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_not_configured", "Stripe Checkout is not configured"))
		return
	}
	priceID, err := resolvePriceID(PublicCheckoutInput{Tier: tierSlug})
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("checkout_not_configured", "the selected plan is not configured for Stripe Checkout"))
		return
	}
	state, err := h.loadBillingState(r.Context(), tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	customerID := ""
	if state != nil {
		customerID = strings.TrimSpace(state.StripeCustomerID)
	}
	session, err := createStripeCheckoutSession(r.Context(), secret, stripeCheckoutCreate{
		PriceID:           priceID,
		Mode:              sessionModeFor(priceID),
		CustomerID:        customerID,
		CustomerEmail:     strings.TrimSpace(user.Email),
		ClientReferenceID: tenant.ID,
		TenantID:          tenant.ID,
		SuccessURL:        localBillingURL("/app/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}"),
		CancelURL:         localBillingURL("/app/billing/upgrade?checkout=cancelled"),
		Origin:            "authenticated_dashboard",
	})
	if err != nil {
		if h.Logger != nil {
			h.Logger.Error("dashboard checkout stripe session create failed", "tenant_id", tenant.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusBadGateway, "stripe_request_failed", "upstream Stripe request failed")
		return
	}
	writeJSON(w, http.StatusOK, PublicCheckoutResponse{URL: session.URL, SessionID: session.ID})
}

func (h *Handlers) Invoices(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := h.Repo.ListInvoices(r.Context(), t.ID, 24)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handlers) Usage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	// BILL-050: window selector. Clamp to the supported presets so an
	// arbitrary ?days can't drive an unbounded scan.
	days := 90
	switch r.URL.Query().Get("days") {
	case "30":
		days = 30
	case "365":
		days = 365
	}
	out, err := h.Repo.Usage(r.Context(), t.ID, days)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func toDashboardState(st *BillingState, tenantTier string, used int) dashboardState {
	effectiveTier := Tier(tenantTier)
	startedAt := time.Now().UTC()
	if st != nil {
		effectiveTier = st.Tier
		startedAt = st.UpdatedAt.UTC()
	}
	out := dashboardState{
		Tier:      dashboardTier(effectiveTier),
		StartedAt: startedAt.Format("2006-01-02"),
		Card:      nil,
	}
	out.SendingAddon = dashboardSendingAddon(effectiveTier, used, st)
	return out
}

func dashboardSendingAddon(tier Tier, used int, st *BillingState) *sendingAddon {
	// Only the paid sending tiers surface an addon; the cap is the SAME number
	// limits.Check enforces (BILL-052 — was a hardcoded 250k here that disagreed
	// with the enforced 500k for pro).
	switch tier {
	case TierLaunch, TierGrowth, TierScale, TierSending, TierPro:
	default:
		return nil
	}
	cap := limits.MonthlySendCap(string(tier))
	overageUnits := used - cap
	if overageUnits < 0 {
		overageUnits = 0
	}
	addon := &sendingAddon{
		MonthlyCap:    cap,
		Used:          used,
		DaysRemaining: daysRemainingInMonth(time.Now().UTC()),
		OverageUnits:  overageUnits,
	}
	// Launch catalog plans are hard-capped. Historical preferences may remain
	// stored for rollback compatibility, but must never make the current UI or
	// provider path chargeable.
	return addon
}

// overageBillingConfigured reports whether an overage would actually bill: the
// Stripe secret is present AND a metered subscription item has been captured.
func overageBillingConfigured(st *BillingState) bool {
	// Dodo metered overage is intentionally not advertised or charged until its
	// usage-record contract has a qualified integration. The dashboard receives
	// false and presents the capability as coming soon.
	if configuredProvider() == ProviderDodo {
		return false
	}
	return strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY")) != "" &&
		st != nil && strings.TrimSpace(st.StripeOverageItemID) != ""
}

func dashboardTier(t Tier) string {
	switch t {
	case TierLaunch:
		return "launch"
	case TierGrowth:
		return "growth"
	case TierScale:
		return "scale"
	case TierStudio:
		return "launch"
	case TierSending:
		return "launch"
	case TierPro:
		return "scale"
	default:
		return "sandbox"
	}
}

func normalizeDashboardTier(t string) string {
	switch t {
	case "launch":
		return "LAUNCH"
	case "growth":
		return "GROWTH"
	case "scale":
		return "SCALE"
	case "studio_ltd":
		return "LAUNCH"
	case "studio_ltd_cloud":
		return "LAUNCH"
	case "studio_ltd_plus":
		return "SCALE"
	default:
		return ""
	}
}

func dashboardTierSlug(t string) string {
	switch t {
	case "LAUNCH":
		return "launch"
	case "GROWTH":
		return "growth"
	case "SCALE":
		return "scale"
	default:
		return ""
	}
}

func isProtectedBillingRuntime() bool {
	for _, key := range []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT", "NODE_ENV"} {
		switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
		case "production", "prod", "staging", "stage":
			return true
		}
	}
	return false
}

// billingLaunchApproved is an operational dead-man switch for accepting real
// money. Live Stripe credentials alone are not product/legal approval. A
// protected runtime must carry a release-record reference such as
// "approved:LAUNCH-2026-07" after pricing, tax, refund, capacity enforcement,
// and the live rehearsal are signed off. Development remains usable without it.
func billingLaunchApproved() bool {
	if !isProtectedBillingRuntime() {
		return true
	}
	approval := strings.TrimSpace(os.Getenv("MOOSEWAVE_BILLING_LAUNCH_APPROVAL"))
	if approval == "" {
		approval = strings.TrimSpace(os.Getenv("POSTWAVE_BILLING_LAUNCH_APPROVAL"))
	}
	return strings.HasPrefix(approval, "approved:") && len(strings.TrimPrefix(approval, "approved:")) >= 6
}

func localBillingURL(path string) string {
	base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/")
	if base == "" {
		base = "http://localhost:3000"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return base + path
}

func daysRemainingInMonth(now time.Time) int {
	next := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	return int(next.Sub(now).Hours() / 24)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
