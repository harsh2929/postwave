package deliverability_control

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// New() returns; nil-safe at the httperror call site.
	Logger *slog.Logger
}

type Repo struct {
	Pool *db.Pool
}

type DomainSetup struct {
	ID               string         `json:"id,omitempty"`
	TenantID         string         `json:"tenant_id,omitempty"`
	Domain           string         `json:"domain"`
	SetupMode        string         `json:"setup_mode"`
	Status           string         `json:"status"`
	DNSRecords       []DNSRecord    `json:"dns_records,omitempty"`
	HealthChecks     map[string]any `json:"health_checks,omitempty"`
	RollbackGuidance map[string]any `json:"rollback_guidance,omitempty"`
	SSLStatus        string         `json:"ssl_status"`
	RoutingStatus    string         `json:"routing_status"`
	CreatedAt        time.Time      `json:"created_at,omitempty"`
	UpdatedAt        time.Time      `json:"updated_at,omitempty"`
}

type DNSRecord struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	Required bool   `json:"required"`
}

type ClickTrackingPolicy struct {
	TenantID            string         `json:"tenant_id,omitempty"`
	TrackingDomain      string         `json:"tracking_domain"`
	Status              string         `json:"status"`
	SSLStatus           string         `json:"ssl_status"`
	CAAGuidance         map[string]any `json:"caa_guidance,omitempty"`
	DisableSyntax       []string       `json:"disable_syntax"`
	LastUntrackedReport map[string]any `json:"last_untracked_report,omitempty"`
	Settings            map[string]any `json:"settings,omitempty"`
	CreatedAt           time.Time      `json:"created_at,omitempty"`
	UpdatedAt           time.Time      `json:"updated_at,omitempty"`
}

type RoutingPolicy struct {
	TenantID                  string         `json:"tenant_id,omitempty"`
	Status                    string         `json:"status"`
	Strategy                  string         `json:"strategy"`
	DedicatedPool             string         `json:"dedicated_pool"`
	SharedPool                string         `json:"shared_pool"`
	DedicatedPercentageBP     int            `json:"dedicated_percentage_bp"`
	MaxDedicatedPercentageBP  int            `json:"max_dedicated_percentage_bp"`
	WarmupRules               map[string]any `json:"warmup_rules,omitempty"`
	LastEvaluatedAt           *time.Time     `json:"last_evaluated_at,omitempty"`
	CreatedAt                 time.Time      `json:"created_at,omitempty"`
	UpdatedAt                 time.Time      `json:"updated_at,omitempty"`
	EffectiveDedicatedPercent float64        `json:"effective_dedicated_percent,omitempty"`
	EffectiveSharedPercent    float64        `json:"effective_shared_percent,omitempty"`
}

type Entitlement struct {
	TenantID                string         `json:"tenant_id,omitempty"`
	PeriodStart             string         `json:"period_start"`
	PlanTier                string         `json:"plan_tier"`
	InboxTestsMonthly       int            `json:"inbox_tests_monthly"`
	RenderPreviewsMonthly   int            `json:"render_previews_monthly"`
	InboxTestsUsed          int            `json:"inbox_tests_used"`
	RenderPreviewsUsed      int            `json:"render_previews_used"`
	OveragePolicy           string         `json:"overage_policy"`
	AccountControls         map[string]any `json:"account_controls,omitempty"`
	CreatedAt               time.Time      `json:"created_at,omitempty"`
	UpdatedAt               time.Time      `json:"updated_at,omitempty"`
	InboxTestsRemaining     int            `json:"inbox_tests_remaining"`
	RenderPreviewsRemaining int            `json:"render_previews_remaining"`
}

type LinkScanRequest struct {
	HTML string `json:"html"`
}

type LinkScanReport struct {
	Links          []LinkFinding `json:"links"`
	TotalLinks     int           `json:"total_links"`
	TrackedLinks   int           `json:"tracked_links"`
	UntrackedLinks int           `json:"untracked_links"`
}

type LinkFinding struct {
	URL       string `json:"url"`
	Tracked   bool   `json:"tracked"`
	Reason    string `json:"reason,omitempty"`
	RawAnchor string `json:"raw_anchor,omitempty"`
}

type ValidationResult struct {
	Valid    bool     `json:"valid"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

var ErrNotFound = errors.New("deliverability_control: not found")

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/deliverability-control/catalog", d.Catalog)
	r.With(admin).Post("/api/v1/deliverability-control/domain-setups/validate", d.ValidateDomainSetup)
	r.With(read).Get("/api/v1/deliverability-control/domain-setups", d.ListDomainSetups)
	r.With(admin).Put("/api/v1/deliverability-control/domain-setups/{domain}", d.PutDomainSetup)
	r.With(read).Get("/api/v1/deliverability-control/click-tracking", d.GetClickTracking)
	r.With(admin).Put("/api/v1/deliverability-control/click-tracking", d.PutClickTracking)
	r.With(read).Post("/api/v1/deliverability-control/click-tracking/scan", d.ScanLinks)
	r.With(read).Get("/api/v1/deliverability-control/click-tracking/untracked-reports", d.ListUntrackedReports)
	r.With(read).Get("/api/v1/deliverability-control/ip-routing", d.GetRoutingPolicy)
	r.With(admin).Put("/api/v1/deliverability-control/ip-routing", d.PutRoutingPolicy)
	r.With(read).Get("/api/v1/deliverability-control/entitlements", d.GetEntitlement)
	r.With(admin).Put("/api/v1/deliverability-control/entitlements", d.PutEntitlement)
}

func (d *Deps) Catalog(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": "klv14.deliverability.v1",
		"domain_setup_modes": []map[string]string{
			{"key": "static_dns", "label": "Static DNS records", "runtime_status": "supported"},
			{"key": "dynamic_delegation", "label": "Delegated/dynamic routing", "runtime_status": "foundation"},
		},
		"click_tracking": map[string]any{
			"ssl_states":     []string{"not_requested", "pending", "active", "failed"},
			"disable_syntax": DefaultDisableSyntax(),
			"caa_guidance":   DefaultCAAGuidance(""),
		},
		"ip_routing_strategies": []string{"shared_only", "hybrid", "dedicated_only"},
		"entitlement_resources": []string{"inbox_tests", "render_previews"},
	})
}

func (d *Deps) ValidateDomainSetup(w http.ResponseWriter, r *http.Request) {
	var in DomainSetup
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ValidateSetup(in))
}

func (d *Deps) ListDomainSetups(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListDomainSetups(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) PutDomainSetup(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in DomainSetup
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Domain = chi.URLParam(r, "domain")
	if validation := ValidateSetup(in); !validation.Valid {
		writeJSON(w, http.StatusBadRequest, validation)
		return
	}
	out, err := d.Repo.UpsertDomainSetup(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetClickTracking(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetClickTracking(r.Context(), tenantID)
	if err != nil {
		d.writeRepoError(w, r, err, clickTrackingNotConfigured)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PutClickTracking(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ClickTrackingPolicy
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.UpsertClickTracking(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ScanLinks(w http.ResponseWriter, r *http.Request) {
	var in LinkScanRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	writeJSON(w, http.StatusOK, ScanUntrackedLinks(in.HTML))
}

func (d *Deps) GetRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetRoutingPolicy(r.Context(), tenantID)
	if err != nil {
		d.writeRepoError(w, r, err, ipRoutingNotConfigured)
		return
	}
	hydrateRouting(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PutRoutingPolicy(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in RoutingPolicy
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.UpsertRoutingPolicy(r.Context(), tenantID, in)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	hydrateRouting(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) GetEntitlement(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetEntitlement(r.Context(), tenantID)
	if err != nil {
		d.writeRepoError(w, r, err, inboxTestAllowanceNotConfigured)
		return
	}
	hydrateEntitlement(out)
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) PutEntitlement(w http.ResponseWriter, r *http.Request) {
	// Allowances are projections of signed billing state. Even a workspace
	// admin must not be able to raise a quota through the tenant API.
	entitlement.Write(w, entitlement.Denial{
		Subject: "deliverability.allowance", Reason: entitlement.ReasonPolicy,
		Code:    "entitlement_managed_by_billing",
		Message: "Deliverability allowances are managed by the active Moosewave plan.",
	})
}

func ValidateSetup(in DomainSetup) ValidationResult {
	normalizeSetup(&in)
	out := ValidationResult{Valid: true}
	if in.Domain == "" || !strings.Contains(in.Domain, ".") {
		out.Errors = append(out.Errors, "domain must be a valid hostname")
	}
	if !allowed(in.SetupMode, []string{"static_dns", "dynamic_delegation"}) {
		out.Errors = append(out.Errors, "setup_mode must be static_dns or dynamic_delegation")
	}
	if !allowed(in.Status, []string{"draft", "pending_dns", "verifying", "ready", "blocked", "rolled_back"}) {
		out.Errors = append(out.Errors, "status is invalid")
	}
	if in.SetupMode == "dynamic_delegation" {
		out.Warnings = append(out.Warnings, "dynamic delegation is modeled for setup workflow; provider-side routing activation remains gated by sending infrastructure")
	}
	out.Valid = len(out.Errors) == 0
	return out
}

func DefaultDNSRecords(domain, mode string) []DNSRecord {
	domain = strings.TrimSpace(strings.ToLower(domain))
	if mode == "dynamic_delegation" {
		return []DNSRecord{
			{Type: "CNAME", Name: "send." + domain, Value: "dynamic-routing.moosewave.com", Required: true},
			{Type: "TXT", Name: "_postwave-routing." + domain, Value: "pw-routing=delegated", Required: true},
		}
	}
	return []DNSRecord{
		{Type: "TXT", Name: domain, Value: "v=spf1 include:spf.moosewave.com ~all", Required: true},
		{Type: "CNAME", Name: "pw._domainkey." + domain, Value: "pw._domainkey.moosewave.com", Required: true},
		{Type: "TXT", Name: "_dmarc." + domain, Value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain, Required: false},
	}
}

func DefaultCAAGuidance(domain string) map[string]any {
	return map[string]any{
		"required_when_caa_exists": true,
		"records": []map[string]string{
			{"type": "CAA", "name": strings.TrimSpace(domain), "value": `0 issue "letsencrypt.org"`},
			{"type": "CAA", "name": strings.TrimSpace(domain), "value": `0 issuewild "letsencrypt.org"`},
		},
	}
}

func DefaultDisableSyntax() []string {
	return []string{`data-pw-no-track="true"`, `data-postwave-no-track="true"`}
}

var anchorRE = regexp.MustCompile(`(?is)<a\b[^>]*href=["']([^"']+)["'][^>]*>`)

func ScanUntrackedLinks(html string) LinkScanReport {
	matches := anchorRE.FindAllStringSubmatch(html, -1)
	out := LinkScanReport{Links: []LinkFinding{}, TotalLinks: len(matches)}
	for _, match := range matches {
		raw := match[0]
		url := match[1]
		tracked := true
		reason := ""
		lower := strings.ToLower(raw)
		switch {
		case strings.Contains(lower, "data-pw-no-track"):
			tracked = false
			reason = "data-pw-no-track"
		case strings.Contains(lower, "data-postwave-no-track"):
			tracked = false
			reason = "data-postwave-no-track"
		case strings.HasPrefix(strings.ToLower(url), "mailto:") || strings.HasPrefix(strings.ToLower(url), "tel:"):
			tracked = false
			reason = "non-http-link"
		}
		if tracked {
			out.TrackedLinks++
		} else {
			out.UntrackedLinks++
		}
		out.Links = append(out.Links, LinkFinding{URL: url, Tracked: tracked, Reason: reason, RawAnchor: raw})
	}
	return out
}

func normalizeSetup(in *DomainSetup) {
	in.Domain = strings.TrimSpace(strings.ToLower(in.Domain))
	in.SetupMode = defaulted(strings.TrimSpace(in.SetupMode), "static_dns")
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.SSLStatus = defaulted(strings.TrimSpace(in.SSLStatus), "not_requested")
	in.RoutingStatus = defaulted(strings.TrimSpace(in.RoutingStatus), "not_started")
	if len(in.DNSRecords) == 0 && in.Domain != "" {
		in.DNSRecords = DefaultDNSRecords(in.Domain, in.SetupMode)
	}
	if in.HealthChecks == nil {
		in.HealthChecks = map[string]any{}
	}
	if in.RollbackGuidance == nil {
		in.RollbackGuidance = map[string]any{
			"dns":     "Keep previous sending records until Moosewave health checks pass, then remove stale records.",
			"routing": "Pause hybrid routing and fall back to shared pool if blocklists or complaints spike.",
		}
	}
}

func normalizeClickPolicy(in *ClickTrackingPolicy) error {
	in.TrackingDomain = strings.TrimSpace(strings.ToLower(in.TrackingDomain))
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.SSLStatus = defaulted(strings.TrimSpace(in.SSLStatus), "not_requested")
	if in.TrackingDomain == "" {
		return fmt.Errorf("tracking_domain is required")
	}
	if !allowed(in.Status, []string{"draft", "pending_dns", "ssl_pending", "active", "blocked"}) {
		return fmt.Errorf("status is invalid")
	}
	if len(in.DisableSyntax) == 0 {
		in.DisableSyntax = DefaultDisableSyntax()
	}
	if in.CAAGuidance == nil {
		in.CAAGuidance = DefaultCAAGuidance(in.TrackingDomain)
	}
	if in.LastUntrackedReport == nil {
		in.LastUntrackedReport = map[string]any{}
	}
	if in.Settings == nil {
		in.Settings = map[string]any{}
	}
	return nil
}

func normalizeRouting(in *RoutingPolicy) error {
	in.Status = defaulted(strings.TrimSpace(in.Status), "draft")
	in.Strategy = defaulted(strings.TrimSpace(in.Strategy), "hybrid")
	in.DedicatedPool = defaulted(strings.TrimSpace(in.DedicatedPool), "paid_pro")
	in.SharedPool = defaulted(strings.TrimSpace(in.SharedPool), "shared")
	if !allowed(in.Status, []string{"draft", "active", "paused", "completed"}) {
		return fmt.Errorf("status is invalid")
	}
	if !allowed(in.Strategy, []string{"shared_only", "hybrid", "dedicated_only"}) {
		return fmt.Errorf("strategy is invalid")
	}
	if in.MaxDedicatedPercentageBP == 0 {
		in.MaxDedicatedPercentageBP = 10000
	}
	if in.DedicatedPercentageBP < 0 || in.DedicatedPercentageBP > 10000 || in.MaxDedicatedPercentageBP < 0 || in.MaxDedicatedPercentageBP > 10000 {
		return fmt.Errorf("percentage basis points must be 0..10000")
	}
	if in.DedicatedPercentageBP > in.MaxDedicatedPercentageBP {
		return fmt.Errorf("dedicated_percentage_bp cannot exceed max_dedicated_percentage_bp")
	}
	if in.WarmupRules == nil {
		in.WarmupRules = map[string]any{"source": "dedicated_ip_assignments + domain_warmup_plans"}
	}
	return nil
}

func hydrateRouting(in *RoutingPolicy) {
	if in == nil {
		return
	}
	dedicated := in.DedicatedPercentageBP
	switch in.Strategy {
	case "shared_only":
		dedicated = 0
	case "dedicated_only":
		dedicated = 10000
	}
	if dedicated > in.MaxDedicatedPercentageBP {
		dedicated = in.MaxDedicatedPercentageBP
	}
	in.EffectiveDedicatedPercent = float64(dedicated) / 100
	in.EffectiveSharedPercent = float64(10000-dedicated) / 100
}

func hydrateEntitlement(in *Entitlement) {
	if in == nil {
		return
	}
	in.InboxTestsRemaining = max(0, in.InboxTestsMonthly-in.InboxTestsUsed)
	in.RenderPreviewsRemaining = max(0, in.RenderPreviewsMonthly-in.RenderPreviewsUsed)
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

// notConfigured names the absent per-workspace policy row behind a 404.
//
// The three singleton reads (click tracking, IP routing, inbox-test
// allowance) answer from a row the workspace creates with its PUT. Until
// then the store is deployed and healthy — domain-setups answers 200 from
// the same pool — and only that row is missing. A bare `not_found` with an
// empty message told clients nothing, so every dashboard rendered it as
// "Evidence could not be verified" with a Retry that could never succeed.
// The code says which policy is unset; the status stays 404 so existing
// clients keep their behaviour.
type notConfigured struct {
	code    string
	message string
}

var (
	clickTrackingNotConfigured = notConfigured{
		code:    "click_tracking_not_configured",
		message: "No click-tracking domain has been set up for this workspace.",
	}
	ipRoutingNotConfigured = notConfigured{
		code:    "ip_routing_not_configured",
		message: "No IP routing policy has been set up for this workspace; sending uses its default pool assignment.",
	}
	inboxTestAllowanceNotConfigured = notConfigured{
		code:    "inbox_test_allowance_not_configured",
		message: "No inbox-test allowance is recorded for this workspace's current billing period.",
	}
)

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, err error, absent notConfigured) {
	if errors.Is(err, ErrNotFound) {
		httperror.Write(w, http.StatusNotFound, absent.code, absent.message)
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func allowed(value string, candidates []string) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
