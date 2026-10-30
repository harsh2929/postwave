// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func executePublicConsentRequest(
	t *testing.T,
	deps *Deps,
	body, key string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/consent",
		strings.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postwave-Site-Key", "pwk_public_consent_test")
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	recorder := httptest.NewRecorder()
	deps.PublicRecord(recorder, req)
	return recorder
}

func countPublicDecisionRows(t *testing.T, deps *Deps, tenantID, decisionID string) int {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), deps.Pool, tenantID)
	if err != nil {
		t.Fatalf("open verification transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)::int
  FROM consent_events
 WHERE tenant_id = $1::uuid
   AND decision_id = $2::uuid`, tenantID, decisionID).Scan(&count); err != nil {
		t.Fatalf("count public decision rows: %v", err)
	}
	return count
}

func countTenantConsentEvents(t *testing.T, deps *Deps, tenantID string) int {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), deps.Pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant event count transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var count int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)::int
  FROM consent_events
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
		t.Fatalf("count tenant consent events: %v", err)
	}
	return count
}

func TestPublicRecordRejectsContradictoryPreferenceEvidenceWithoutWrites(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	deps := &Deps{
		Pool: pool,
		ResolveSiteKey: func(context.Context, string) (string, string, error) {
			return tenantID, "policy-v1", nil
		},
	}

	for _, test := range []struct {
		name string
		body string
	}{
		{name: "accept missing categories", body: `{"visitor_id":"0123456789abcdef","choice":"accept"}`},
		{name: "accept denied category", body: `{"visitor_id":"0123456789abcdef","choice":"accept","prefs":{"analytics":true,"marketing":false}}`},
		{name: "reject granted category", body: `{"visitor_id":"0123456789abcdef","choice":"reject","prefs":{"analytics":true,"marketing":false}}`},
		{name: "gpc granted category without header", body: `{"visitor_id":"0123456789abcdef","choice":"gpc","prefs":{"analytics":false,"marketing":true}}`},
		{name: "essential denied", body: `{"visitor_id":"0123456789abcdef","choice":"reject","prefs":{"essential":false,"analytics":false,"marketing":false}}`},
		{name: "non boolean preference", body: `{"visitor_id":"0123456789abcdef","choice":"reject","prefs":{"analytics":"false","marketing":false}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := executePublicConsentRequest(t, deps, test.body, "invalid-preferences-"+uuid.NewString())
			if response.Code != http.StatusUnprocessableEntity ||
				!strings.Contains(response.Body.String(), "invalid_preferences") {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if got := countTenantConsentEvents(t, deps, tenantID); got != 0 {
		t.Fatalf("contradictory public decisions wrote %d event rows", got)
	}

	// A concurrently received authoritative Sec-GPC signal may race with an
	// already-built accept body. It still overrides both categories before the
	// atomic batch is written.
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(
		`{"visitor_id":"0123456789abcdef","choice":"accept","prefs":{"essential":true,"analytics":true,"marketing":true}}`,
	))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postwave-Site-Key", "pwk_public_consent_test")
	req.Header.Set("Idempotency-Key", "gpc-race-"+uuid.NewString())
	req.Header.Set("Sec-GPC", "1")
	recorder := httptest.NewRecorder()
	deps.PublicRecord(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("authoritative GPC race status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if got := countTenantConsentEvents(t, deps, tenantID); got != 3 {
		t.Fatalf("authoritative GPC batch rows=%d, want 3", got)
	}
}

func TestPublicRecordKeyedBatchIsAtomicReplayableAndConflictSafe(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	deps := &Deps{
		Pool: pool,
		ResolveSiteKey: func(context.Context, string) (string, string, error) {
			return tenantID, "policy-original", nil
		},
	}
	body := `{"visitor_id":"0123456789abcdef","choice":"custom","prefs":{"essential":true,"analytics":true,"marketing":false}}`
	key := "public-consent-" + uuid.NewString()

	first := executePublicConsentRequest(t, deps, body, key)
	if first.Code != http.StatusAccepted {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	if first.Header().Get("Idempotent-Replayed") != "" {
		t.Fatalf("first request marked as replay: %q", first.Header().Get("Idempotent-Replayed"))
	}
	var original PublicConsentResponse
	if err := json.Unmarshal(first.Body.Bytes(), &original); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	if !original.Idempotent || original.Written != 3 || original.DecisionID == "" ||
		original.IdempotencyKey != key ||
		original.EventIDs.Essential == "" || original.EventIDs.Analytics == "" ||
		original.EventIDs.Marketing == "" || original.LastID != original.EventIDs.Marketing {
		t.Fatalf("incomplete first response: %+v", original)
	}
	if got := countPublicDecisionRows(t, deps, tenantID, original.DecisionID); got != 3 {
		t.Fatalf("atomic decision row count=%d, want 3", got)
	}

	// Change volatile server inputs between attempts. The exact retry remains a
	// replay because policy resolver state and user-agent are deliberately not
	// part of the stable client fingerprint.
	deps.ResolveSiteKey = func(context.Context, string) (string, string, error) {
		return tenantID, "policy-changed-after-first-attempt", nil
	}
	replayReq := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(body))
	replayReq.Header.Set("Content-Type", "application/json")
	replayReq.Header.Set("X-Postwave-Site-Key", "pwk_public_consent_test")
	replayReq.Header.Set("Idempotency-Key", key)
	replayReq.Header.Set("User-Agent", "a completely different retry agent")
	replay := httptest.NewRecorder()
	deps.PublicRecord(replay, replayReq)
	if replay.Code != http.StatusAccepted || replay.Header().Get("Idempotent-Replayed") != "true" {
		t.Fatalf("replay status=%d replay=%q body=%s", replay.Code, replay.Header().Get("Idempotent-Replayed"), replay.Body.String())
	}
	if replay.Body.String() != first.Body.String() {
		t.Fatalf("replay body changed\nfirst:  %s\nreplay: %s", first.Body.String(), replay.Body.String())
	}
	if got := countPublicDecisionRows(t, deps, tenantID, original.DecisionID); got != 3 {
		t.Fatalf("replay appended rows: count=%d", got)
	}

	conflict := executePublicConsentRequest(t, deps,
		`{"visitor_id":"0123456789abcdef","choice":"reject","prefs":{"essential":true,"analytics":false,"marketing":false}}`, key)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "idempotency_key_conflict") {
		t.Fatalf("conflict status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	if got := countPublicDecisionRows(t, deps, tenantID, original.DecisionID); got != 3 {
		t.Fatalf("conflict mutated batch: count=%d", got)
	}
}

func TestPublicRecordSerializesConcurrentSameKeyAttempts(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	deps := &Deps{
		Pool: pool,
		ResolveSiteKey: func(context.Context, string) (string, string, error) {
			return tenantID, "policy-v1", nil
		},
	}
	body := `{"visitor_id":"fedcba9876543210","choice":"accept","prefs":{"essential":true,"analytics":true,"marketing":true}}`
	key := "public-consent-concurrent-" + uuid.NewString()

	const attempts = 6
	responses := make([]*httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range responses {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			responses[index] = executePublicConsentRequest(t, deps, body, key)
		}(i)
	}
	close(start)
	wg.Wait()

	var canonical string
	var decisionID string
	firstWrites := 0
	for index, response := range responses {
		if response.Code != http.StatusAccepted {
			t.Fatalf("attempt %d: status=%d body=%s", index, response.Code, response.Body.String())
		}
		if canonical == "" {
			canonical = response.Body.String()
			var parsed PublicConsentResponse
			if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
				t.Fatalf("attempt %d decode: %v", index, err)
			}
			decisionID = parsed.DecisionID
		}
		if response.Body.String() != canonical {
			t.Fatalf("attempt %d returned a different response: %s vs %s", index, response.Body.String(), canonical)
		}
		if response.Header().Get("Idempotent-Replayed") == "" {
			firstWrites++
		}
	}
	if firstWrites != 1 {
		t.Fatalf("non-replay responses=%d, want exactly one writer", firstWrites)
	}
	if got := countPublicDecisionRows(t, deps, tenantID, decisionID); got != 3 {
		t.Fatalf("concurrent same-key row count=%d, want 3", got)
	}
}

func TestPublicRecordKeylessCompatibilityIsExplicitlyDeprecated(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	deps := &Deps{
		Pool: pool,
		ResolveSiteKey: func(context.Context, string) (string, string, error) {
			return tenantID, "policy-v1", nil
		},
	}
	response := executePublicConsentRequest(t, deps,
		`{"visitor_id":"abcdef0123456789","choice":"reject"}`, "")
	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Deprecation") != "true" || response.Header().Get("Warning") == "" {
		t.Fatalf("missing keyless deprecation headers: %v", response.Header())
	}
	var parsed PublicConsentResponse
	if err := json.Unmarshal(response.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if parsed.Idempotent || parsed.Written != 3 || parsed.DecisionID == "" {
		t.Fatalf("unexpected keyless response: %+v", parsed)
	}
	if parsed.IdempotencyKey != "" || strings.Contains(response.Body.String(), `"idempotency_key"`) {
		t.Fatalf("keyless response exposed a request binding: %s", response.Body.String())
	}
	if got := countPublicDecisionRows(t, deps, tenantID, parsed.DecisionID); got != 3 {
		t.Fatalf("keyless atomic row count=%d, want 3", got)
	}
}

func TestPublicRecordOmitsUnsafeUserAgentWithoutBlockingPrivacyChoice(t *testing.T) {
	pool := newTrackingTestPool(t)
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)
	deps := &Deps{
		Pool: pool,
		ResolveSiteKey: func(context.Context, string) (string, string, error) {
			return tenantID, "policy-v1", nil
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/consent", strings.NewReader(
		`{"visitor_id":"abcdef0123456789","choice":"reject"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Postwave-Site-Key", "pwk_public_consent_test")
	req.Header.Set("Idempotency-Key", "public-consent-unsafe-ua-"+uuid.NewString())
	req.Header.Set("User-Agent", strings.Repeat("a", maxConsentUserAgentBytes+1))
	recorder := httptest.NewRecorder()
	deps.PublicRecord(recorder, req)
	if recorder.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response PublicConsentResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open verification transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var omitted int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*)::int
  FROM consent_events
 WHERE decision_id = $1::uuid
   AND user_agent IS NULL`, response.DecisionID).Scan(&omitted); err != nil {
		t.Fatalf("verify omitted user agent: %v", err)
	}
	if omitted != 3 {
		t.Fatalf("rows with omitted user agent=%d, want 3", omitted)
	}
}
