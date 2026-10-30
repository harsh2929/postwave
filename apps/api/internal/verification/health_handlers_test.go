// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeHealthReader struct {
	results  []EmailHealth
	err      error
	calls    int
	tenantID string
	emails   []string
}

func (f *fakeHealthReader) Resolve(_ context.Context, tenantID string, emails []string) ([]EmailHealth, error) {
	f.calls++
	f.tenantID = tenantID
	f.emails = append([]string(nil), emails...)
	return append([]EmailHealth(nil), f.results...), f.err
}

func healthRequest(method, target string, body any, tenantID string) (*httptest.ResponseRecorder, *http.Request) {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, target, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if tenantID != "" {
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	}
	return httptest.NewRecorder(), req
}

func TestNormalizeHealthEmailsCanonicalizesAndDeduplicates(t *testing.T) {
	got, duplicates, err := normalizeHealthEmails([]string{
		" Person@Example.COM ", "person@example.com", "other@example.com",
	})
	if err != nil {
		t.Fatalf("normalizeHealthEmails: %v", err)
	}
	if duplicates != 1 {
		t.Fatalf("duplicates = %d, want 1", duplicates)
	}
	if len(got) != 2 || got[0] != "person@example.com" || got[1] != "other@example.com" {
		t.Fatalf("normalized = %v", got)
	}
}

func TestNormalizeHealthEmailsRejectsEveryRawControlBeforeTrimming(t *testing.T) {
	for _, control := range []string{"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f"} {
		t.Run(fmt.Sprintf("U+%04X", []rune(control)[0]), func(t *testing.T) {
			if _, _, err := normalizeHealthEmails([]string{"person@example.com" + control}); err == nil {
				t.Fatalf("normalizeHealthEmails accepted trailing control %q", control)
			}
		})
	}
}

func TestAttachHealthLogsOnlySafeFailureClass(t *testing.T) {
	const (
		emailCanary = "private.health.canary@example.invalid"
		errorCanary = "constraint row contains private.health.canary@example.invalid"
	)
	var logs bytes.Buffer
	d := &Deps{
		Health: &fakeHealthReader{err: errors.New(errorCanary)},
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	}
	got := d.attachHealth(t.Context(), "71000000-0000-4000-8000-000000000001", []Result{{
		Email: emailCanary, Status: StatusValid, CheckedAt: time.Now().UTC(),
	}})
	if len(got) != 1 || got[0].Health == nil || got[0].Health.EvidenceComplete {
		t.Fatalf("attachHealth fallback = %+v, want one incomplete fail-closed result", got)
	}
	logged := logs.String()
	if strings.Contains(logged, errorCanary) || strings.Contains(logged, emailCanary) {
		t.Fatalf("recipient PII escaped into health failure log: %q", logged)
	}
	if !strings.Contains(logged, "cause=evidence_read_failed") {
		t.Fatalf("safe failure class missing from log: %q", logged)
	}
}

func TestGetHealthReturnsExplicitContractAndNoStore(t *testing.T) {
	tenantID := "71000000-0000-4000-8000-000000000001"
	now := time.Date(2026, 8, 13, 9, 0, 0, 0, time.UTC)
	score := 9
	fake := &fakeHealthReader{results: []EmailHealth{{
		Email: "person@example.com", Grade: HealthGrade("F"),
		Recommendation: HealthRecommendation("blocked"), HardStop: true, SendEligible: false,
		ReasonCodes: []string{"suppression_hard_bounce"},
		Evidence: []HealthEvidence{{
			Kind: HealthEvidenceKind("hard_bounce"), At: now, Source: "subscriber_events",
			ReasonCode: "event_bounced_hard",
		}},
		EvidenceAt: timePtr(now), Status: StatusInvalid, Score: &score,
		Provider: ProviderZeroBounce, CheckedAt: timePtr(now.Add(-time.Hour)),
		ModelVersion: HealthModelVersion, ComputedAt: now,
	}}}
	d := &Deps{Store: &Store{}, Health: fake}
	rec, req := healthRequest(http.MethodGet,
		"/api/v1/verification/health?email=%20Person@Example.COM%20", nil, tenantID)
	d.getHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if fake.tenantID != tenantID || len(fake.emails) != 1 || fake.emails[0] != "person@example.com" {
		t.Fatalf("reader received tenant=%q emails=%v", fake.tenantID, fake.emails)
	}

	var got EmailHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode contract: %v; body=%s", err, rec.Body.String())
	}
	if got.Grade != HealthGrade("F") || got.Recommendation != HealthRecommendation("blocked") ||
		!got.HardStop || got.SendEligible || got.ModelVersion != HealthModelVersion {
		t.Fatalf("unexpected health contract: %+v", got)
	}
	if got.Status != StatusInvalid || got.Score == nil || *got.Score != score || got.Provider != ProviderZeroBounce {
		t.Fatalf("verification provenance missing: %+v", got)
	}
}

func timePtr(value time.Time) *time.Time { return &value }

func TestHealthBatchReturnsClosedGradeSummaryAndDuplicateCount(t *testing.T) {
	tenantID := "71000000-0000-4000-8000-000000000001"
	fake := &fakeHealthReader{results: []EmailHealth{
		{Email: "a@example.com", Grade: HealthGrade("A"), ModelVersion: HealthModelVersion},
		{Email: "b@example.com", Grade: HealthGrade("U"), ModelVersion: HealthModelVersion},
	}}
	d := &Deps{Store: &Store{}, Health: fake}
	rec, req := healthRequest(http.MethodPost, "/api/v1/verification/health/batch", map[string]any{
		"emails": []string{"A@example.com", "a@example.com", "b@example.com"},
	}, tenantID)
	d.healthBatch(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Summary      map[string]int `json:"summary"`
		Total        int            `json:"total"`
		Duplicates   int            `json:"duplicates"`
		ModelVersion string         `json:"model_version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Total != 2 || got.Duplicates != 1 || got.ModelVersion != HealthModelVersion {
		t.Fatalf("batch metadata = %+v", got)
	}
	if len(got.Summary) != 6 || got.Summary["A"] != 1 || got.Summary["U"] != 1 || got.Summary["F"] != 0 {
		t.Fatalf("summary = %v", got.Summary)
	}
}

func TestHealthHandlersContainTenantAndInternalErrors(t *testing.T) {
	const canary = "postgres://secret@private.internal:5432/tenant"
	fake := &fakeHealthReader{err: errors.New(canary)}
	d := &Deps{Store: &Store{}, Health: fake}

	// No tenant means no read is attempted.
	rec, req := healthRequest(http.MethodGet,
		"/api/v1/verification/health?email=person@example.com", nil, "")
	d.getHealth(rec, req)
	if rec.Code != http.StatusUnauthorized || fake.calls != 0 {
		t.Fatalf("tenantless request status=%d calls=%d", rec.Code, fake.calls)
	}

	// A storage failure is logged server-side but its raw value is not exposed.
	rec, req = healthRequest(http.MethodGet,
		"/api/v1/verification/health?email=person@example.com", nil,
		"71000000-0000-4000-8000-000000000001")
	d.getHealth(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d; body = %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), canary) || strings.Contains(rec.Body.String(), "private.internal") {
		t.Fatalf("internal error leaked: %s", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q on error", got)
	}
}

func TestHealthBatchRejectsOversizeBeforeCallingReader(t *testing.T) {
	fake := &fakeHealthReader{}
	d := &Deps{Store: &Store{}, Health: fake}
	emails := make([]string, MaxBatch+1)
	for i := range emails {
		emails[i] = "a@example.com"
	}
	rec, req := healthRequest(http.MethodPost, "/api/v1/verification/health/batch",
		map[string]any{"emails": emails}, "71000000-0000-4000-8000-000000000001")
	d.healthBatch(rec, req)
	if rec.Code < 400 || rec.Code >= 500 || fake.calls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", rec.Code, fake.calls, rec.Body.String())
	}
}

func TestHealthRoutesRemainBehindSubscriberReadScope(t *testing.T) {
	fake := &fakeHealthReader{}
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Store: &Store{}, Health: fake})

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/verification/health?email=person@example.com", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code < 400 || rec.Code >= 500 {
		t.Fatalf("unauthenticated route status=%d body=%s", rec.Code, rec.Body.String())
	}
	if fake.calls != 0 {
		t.Fatalf("reader called %d time(s) before scope/tenant authorization", fake.calls)
	}
}
