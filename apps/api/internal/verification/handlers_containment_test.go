// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type readTrackingBody struct {
	reader *strings.Reader
	reads  int
}

func (b *readTrackingBody) Read(p []byte) (int, error) {
	b.reads++
	return b.reader.Read(p)
}

func TestCreateJobFailsClosedBeforeBodyStoreOrRunnerWork(t *testing.T) {
	body := &readTrackingBody{reader: strings.NewReader(
		`{"source":"inline","emails":["billable@example.com"]}`,
	)}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verification/jobs", body)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "71000000-0000-4000-8000-000000000001",
	}))
	rec := httptest.NewRecorder()

	// Store is intentionally nil: any persistence call would panic. Runner is
	// intentionally present to prove composition alone never enables creation.
	d := &Deps{Runner: &Runner{}}
	d.createJob(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body = %s", rec.Code, rec.Body.String())
	}
	if body.reads != 0 {
		t.Fatalf("request body was read %d time(s) while capability was disabled", body.reads)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", got)
	}
	if got := rec.Header().Get("X-Postwave-Capability-Status"); got != "unavailable" {
		t.Fatalf("capability status = %q, want unavailable", got)
	}

	var envelope struct {
		Error struct {
			Code          string `json:"code"`
			Capability    string `json:"capability"`
			RuntimeStatus string `json:"runtime_status"`
			Retryable     bool   `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	if envelope.Error.Code != "verification_bulk_unavailable" ||
		envelope.Error.Capability != "verification_bulk_jobs" ||
		envelope.Error.RuntimeStatus != "unavailable" ||
		envelope.Error.Retryable {
		t.Fatalf("unexpected capability response: %+v", envelope.Error)
	}
}

func TestCreateJobRequiresOneBoundedIdempotencyKeyBeforeBillableWork(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values []string
		code   string
	}{
		{name: "missing", code: "idempotency_key_required"},
		{name: "duplicate", values: []string{"first", "second"}, code: "idempotency_key_required"},
		{name: "control", values: []string{"unsafe\nkey"}, code: "invalid_idempotency_key"},
		{name: "too long", values: []string{strings.Repeat("x", 256)}, code: "invalid_idempotency_key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &readTrackingBody{reader: strings.NewReader(
				`{"source":"inline","emails":["billable@example.com"]}`,
			)}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/verification/jobs", body)
			for _, value := range tc.values {
				req.Header.Add("Idempotency-Key", value)
			}
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
				ID: "71000000-0000-4000-8000-000000000001",
			}))
			rec := httptest.NewRecorder()
			(&Deps{BulkJobCreationEnabled: true}).createJob(rec, req)
			if rec.Code < 400 || rec.Code >= 500 || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("status=%d body=%s, want 4xx %s", rec.Code, rec.Body.String(), tc.code)
			}
			if body.reads != 0 {
				t.Fatalf("body read %d time(s) before idempotency validation", body.reads)
			}
		})
	}
}

func TestSynchronousVerificationRequiresOneBoundedIdempotencyKeyBeforeBillableWork(t *testing.T) {
	for _, endpoint := range []struct {
		name string
		path string
		run  func(*Deps, http.ResponseWriter, *http.Request)
	}{
		{name: "single", path: "/api/v1/verification/verify", run: (*Deps).verifyOne},
		{name: "batch", path: "/api/v1/verification/verify-batch", run: (*Deps).verifyBatch},
	} {
		for _, tc := range []struct {
			name   string
			values []string
			code   string
		}{
			{name: "missing", code: "idempotency_key_required"},
			{name: "duplicate", values: []string{"first", "second"}, code: "idempotency_key_required"},
			{name: "control", values: []string{"unsafe\nkey"}, code: "invalid_idempotency_key"},
			{name: "too long", values: []string{strings.Repeat("x", 256)}, code: "invalid_idempotency_key"},
		} {
			t.Run(endpoint.name+"/"+tc.name, func(t *testing.T) {
				body := &readTrackingBody{reader: strings.NewReader(`{"email":"billable@example.com","emails":["billable@example.com"]}`)}
				req := httptest.NewRequest(http.MethodPost, endpoint.path, body)
				for _, value := range tc.values {
					req.Header.Add("Idempotency-Key", value)
				}
				rec := httptest.NewRecorder()
				endpoint.run(&Deps{}, rec, req)
				if rec.Code < 400 || rec.Code >= 500 || !strings.Contains(rec.Body.String(), tc.code) {
					t.Fatalf("status=%d body=%s, want 4xx %s", rec.Code, rec.Body.String(), tc.code)
				}
				if body.reads != 0 {
					t.Fatalf("body read %d time(s) before idempotency validation", body.reads)
				}
			})
		}
	}
}

func TestSynchronousVerificationRejectsRawControlsBeforeProviderWork(t *testing.T) {
	t.Parallel()
	for _, control := range []string{
		"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f",
	} {
		if err := validateSynchronousVerifyEmails(
			[]string{"person@example.com" + control},
		); err == nil {
			t.Errorf("accepted trailing control %q", control)
		}
	}
	if err := validateSynchronousVerifyEmails([]string{
		" person@example.com ", "not-yet-syntax-checked",
	}); err != nil {
		t.Fatalf("rejected bounded control-free verification input: %v", err)
	}
	if err := validateSynchronousVerifyEmails(
		[]string{strings.Repeat("a", maxJobEmailBytes+1)},
	); err == nil {
		t.Fatal("accepted an address above the wire limit")
	}
}

func TestCacheInvalidationRejectsResourceAndUnicodeAbuseBeforeDatabaseWork(t *testing.T) {
	overLimit := make([]string, MaxCacheInvalidationAddresses+1)
	for i := range overLimit {
		overLimit[i] = fmt.Sprintf("u%d@example.com", i)
	}
	for _, tc := range []struct {
		name string
		body any
		code string
	}{
		{name: "too many", body: map[string]any{"emails": overLimit}, code: "batch_too_large"},
		{name: "unsafe format", body: map[string]any{"emails": []string{"reader@example.com\u202e"}}, code: "invalid_email_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := httptest.NewRequest(http.MethodDelete, "/api/v1/verification/cache", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
				ID: "71000000-0000-4000-8000-000000000001",
			}))
			rec := httptest.NewRecorder()
			(&Deps{Store: &Store{}}).invalidateCache(rec, req)
			if rec.Code < 400 || rec.Code >= 500 || !strings.Contains(rec.Body.String(), tc.code) {
				t.Fatalf("status=%d body=%s, want 4xx %s", rec.Code, rec.Body.String(), tc.code)
			}
		})
	}
}

func TestProviderPartialOutcomeIsAReplayableConflict(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verification/verify-batch", nil)
	rec := httptest.NewRecorder()
	(&Deps{}).writeProviderError(rec, req, ErrProviderPartialOutcome)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409 so the shared idempotency ledger retains the ambiguous outcome", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "verification_provider_outcome_ambiguous") {
		t.Fatalf("body=%s, want explicit ambiguity code", rec.Body.String())
	}
}

func TestSynchronousDispatchMarksUncertainProviderFailureAmbiguous(t *testing.T) {
	chain := &Chain{
		Local:                  localStub(nil),
		Vendor:                 &fakeVerifier{name: ProviderKickbox, err: ErrProviderUnavailable},
		DegradeOnVendorFailure: true,
	}
	_, _, err := verifyWithDispatchSafety(context.Background(), chain, []string{"person@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("error=%v, want partial + unavailable markers", err)
	}
}

func TestSynchronousDispatchPreservesProvenPreChargeRejection(t *testing.T) {
	chain := &Chain{
		Local:  localStub(nil),
		Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrNoCredits},
	}
	_, _, err := verifyWithDispatchSafety(context.Background(), chain, []string{"person@example.com"})
	if !errors.Is(err, ErrNoCredits) || errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("error=%v, want only the proven no-credit rejection", err)
	}
}

func TestSynchronousDispatchPreservesAmbiguousAccountRejectionWithoutGuessing(t *testing.T) {
	chain := &Chain{
		Local:  localStub(nil),
		Vendor: &fakeVerifier{name: ProviderZeroBounce, err: ErrProviderAccountRejected},
	}
	_, _, err := verifyWithDispatchSafety(context.Background(), chain, []string{"person@example.com"})
	if !errors.Is(err, ErrProviderAccountRejected) || errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("error=%v, want only the explicit non-billable account rejection", err)
	}
	if errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error=%v guessed quota or credential state", err)
	}
}

func TestSynchronousDispatchMarksPostVendorCacheFailureAmbiguous(t *testing.T) {
	cache := newMemCache()
	cache.putErr = errors.New("private cache write canary")
	chain := &Chain{Local: localStub(nil), Vendor: vendorStub(nil), Cache: cache}

	_, stats, err := verifyWithDispatchSafety(context.Background(), chain, []string{"person@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrCacheUnavailable) {
		t.Fatalf("error=%v, want partial + cache-unavailable markers", err)
	}
	if stats.CreditsSpent != 1 {
		t.Fatalf("stats=%+v, want the provider credit retained in accounting evidence", stats)
	}
	if strings.Contains(err.Error(), "private cache write canary") {
		t.Fatalf("error exposed raw cache detail: %v", err)
	}
}

func TestSynchronousCacheReadFailureBeforeDispatchRemainsRetrySafe(t *testing.T) {
	cache := newMemCache()
	cache.getErr = errors.New("private cache read canary")
	vendor := vendorStub(nil)
	chain := &Chain{Local: localStub(nil), Vendor: vendor, Cache: cache}

	_, _, err := verifyWithDispatchSafety(context.Background(), chain, []string{"person@example.com"})
	if !errors.Is(err, ErrCacheUnavailable) || errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("error=%v, want pre-dispatch cache failure without partial marker", err)
	}
	if vendor.callCount != 0 {
		t.Fatalf("vendor calls=%d after cache read failure, want zero", vendor.callCount)
	}
}

func TestSynchronousLocalTerminalCacheWriteFailureRemainsPreDispatch(t *testing.T) {
	cache := newMemCache()
	cache.putErr = errors.New("private cache write canary")
	vendor := vendorStub(nil)
	chain := &Chain{
		Local: localStub(map[string]Result{
			"junk@mailinator.com": {Status: StatusDoNotMail, SubStatus: SubStatusDisposable},
		}),
		Vendor: vendor,
		Cache:  cache,
	}

	results, stats, err := verifyWithDispatchSafety(
		context.Background(), chain, []string{"junk@mailinator.com"})
	if !errors.Is(err, ErrCacheUnavailable) || errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("error=%v, want pre-dispatch cache failure without partial marker", err)
	}
	if results != nil || stats.LocalFiltered != 1 {
		t.Fatalf("results=%+v stats=%+v, want a failed closed local attempt", results, stats)
	}
	if vendor.callCount != 0 {
		t.Fatalf("vendor calls=%d after local terminal result, want zero", vendor.callCount)
	}
}

func TestSynchronousUsagePersistenceFailureReturnsReplayFencedConflict(t *testing.T) {
	const canary = "usage SQLSTATE canary containing person@example.com"
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verification/verify",
		strings.NewReader(`{"email":"malformed"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "usage-failure-test")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "71000000-0000-4000-8000-000000000001",
	}))
	rec := httptest.NewRecorder()
	called := false
	d := &Deps{
		Store: &Store{},
		recordUsageOverride: func(_ context.Context, tenantID, provider string, stats ChainStats) error {
			called = true
			if tenantID == "" || provider != ProviderLocal || stats.Total != 1 {
				t.Fatalf("usage call tenant=%q provider=%q stats=%+v", tenantID, provider, stats)
			}
			return errors.New(canary)
		},
	}

	d.verifyOne(rec, req)
	if !called {
		t.Fatal("successful verification did not attempt usage persistence")
	}
	if rec.Code != http.StatusConflict ||
		!strings.Contains(rec.Body.String(), "verification_usage_outcome_ambiguous") {
		t.Fatalf("status=%d body=%s, want replay-fenced usage conflict", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), canary) || strings.Contains(rec.Body.String(), "person@example.com") {
		t.Fatalf("response exposed raw usage persistence detail: %s", rec.Body.String())
	}
}
