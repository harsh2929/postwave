// Package handlers wires the deliverability service's HTTP surface.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/services/deliverability/internal/auth"
	"github.com/postwave/postwave/services/deliverability/internal/content"
	"github.com/postwave/postwave/services/deliverability/internal/diagnostician"
	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/predictor"
	"github.com/postwave/postwave/services/deliverability/internal/render"
	"github.com/postwave/postwave/services/deliverability/internal/reputation"
)

const deliverabilityJSONMaxBodyBytes int64 = 1 << 20

var (
	errJSONTooLarge               = errors.New("request body too large")
	errSendingDomainNotConfigured = errors.New("sending domain is not configured")
	errJSONMultipleValues         = errors.New("request body must contain a single JSON value")
)

// CampaignReportStore returns aggregated InboxReports for a campaign.
type CampaignReportStore interface {
	Get(ctx context.Context, tenantID string, campaignID string) (domain.CampaignReport, error)
}

// TenantDomainResolver maps the calling tenant to its primary sending domain
// + IP. In production this comes from the auth/tenant context middleware;
// here we keep it as an interface so handlers stay dependency-light.
type TenantDomainResolver interface {
	Resolve(ctx context.Context, r *http.Request) (domainName, ip, dkimSelector string, err error)
}

// HeaderTenantResolver is the gateway-facing resolver used until tenant
// metadata is read directly from Postgres. apps/api sets these headers after
// tenant auth when proxying deliverability calls.
type HeaderTenantResolver struct{}

func (HeaderTenantResolver) Resolve(ctx context.Context, r *http.Request) (string, string, string, error) {
	domainName := r.Header.Get("X-Sending-Domain")
	ip := r.Header.Get("X-Sending-IP")
	selector := r.Header.Get("X-DKIM-Selector")
	if selector == "" {
		selector = "default"
	}
	if domainName == "" {
		return "", "", "", errSendingDomainNotConfigured
	}
	return domainName, ip, selector, nil
}

// Deps bundles the handler dependencies.
type Deps struct {
	Reports        CampaignReportStore
	Reputation     *reputation.Aggregator
	AuthResolver   auth.Resolver
	Tenant         TenantDomainResolver
	Diagnostician  *diagnostician.Diagnostician
	Predictor      *predictor.Predictor
	ContentScanner *content.Scanner
	Renderer       render.Renderer
	// DMARC exposes the parsed DMARC aggregate-report store to the read-only
	// monitoring routes. Concrete pointer (not an interface) so nil == disabled;
	// the storage is nil on dev/local without DATABASE_URL and every DMARC
	// handler nil-guards it to a 503.
	DMARC *auth.Store
	// ReputationHistory records + serves the reputation trend (INBOX-031).
	// Concrete pointer; nil == disabled (dev/local without DATABASE_URL). The
	// capture in getReputation is best-effort and never fails the response.
	ReputationHistory *reputation.SnapshotStore
}

// Mount attaches all v1 routes to r.
func Mount(r chi.Router, d Deps) {
	r.Get("/v1/inbox-reality/campaigns/{id}", d.getCampaignReport)
	r.Get("/v1/reputation", d.getReputation)
	r.Get("/v1/reputation/history", d.getReputationHistory)
	r.Get("/v1/auth-checks", d.getAuthChecks)
	r.Get("/v1/dmarc/reports", d.getDMARCReports)
	r.Get("/v1/dmarc/reports/{id}", d.getDMARCReport)
	r.Get("/v1/dmarc/stats", d.getDMARCStats)
	r.Post("/v1/diagnose/{campaign_id}", d.postDiagnose)
	r.Post("/v1/predict", d.postPredict)
	r.Post("/v1/render", d.postRender)
}

func (d Deps) getCampaignReport(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if d.Reports == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("report store not configured"))
		return
	}
	rep, err := d.Reports.Get(r.Context(), reportTenantID(r), id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func reportTenantID(r *http.Request) string {
	if r == nil {
		return ""
	}
	if v := r.Header.Get("X-Tenant-ID"); v != "" {
		return v
	}
	return r.Header.Get("X-Postwave-Tenant-ID")
}

// atoiDefault parses a query-param int, falling back to def on empty/garbage.
// ListReports/Stats re-clamp, so out-of-range values are harmless.
func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// getDMARCReports lists parsed DMARC aggregate reports for the calling tenant,
// newest first. ?limit / ?offset paginate (ListReports re-clamps).
func (d Deps) getDMARCReports(w http.ResponseWriter, r *http.Request) {
	if d.DMARC == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("dmarc storage not configured"))
		return
	}
	tenantID := reportTenantID(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, errMsg("tenant required"))
		return
	}
	q := r.URL.Query()
	limit := atoiDefault(q.Get("limit"), 50)
	offset := atoiDefault(q.Get("offset"), 0)
	reports, err := d.DMARC.ListReports(r.Context(), tenantID, limit, offset)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, reports)
}

// getDMARCReport returns one report plus its per-source-IP records. Any lookup
// error (not-found or bad UUID cast) maps to 404.
func (d Deps) getDMARCReport(w http.ResponseWriter, r *http.Request) {
	if d.DMARC == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("dmarc storage not configured"))
		return
	}
	tenantID := reportTenantID(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, errMsg("tenant required"))
		return
	}
	detail, err := d.DMARC.GetReport(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

// getDMARCStats returns aggregate pass/fail counters over a bounded window
// (default: the last 30 days; ?since=RFC3339 or ?days=N to widen).
func (d Deps) getDMARCStats(w http.ResponseWriter, r *http.Request) {
	if d.DMARC == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("dmarc storage not configured"))
		return
	}
	tenantID := reportTenantID(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, errMsg("tenant required"))
		return
	}
	q := r.URL.Query()
	since := time.Now().UTC().Add(-30 * 24 * time.Hour)
	if v := q.Get("since"); v != "" {
		parsed, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errMsg("invalid since (want RFC3339): "+err.Error()))
			return
		}
		since = parsed
	} else if v := q.Get("days"); v != "" {
		since = time.Now().UTC().AddDate(0, 0, -atoiDefault(v, 30))
	}
	stats, err := d.DMARC.Stats(r.Context(), tenantID, since)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (d Deps) getReputation(w http.ResponseWriter, r *http.Request) {
	if d.Tenant == nil || d.Reputation == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("reputation pipeline not configured"))
		return
	}
	dom, ip, _, err := d.Tenant.Resolve(r.Context(), r)
	if err != nil {
		writeTenantDomainError(w, err)
		return
	}
	rep, err := d.Reputation.Fetch(r.Context(), dom, ip)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	// INBOX-031: record a trend point. Best-effort — a storage error must never
	// fail the reputation response (the live snapshot is still returned).
	if d.ReputationHistory != nil {
		if tid := reportTenantID(r); tid != "" {
			_ = d.ReputationHistory.Record(r.Context(), tid, rep)
		}
	}
	writeJSON(w, http.StatusOK, rep)
}

// getReputationHistory GET /v1/reputation/history — the reputation trend
// (INBOX-031). ?since=RFC3339 or ?days=N bound the window (default 90 days).
func (d Deps) getReputationHistory(w http.ResponseWriter, r *http.Request) {
	if d.ReputationHistory == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("reputation history not configured"))
		return
	}
	tenantID := reportTenantID(r)
	if tenantID == "" {
		writeJSON(w, http.StatusUnauthorized, errMsg("tenant required"))
		return
	}
	q := r.URL.Query()
	since := time.Now().UTC().Add(-90 * 24 * time.Hour)
	if v := q.Get("since"); v != "" {
		parsed, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errMsg("invalid since (want RFC3339): "+err.Error()))
			return
		}
		since = parsed
	} else if v := q.Get("days"); v != "" {
		since = time.Now().UTC().AddDate(0, 0, -atoiDefault(v, 90))
	}
	snaps, err := d.ReputationHistory.History(r.Context(), tenantID, since, atoiDefault(q.Get("limit"), 200))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"snapshots": snaps})
}

// Missing workspace configuration is not a failed user session. In
// particular, a 401 here makes API clients redirect a signed-in user to login.
func writeTenantDomainError(w http.ResponseWriter, err error) {
	if errors.Is(err, errSendingDomainNotConfigured) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": map[string]string{
				"code":    "sending_domain_not_configured",
				"message": "Set up a sending domain to check authentication and reputation.",
			},
		})
		return
	}
	writeJSON(w, http.StatusUnauthorized, errMsg(err.Error()))
}

func (d Deps) getAuthChecks(w http.ResponseWriter, r *http.Request) {
	if d.Tenant == nil || d.AuthResolver == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("auth pipeline not configured"))
		return
	}
	dom, ip, sel, err := d.Tenant.Resolve(r.Context(), r)
	if err != nil {
		writeTenantDomainError(w, err)
		return
	}
	ctx := r.Context()
	dmarcRec, _ := auth.CheckDMARC(ctx, d.AuthResolver, dom)
	check := domain.AuthCheck{
		Domain: dom,
		SPF:    auth.CheckSPF(ctx, d.AuthResolver, dom),
		DKIM:   auth.CheckDKIM(ctx, d.AuthResolver, dom, sel),
		DMARC:  dmarcRec,
		BIMI:   auth.CheckBIMI(ctx, d.AuthResolver, dom),
		PTR:    auth.CheckPTR(ctx, d.AuthResolver, ip, dom),
	}
	writeJSON(w, http.StatusOK, []domain.AuthCheck{check})
}

func (d Deps) postDiagnose(w http.ResponseWriter, r *http.Request) {
	if d.Diagnostician == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("diagnostician not configured"))
		return
	}
	id := chi.URLParam(r, "campaign_id")
	var sig diagnostician.Signals
	if r.Body != nil && r.ContentLength != 0 {
		if err := decodeJSON(w, r, &sig); err != nil {
			writeJSON(w, decodeJSONStatusCode(err), errMsg("invalid signals payload: "+err.Error()))
			return
		}
	}
	if sig.CampaignID == "" {
		sig.CampaignID = id
	}
	if !sig.HasEvidence() {
		writeJSON(w, http.StatusUnprocessableEntity,
			errMsg("at least one verified auth, reputation, content, or placement signal is required"))
		return
	}
	dia, err := d.Diagnostician.Diagnose(r.Context(), sig, sig.CampaignID)
	if err != nil {
		if errors.Is(err, diagnostician.ErrLLMNotWired) {
			writeJSON(w, http.StatusServiceUnavailable, errMsg(err.Error()))
			return
		}
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, dia)
}

type predictBody struct {
	HTML       string                         `json:"html"`
	Subject    string                         `json:"subject"`
	Reputation domain.Reputation              `json:"reputation"`
	History    predictor.HistoricalEngagement `json:"history"`
	Auth       *domain.AuthCheck              `json:"auth,omitempty"`
	Links      []string                       `json:"links"`
}

func (d Deps) postPredict(w http.ResponseWriter, r *http.Request) {
	if d.Predictor == nil || d.ContentScanner == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("predictor not configured"))
		return
	}
	var body predictBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeJSON(w, decodeJSONStatusCode(err), errMsg("invalid body: "+err.Error()))
		return
	}
	scan := d.ContentScanner.Scan(r.Context(), body.HTML, body.Subject, body.Links)
	pp, breakdown, err := d.Predictor.PredictWithAuth(r.Context(), scan, body.Reputation, body.History, body.Auth)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Predicted domain.PredictedPlacement `json:"predicted"`
		Content   domain.ContentScan        `json:"content"`
		Risk      predictor.RiskBreakdown   `json:"risk"`
		At        time.Time                 `json:"at"`
	}{Predicted: pp, Content: scan, Risk: breakdown, At: time.Now()})
}

type renderBody struct {
	HTML         string   `json:"html"`
	Environments []string `json:"environments,omitempty"`
}

type renderResponse struct {
	Renders  []render.Render `json:"renders"`
	CacheHit bool            `json:"cache_hit"`
	// These are browser/CSS approximations, never captures from mailbox apps.
	RenderMode string `json:"render_mode"`
}

func (d Deps) postRender(w http.ResponseWriter, r *http.Request) {
	if d.Renderer == nil {
		writeJSON(w, http.StatusServiceUnavailable, errMsg("renderer not configured"))
		return
	}
	var body renderBody
	if err := decodeJSON(w, r, &body); err != nil {
		writeJSON(w, decodeJSONStatusCode(err), errMsg("invalid body: "+err.Error()))
		return
	}
	if body.HTML == "" {
		writeJSON(w, http.StatusBadRequest, errMsg("html is required"))
		return
	}

	envs := render.AllEnvironments
	if len(body.Environments) > 0 {
		envs = make([]render.Environment, 0, len(body.Environments))
		for _, name := range body.Environments {
			env, ok := render.LookupEnvironment(name)
			if !ok {
				writeJSON(w, http.StatusBadRequest, errMsg("unknown environment: "+name))
				return
			}
			envs = append(envs, env)
		}
	}

	// Detect cache state *before* rendering so the response flag reflects
	// what actually happened (best-effort — only the HCTI client tracks it).
	cacheHit := false
	if hc, ok := d.Renderer.(*render.HCTIClient); ok {
		cacheHit = true
		for _, e := range envs {
			if !hc.CacheHit(e, body.HTML) {
				cacheHit = false
				break
			}
		}
	}

	out, err := d.Renderer.Render(r.Context(), body.HTML, envs)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, errMsg(err.Error()))
		return
	}
	renderMode := "unverified"
	switch d.Renderer.(type) {
	case *render.HCTIClient:
		renderMode = "simulation"
	case render.MockRenderer, *render.MockRenderer:
		renderMode = "placeholder"
	}
	writeJSON(w, http.StatusOK, renderResponse{Renders: wireRenders(out), CacheHit: cacheHit, RenderMode: renderMode})
}

// wireRenders keeps `renders` and every `issues` a JSON array. Static checks
// return a nil slice for an environment with nothing to report — the common,
// clean case — and a nil slice marshals to null, which the preview client
// rejects as a malformed render for the whole matrix.
func wireRenders(out []render.Render) []render.Render {
	if out == nil {
		return []render.Render{}
	}
	for i := range out {
		if out[i].Issues == nil {
			out[i].Issues = []string{}
		}
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errMsg(s string) map[string]string { return map[string]string{"error": s} }

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, deliverabilityJSONMaxBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("decode json: %w", normalizeDecodeJSONError(err))
	}
	var extra any
	if err := dec.Decode(&extra); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("decode json: %w", normalizeDecodeJSONError(err))
	}
	return errJSONMultipleValues
}

func normalizeDecodeJSONError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return errJSONTooLarge
	}
	return err
}

func decodeJSONStatusCode(err error) int {
	if errors.Is(err, errJSONTooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}
