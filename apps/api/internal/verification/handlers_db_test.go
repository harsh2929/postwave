// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP-surface tests. DB-backed because every handler goes through the
// store; skipped without DATABASE_URL.

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// newHandlerRouter mounts the surface WITHOUT the scope middleware —
// scope enforcement is covered by the routeauth manifest contract, and
// re-testing it here would only assert the middleware library.
func newHandlerRouter(t *testing.T, d *Deps) chi.Router {
	t.Helper()
	// DB handler tests below exercise the enabled legacy behavior explicitly.
	// Production composition remains fail-closed by default.
	d.BulkJobCreationEnabled = true
	r := chi.NewRouter()
	r.Post("/api/v1/verification/verify", d.verifyOne)
	r.Post("/api/v1/verification/verify-batch", d.verifyBatch)
	r.Post("/api/v1/verification/jobs", d.createJob)
	r.Get("/api/v1/verification/jobs", d.listJobs)
	r.Get("/api/v1/verification/jobs/{id}", d.getJob)
	r.Get("/api/v1/verification/jobs/{id}/results", d.jobResults)
	r.Post("/api/v1/verification/jobs/{id}/cancel", d.cancelJob)
	r.Get("/api/v1/verification/providers", d.listProviders)
	r.Put("/api/v1/verification/providers/{provider}", d.putProvider)
	r.Delete("/api/v1/verification/providers/{provider}", d.deleteProvider)
	r.Get("/api/v1/verification/credits", d.credits)
	r.Get("/api/v1/verification/cache", d.cacheSummary)
	r.Delete("/api/v1/verification/cache", d.invalidateCache)
	return r
}

func doJSON(t *testing.T, r chi.Router, tenantID, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if method == http.MethodPost && (path == "/api/v1/verification/verify" ||
		path == "/api/v1/verification/verify-batch" ||
		path == "/api/v1/verification/jobs") {
		req.Header.Set("Idempotency-Key", "verification-test-"+uuid.NewString())
	}
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
}

func TestHandlerVerifyOneWorksWithNoProviderConfigured(t *testing.T) {
	// The free tier is the default. An unconfigured workspace must get
	// a useful answer, not a 412.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return false, "", nil
	}}
	router := newHandlerRouter(t, &Deps{Store: s})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/verify",
		map[string]any{"email": "someone@nope.invalid"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	var got Result
	decodeBody(t, rec, &got)
	if got.Status != StatusInvalid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusInvalid)
	}
	if got.Billable {
		t.Fatal("local-only verification must not be billable")
	}
}

func TestHandlerVerifyOneRejectsMissingEmail(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/verify",
		map[string]any{"email": "   "})
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want a 4xx validation code; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerVerifyBatchReportsMeasuredSavings(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	s.Local = &LocalVerifier{LookupMX: func(context.Context, string) (bool, string, error) {
		return true, "mx.example.com", nil
	}}
	router := newHandlerRouter(t, &Deps{Store: s})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/verify-batch",
		map[string]any{"emails": []string{"junk@mailinator.com", "support@example.com", "real@example.com"}})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}

	var got struct {
		Results []Result       `json:"results"`
		Summary map[string]int `json:"summary"`
		Usage   struct {
			Total         int     `json:"total"`
			LocalFiltered int     `json:"local_filtered"`
			CreditsSpent  int     `json:"credits_spent"`
			CreditsSaved  int     `json:"credits_saved"`
			SavingsRatio  float64 `json:"savings_ratio"`
		} `json:"usage"`
	}
	decodeBody(t, rec, &got)

	if len(got.Results) != 3 {
		t.Fatalf("results = %d, want 3", len(got.Results))
	}
	if got.Usage.LocalFiltered != 0 {
		t.Fatalf("local_filtered = %d, want 0 (built-in disposable and B2B-role signals are advisory)", got.Usage.LocalFiltered)
	}
	if got.Usage.CreditsSpent != 0 {
		t.Fatalf("credits_spent = %d, want 0 with no vendor configured", got.Usage.CreditsSpent)
	}
	if got.Summary["do_not_mail"] != 0 || got.Summary["unknown"] != 3 {
		t.Fatalf("summary = %v", got.Summary)
	}
}

func TestHandlerVerifyBatchRejectsOversizeRequest(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	emails := make([]string, MaxBatch+1)
	for i := range emails {
		emails[i] = "a@example.com"
	}
	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/verify-batch",
		map[string]any{"emails": emails})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "batch_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandlerCreateJobReturns202WithTruthfulTotal(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/jobs",
		map[string]any{"source": "inline", "emails": []string{"a@x.com", "b@x.com", "a@x.com"}})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var job Job
	decodeBody(t, rec, &job)
	if job.Total != 2 {
		t.Fatalf("Total = %d, want 2 after dedup — a progress bar needs a real denominator", job.Total)
	}
	if job.Status != JobStatusPending {
		t.Fatalf("Status = %q", job.Status)
	}
}

func TestHandlerCreateJobRejectsUnsupportedSource(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/jobs",
		map[string]any{"source": "segment", "source_ref": "x"})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx for a source the worker cannot resolve; body = %s",
			rec.Code, rec.Body.String())
	}
}

func TestHandlerCreateJobRejectsEmptyInlineList(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPost, "/api/v1/verification/jobs",
		map[string]any{"source": "inline", "emails": []string{}})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerGetJobIncludesSummaryAndSavings(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	ctx := context.Background()

	job, err := s.CreateJob(ctx, tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com", "junk@mailinator.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	// The tenant-specific disposable override is terminal, unlike the built-in
	// advisory corpus, so the measured local savings are real rather than
	// assumed from a heuristic signal.
	vendor := vendorStub(map[string]Result{"a@example.com": {Status: StatusValid, Billable: true}})
	runner := &Runner{
		Store: s,
		ChainFor: func(context.Context, string) (*Chain, error) {
			return &Chain{
				Local: &LocalVerifier{
					ExtraDisposable: map[string]struct{}{"mailinator.com": {}},
					LookupMX: func(context.Context, string) (bool, string, error) {
						return true, "mx.example.com", nil
					},
				},
				Vendor: vendor,
			}, nil
		},
		BatchSize: 10,
	}
	if err := runner.RunJob(ctx, tenant, job.ID); err != nil {
		t.Fatalf("RunJob: %v", err)
	}

	router := newHandlerRouter(t, &Deps{Store: s})
	rec := doJSON(t, router, tenant, http.MethodGet, "/api/v1/verification/jobs/"+job.ID, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Job          Job            `json:"job"`
		Summary      map[string]int `json:"summary"`
		CreditsSaved int            `json:"credits_saved"`
		IsTerminal   bool           `json:"is_terminal"`
	}
	decodeBody(t, rec, &got)
	if !got.IsTerminal {
		t.Fatalf("is_terminal = false for a %q job", got.Job.Status)
	}
	if got.CreditsSaved != 1 {
		t.Fatalf("credits_saved = %d, want 1 (the tenant-blocked disposable address was free)", got.CreditsSaved)
	}
	if got.Summary["do_not_mail"] != 1 || got.Summary["valid"] != 1 {
		t.Fatalf("summary = %v", got.Summary)
	}
}

func TestHandlerGetJobReturns404ForAnotherTenantsJob(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	s := newStore(t, pool, nil)

	job, err := s.CreateJob(context.Background(), tenantA, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	router := newHandlerRouter(t, &Deps{Store: s})
	rec := doJSON(t, router, tenantB, http.MethodGet, "/api/v1/verification/jobs/"+job.ID, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerJobResultsRejectInvalidStatusFilter(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	router := newHandlerRouter(t, &Deps{Store: s})
	rec := doJSON(t, router, tenant, http.MethodGet,
		"/api/v1/verification/jobs/"+job.ID+"/results?status=made_up", nil)
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
}

func TestHandlerCancelJobReturnsNoContent(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	job, err := s.CreateJob(context.Background(), tenant, JobSpec{
		Source: JobSourceInline, Emails: []string{"a@example.com"},
	})
	if err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	router := newHandlerRouter(t, &Deps{Store: s})
	rec := doJSON(t, router, tenant, http.MethodPost,
		"/api/v1/verification/jobs/"+job.ID+"/cancel", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerPutProviderNeverEchoesASecret(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "zb-primary"): "super-secret-key",
	}}
	s := newStore(t, pool, secrets)
	s.vendorFactory = func(cfg ProviderConfig, _ string) (Verifier, error) {
		return &fakeVerifier{name: cfg.Provider, credits: 321}, nil
	}
	router := newHandlerRouter(t, &Deps{Store: s})

	rec := doJSON(t, router, tenant, http.MethodPut,
		"/api/v1/verification/providers/zerobounce",
		map[string]any{"credential_ref": "zb-primary", "enabled": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "super-secret-key") {
		t.Fatalf("the response echoed the resolved API key: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "zb-primary") {
		t.Fatalf("the opaque credential id should be echoed: %s", rec.Body.String())
	}
}

func TestHandlerPutProviderStagesProbeBeforeReplacingWorkingConfig(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "working-key"): "working-secret",
		mustTenantVerificationSecretName(t, tenant, ProviderZeroBounce, "broken-key"):  "rejected-secret",
	}}
	s := newStore(t, pool, secrets)
	ctx := context.Background()
	if _, err := s.UpsertProvider(ctx, tenant, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "working-key", Enabled: true,
	}); err != nil {
		t.Fatalf("seed working provider: %v", err)
	}
	if err := s.RecordBalance(ctx, tenant, ProviderZeroBounce, 99); err != nil {
		t.Fatalf("seed balance: %v", err)
	}
	s.vendorFactory = func(cfg ProviderConfig, apiKey string) (Verifier, error) {
		if apiKey == "rejected-secret" {
			return &fakeVerifier{
				name:      cfg.Provider,
				creditErr: fmt.Errorf("upstream canary body and https://private.invalid?api_key=rejected-secret: %w", ErrUnauthorized),
			}, nil
		}
		return &fakeVerifier{name: cfg.Provider, credits: 99}, nil
	}
	router := newHandlerRouter(t, &Deps{Store: s})

	rec := doJSON(t, router, tenant, http.MethodPut,
		"/api/v1/verification/providers/zerobounce",
		map[string]any{"credential_ref": "broken-key", "enabled": true})
	if rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412; body = %s", rec.Code, rec.Body.String())
	}
	for _, forbidden := range []string{"upstream canary", "private.invalid", "rejected-secret"} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("response exposed %q: %s", forbidden, rec.Body.String())
		}
	}

	got, err := s.EnabledProvider(ctx, tenant)
	if err != nil {
		t.Fatalf("read provider after rejected proposal: %v", err)
	}
	if got == nil || got.CredentialRef != "working-key" || got.LastBalance == nil || *got.LastBalance != 99 {
		t.Fatalf("rejected proposal changed working config: %+v", got)
	}
}

func TestHandlerPutProviderRejectsTenantURLOverridesBeforeResolution(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{}}
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, secrets)})

	for _, field := range []string{"base_url", "bulk_url"} {
		rec := doJSON(t, router, tenant, http.MethodPut,
			"/api/v1/verification/providers/zerobounce",
			map[string]any{
				"credential_ref": "zb-primary",
				"enabled":        true,
				"settings": map[string]any{
					field: "http://[::ffff:169.254.169.254]:8080/latest/meta-data",
				},
			})
		if rec.Code < 400 || rec.Code >= 500 {
			t.Fatalf("%s status = %d, want 4xx; body = %s", field, rec.Code, rec.Body.String())
		}
	}
	if len(secrets.asked) != 0 {
		t.Fatalf("unsafe endpoint input reached credential resolution: %v", secrets.asked)
	}
}

func TestHandlerPutProviderRejectsUnknownVendor(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPut,
		"/api/v1/verification/providers/sendgrid",
		map[string]any{"credential_ref": "ref-x"})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerPutProviderRejectsBlankCredentialRef(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodPut,
		"/api/v1/verification/providers/kickbox",
		map[string]any{"credential_ref": "  "})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerDeleteProviderReturns404WhenAbsent(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodDelete,
		"/api/v1/verification/providers/kickbox", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerListProvidersAdvertisesAvailableVendors(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodGet, "/api/v1/verification/providers", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Providers []ProviderConfig `json:"providers"`
		Available []string         `json:"available"`
	}
	decodeBody(t, rec, &got)
	if len(got.Available) != 2 {
		t.Fatalf("available = %v, want both configurable vendors", got.Available)
	}
}

func TestHandlerCreditsExplainsTheUnconfiguredCase(t *testing.T) {
	// "No provider" is a legitimate steady state, not an error, and
	// the response should say so rather than 412.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodGet, "/api/v1/verification/credits", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	decodeBody(t, rec, &got)
	if got["provider"] != nil {
		t.Fatalf("provider = %v, want null", got["provider"])
	}
	if _, ok := got["note"]; !ok {
		t.Fatalf("an unconfigured response should explain itself: %v", got)
	}
}

func TestHandlerCreditsRefreshesConfiguredProviderBalance(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	secrets := &fakeSecrets{values: map[string]string{
		mustTenantVerificationSecretName(t, tenant, ProviderKickbox, "kb-primary"): "key",
	}}
	s := newStore(t, pool, secrets)
	s.vendorFactory = func(cfg ProviderConfig, _ string) (Verifier, error) {
		return &fakeVerifier{name: cfg.Provider, credits: 73}, nil
	}
	if _, err := s.UpsertProvider(context.Background(), tenant, ProviderConfig{
		Provider: ProviderKickbox, CredentialRef: "kb-primary", Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}

	rec := doJSON(t, newHandlerRouter(t, &Deps{Store: s}), tenant,
		http.MethodGet, "/api/v1/verification/credits", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Provider string `json:"provider"`
		Balance  *int   `json:"balance"`
	}
	decodeBody(t, rec, &got)
	if got.Provider != ProviderKickbox || got.Balance == nil || *got.Balance != 73 {
		t.Fatalf("credits response = %+v", got)
	}

	cfg, err := s.EnabledProvider(context.Background(), tenant)
	if err != nil {
		t.Fatalf("EnabledProvider: %v", err)
	}
	if cfg == nil || cfg.LastBalance == nil || *cfg.LastBalance != 73 || cfg.LastBalanceAt == nil {
		t.Fatalf("refreshed provider config = %+v", cfg)
	}
}

func TestHandlerInvalidateCacheRefusesAWholesaleWipe(t *testing.T) {
	// Every cached entry cost a credit; there is no safe "clear all"
	// button for something that expensive to rebuild.
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	router := newHandlerRouter(t, &Deps{Store: newStore(t, pool, nil)})

	rec := doJSON(t, router, tenant, http.MethodDelete, "/api/v1/verification/cache",
		map[string]any{"emails": []string{}})
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("status = %d, want a 4xx; body = %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCacheSummaryReportsCounts(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	s := newStore(t, pool, nil)
	if err := (&TenantCache{Store: s, TenantID: tenant, TTL: DefaultCacheTTL}).
		Put(context.Background(), []Result{
			{Email: "a@example.com", Status: StatusValid, Provider: ProviderZeroBounce},
		}); err != nil {
		t.Fatalf("Put: %v", err)
	}

	router := newHandlerRouter(t, &Deps{Store: s})
	rec := doJSON(t, router, tenant, http.MethodGet, "/api/v1/verification/cache", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got CacheSummary
	decodeBody(t, rec, &got)
	if got.Total != 1 || got.ByStatus["valid"] != 1 {
		t.Fatalf("summary = %+v", got)
	}
}
