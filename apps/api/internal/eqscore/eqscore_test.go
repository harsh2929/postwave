// SPDX-License-Identifier: AGPL-3.0-only
package eqscore

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// fixtureRep is a fake Reputation that always returns a fixed stats blob.
type fixtureRep struct {
	stats Last7dStats
	has   bool
	err   error
}

func (f *fixtureRep) Last7d(_ context.Context, _ string) (Last7dStats, bool, error) {
	return f.stats, f.has, f.err
}

// happyInput is a clean message that should score very high. Each test
// that wants to probe a single rule starts from this and mutates one
// field — keeps the test intent obvious.
func happyInput() Input {
	return Input{
		Subject:         "Your weekly digest",
		HTML:            "<p>Hi Alex,</p><p>Here's what shipped this week — three new integrations, two bug fixes, and a deprecation notice. Reply if anything looks off.</p>",
		Text:            "Hi Alex, Here's what shipped this week — three new integrations, two bug fixes, and a deprecation notice. Reply if anything looks off.",
		From:            "team@acme.example",
		VerifiedDomains: []string{"acme.example"},
		DKIMVerified:    true,
		SPFVerified:     true,
		DMARCAligned:    true,
	}
}

func TestScore_HappyPathIsAOrAPlus(t *testing.T) {
	res, err := Score(context.Background(), happyInput(), "tid", nil)
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if res.Grade != "A" && res.Grade != "A+" {
		t.Errorf("happy-path grade = %q (score=%d), want A or A+", res.Grade, res.Score)
	}
}

func TestScore_EmptySubjectFails(t *testing.T) {
	in := happyInput()
	in.Subject = ""
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "subject_empty") {
		t.Errorf("expected subject_empty reason, got reasons=%v", reasonCodes(res))
	}
}

func TestScore_AllCapsSubject(t *testing.T) {
	in := happyInput()
	in.Subject = "BIG NEWS FOR YOU TODAY"
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "subject_all_caps") {
		t.Errorf("expected subject_all_caps reason, got reasons=%v", reasonCodes(res))
	}
	// Short all-caps ("FYI") MUST NOT trip.
	in2 := happyInput()
	in2.Subject = "FYI"
	res2, _ := Score(context.Background(), in2, "tid", nil)
	if hasReason(res2, "subject_all_caps") {
		t.Errorf("'FYI' should not trip all-caps rule")
	}
}

func TestScore_SpammyPhrase(t *testing.T) {
	in := happyInput()
	in.Subject = "Free money for you - act now"
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "subject_spammy_phrase") {
		t.Errorf("expected subject_spammy_phrase, got %v", reasonCodes(res))
	}
}

func TestScore_TrackingOnlyHTMLFlagged(t *testing.T) {
	in := happyInput()
	in.HTML = `<img src="https://track.example/o.gif?id=1" />`
	in.Text = ""
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "tracking_only_html") {
		t.Errorf("expected tracking_only_html, got %v", reasonCodes(res))
	}
}

func TestScore_OrdinaryImageDoesNotClaimTrackingOrSpam(t *testing.T) {
	in := happyInput()
	in.HTML = `<img src="hero.png" alt="New collection">`
	in.Text = ""
	res, _ := Score(context.Background(), in, "tid", nil)
	for _, reason := range res.Content.Reasons {
		if reason.Code != "tracking_only_html" {
			continue
		}
		message := strings.ToLower(reason.Message)
		if !strings.Contains(message, "images are blocked") || strings.Contains(message, "tracking") || strings.Contains(message, "spam") {
			t.Fatalf("image-only heuristic must describe observable content, got %q", reason.Message)
		}
		return
	}
	t.Fatal("expected image-only content warning")
}

func TestScore_ImageHeavy(t *testing.T) {
	in := happyInput()
	// 3 images with surrounding text long enough to clear the
	// tracking-only-HTML threshold (≥10 chars of visible text) but
	// well under the image_heavy threshold (50 chars per image, i.e.
	// 150 chars total for 3 images). The phrase below strips to ~30.
	in.HTML = `<img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><p>Welcome to the digest.</p>`
	in.Text = ""
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "image_heavy") {
		t.Errorf("expected image_heavy, got %v", reasonCodes(res))
	}
	if hasReason(res, "tracking_only_html") {
		t.Errorf("image_heavy fixture must NOT also fire tracking_only_html, got %v", reasonCodes(res))
	}
}

func TestScore_RawIPLinks(t *testing.T) {
	in := happyInput()
	in.Text = "Click http://192.0.2.1/login to verify your account."
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "raw_ip_links") {
		t.Errorf("expected raw_ip_links, got %v", reasonCodes(res))
	}
}

func TestScore_FromEmptyFails(t *testing.T) {
	in := happyInput()
	in.From = ""
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "from_empty") {
		t.Errorf("expected from_empty, got %v", reasonCodes(res))
	}
}

func TestScore_FromMalformedFails(t *testing.T) {
	in := happyInput()
	in.From = "not-an-email"
	res, _ := Score(context.Background(), in, "tid", nil)
	// Either malformed or unverified — both are "fail" severity. We
	// want one of them and the auth sub-score is severely impacted.
	if res.Auth.Score >= 70 {
		t.Errorf("malformed From should slash auth score, got %d", res.Auth.Score)
	}
}

func TestScore_UnverifiedDomainHeavyDeduction(t *testing.T) {
	in := happyInput()
	in.VerifiedDomains = []string{} // none verified
	res, _ := Score(context.Background(), in, "tid", nil)
	if !hasReason(res, "domain_not_verified") {
		t.Errorf("expected domain_not_verified, got %v", reasonCodes(res))
	}
	if res.Auth.Score >= 70 {
		t.Errorf("unverified-domain auth score = %d, want < 70", res.Auth.Score)
	}
}

func TestScoreFailReasonsCapThePersistableGrade(t *testing.T) {
	tests := []struct {
		name string
		in   Input
		rep  Reputation
	}{
		{
			name: "unverified sender cannot be compensated by clean reputation",
			in: func() Input {
				in := happyInput()
				in.VerifiedDomains = nil
				return in
			}(),
			rep: &fixtureRep{
				stats: Last7dStats{Sent: 10_000, Delivered: 10_000},
				has:   true,
			},
		},
		{
			name: "provider-ceiling complaints cannot be compensated",
			in:   happyInput(),
			rep: &fixtureRep{
				stats: Last7dStats{Sent: 10_000, Delivered: 9_950, Complained: 50},
				has:   true,
			},
		},
		{
			name: "critical bounces cannot be compensated",
			in:   happyInput(),
			rep: &fixtureRep{
				stats: Last7dStats{Sent: 10_000, Delivered: 9_400, Bounced: 600},
				has:   true,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := Score(context.Background(), tt.in, "tenant-1", tt.rep)
			if err != nil {
				t.Fatalf("Score: %v", err)
			}
			if result.Score > 59 || result.Grade != "F" {
				t.Fatalf("blocking reason persisted as score=%d grade=%q; reasons=%+v", result.Score, result.Grade, result.Reasons)
			}
			if !reasonsHaveSeverity(result.Reasons, "fail") {
				t.Fatalf("fixture did not produce a fail reason: %+v", result.Reasons)
			}
		})
	}
}

func TestScore_MissingAuthMechanisms(t *testing.T) {
	in := happyInput()
	in.SPFVerified = false
	in.DKIMVerified = false
	in.DMARCAligned = false
	res, _ := Score(context.Background(), in, "tid", nil)
	for _, code := range []string{"spf_missing", "dkim_missing", "dmarc_missing"} {
		if !hasReason(res, code) {
			t.Errorf("missing-auth: expected %s reason, got %v", code, reasonCodes(res))
		}
	}
}

func TestScore_ReputationCriticalComplaint(t *testing.T) {
	rep := &fixtureRep{
		stats: Last7dStats{Sent: 10000, Delivered: 9900, Complained: 200}, // 2%
		has:   true,
	}
	res, _ := Score(context.Background(), happyInput(), "tid", rep)
	if !hasReason(res, "complaint_rate_critical") {
		t.Errorf("expected complaint_rate_critical, got %v", reasonCodes(res))
	}
	if res.Reputation.Score >= 70 {
		t.Errorf("crit-complaint reputation score = %d, want < 70", res.Reputation.Score)
	}
}

func TestScore_ReputationElevatedBounce(t *testing.T) {
	rep := &fixtureRep{
		stats: Last7dStats{Sent: 10000, Delivered: 9700, Bounced: 300}, // 3%
		has:   true,
	}
	res, _ := Score(context.Background(), happyInput(), "tid", rep)
	if !hasReason(res, "bounce_rate_elevated") {
		t.Errorf("expected bounce_rate_elevated, got %v", reasonCodes(res))
	}
}

func TestScore_NoRepHistory_SkippedAndReweighted(t *testing.T) {
	rep := &fixtureRep{has: false}
	res, _ := Score(context.Background(), happyInput(), "tid", rep)
	if len(res.Skipped) != 1 || res.Skipped[0] != "reputation" {
		t.Errorf("expected reputation in Skipped, got %+v", res.Skipped)
	}
	if res.Reputation.Weight != 0 {
		t.Errorf("skipped reputation weight should be 0, got %v", res.Reputation.Weight)
	}
	// Content + Auth weights should sum to ~1.0 when reputation is dropped.
	if total := res.Content.Weight + res.Auth.Weight; total < 0.99 || total > 1.01 {
		t.Errorf("with reputation skipped, content+auth weights = %v, want ~1.0", total)
	}
}

func TestScore_ReputationLookupErrorIsNonFatal(t *testing.T) {
	rep := &fixtureRep{err: contextCanceled{}}
	res, err := Score(context.Background(), happyInput(), "tid", rep)
	if err != nil {
		t.Fatalf("rep lookup error must NOT fail the whole grade, got %v", err)
	}
	if !hasReason(res, "reputation_lookup_failed") {
		t.Errorf("expected reputation_lookup_failed reason, got %v", reasonCodes(res))
	}
	if res.Reputation.Weight != 0 || res.Reputation.Score != 0 {
		t.Errorf("unavailable reputation must be omitted, got %+v", res.Reputation)
	}
	if len(res.Skipped) != 1 || res.Skipped[0] != "reputation" {
		t.Errorf("unavailable reputation must be marked skipped, got %v", res.Skipped)
	}
}

func TestScore_DisplayNameFromUsesCanonicalDomain(t *testing.T) {
	in := happyInput()
	in.From = "Acme Updates <team@acme.example>"
	res, err := Score(context.Background(), in, "tid", nil)
	if err != nil {
		t.Fatalf("Score: %v", err)
	}
	if hasReason(res, "domain_not_verified") {
		t.Fatalf("display-name From was compared with a trailing bracket: %+v", res.Reasons)
	}
}

func TestScore_SmallSampleReputationNeutral(t *testing.T) {
	// Under 100 sent → reputation must reset to 100 with no reasons,
	// even when one of the rates would otherwise be critical.
	rep := &fixtureRep{
		stats: Last7dStats{Sent: 50, Bounced: 10, Complained: 5}, // would trip both
		has:   true,
	}
	res, _ := Score(context.Background(), happyInput(), "tid", rep)
	if res.Reputation.Score != 100 {
		t.Errorf("small-sample reputation = %d, want 100", res.Reputation.Score)
	}
	for _, r := range res.Reputation.Reasons {
		t.Errorf("small-sample should have no reputation reasons, got %+v", r)
	}
}

func TestGrade_Boundaries(t *testing.T) {
	cases := []struct {
		score int
		want  string
	}{
		{100, "A+"}, {97, "A+"}, {96, "A"}, {90, "A"},
		{89, "B"}, {80, "B"},
		{79, "C"}, {70, "C"},
		{69, "D"}, {60, "D"},
		{59, "F"}, {0, "F"},
	}
	for _, c := range cases {
		if got := grade(c.score); got != c.want {
			t.Errorf("grade(%d) = %q, want %q", c.score, got, c.want)
		}
	}
}

func TestReasonOrdering_FailFirst(t *testing.T) {
	in := happyInput()
	in.Subject = ""           // fail: subject_empty
	in.SPFVerified = false    // warning: spf_missing
	in.From = "x@example.com" // info-ish: nothing, but reputation might add info
	res, _ := Score(context.Background(), in, "tid", nil)
	if len(res.Reasons) == 0 {
		t.Fatalf("expected ≥ 1 reason")
	}
	// First reason should be the fail-severity one.
	if res.Reasons[0].Severity != "fail" {
		t.Errorf("first reason severity = %q, want fail. all: %+v", res.Reasons[0].Severity, res.Reasons)
	}
}

// --- Handler-level test ---

func TestGrade_RequiresTenant(t *testing.T) {
	d := &Deps{}
	r := httptest.NewRequest("POST", "/api/v1/deliverability/eq-score", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Grade(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestGradeUsesServerAuthForAuthenticatedTenant(t *testing.T) {
	var resolvedTenant, resolvedFrom string
	d := &Deps{
		SenderAuth: SenderAuthResolverFunc(func(
			_ context.Context,
			tenantID string,
			from string,
		) (SenderAuthState, error) {
			resolvedTenant, resolvedFrom = tenantID, from
			return SenderAuthState{
				Domain:         "example.test",
				DomainVerified: true,
				DKIMVerified:   true,
				SPFVerified:    true,
				DMARCAligned:   true,
			}, nil
		}),
		Reputation: &fixtureRep{has: false},
	}
	body := `{"subject":"A useful update","html":"<p>A detailed useful update for the whole team.</p>","from":"Acme <hello@example.test>"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
	rec := httptest.NewRecorder()
	d.Grade(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if resolvedTenant != "trusted-tenant" || resolvedFrom != "Acme <hello@example.test>" {
		t.Fatalf("sender lookup = tenant %q from %q", resolvedTenant, resolvedFrom)
	}
	var result Result
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Auth.Score != 100 || hasReason(result, "domain_not_verified") {
		t.Fatalf("server-verified display-name sender scored incorrectly: %+v", result.Auth)
	}
}

func TestGradeSerializesEveryResultCollectionAsAnArray(t *testing.T) {
	tests := []struct {
		name       string
		reputation Reputation
	}{
		{name: "no qualifying history", reputation: &fixtureRep{has: false}},
		{
			name: "sufficient clean history",
			reputation: &fixtureRep{
				stats: Last7dStats{Sent: 10_000, Delivered: 10_000},
				has:   true,
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := &Deps{
				SenderAuth: SenderAuthResolverFunc(func(
					context.Context,
					string,
					string,
				) (SenderAuthState, error) {
					return SenderAuthState{
						Domain:         "example.test",
						DomainVerified: true,
						DKIMVerified:   true,
						SPFVerified:    true,
						DMARCAligned:   true,
					}, nil
				}),
				Reputation: tt.reputation,
			}
			body := `{"subject":"A useful update","html":"<p>Useful detail for the team.</p>","from":"hello@example.test"}`
			req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", strings.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
			rec := httptest.NewRecorder()
			d.Grade(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
			}
			var wire struct {
				Skipped json.RawMessage `json:"skippedSubScores"`
				Reasons json.RawMessage `json:"reasons"`
				Content struct {
					Reasons json.RawMessage `json:"reasons"`
				} `json:"content"`
				Auth struct {
					Reasons json.RawMessage `json:"reasons"`
				} `json:"auth"`
				Reputation struct {
					Reasons json.RawMessage `json:"reasons"`
				} `json:"reputation"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &wire); err != nil {
				t.Fatalf("decode wire: %v", err)
			}
			for name, raw := range map[string]json.RawMessage{
				"skippedSubScores":   wire.Skipped,
				"reasons":            wire.Reasons,
				"content.reasons":    wire.Content.Reasons,
				"auth.reasons":       wire.Auth.Reasons,
				"reputation.reasons": wire.Reputation.Reasons,
			} {
				if len(raw) == 0 || string(raw) == "null" || raw[0] != '[' {
					t.Errorf("%s = %s, want JSON array", name, raw)
				}
			}
		})
	}
}

func TestGradeRejectsCallerSuppliedAuthClaims(t *testing.T) {
	resolverCalls := 0
	d := &Deps{
		SenderAuth: SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (SenderAuthState, error) {
			resolverCalls++
			return SenderAuthState{}, nil
		}),
	}
	body := `{"subject":"Hello","from":"hello@example.test","verifiedDomains":["example.test"],"dkimVerified":true,"spfVerified":true,"dmarcAligned":true}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
	rec := httptest.NewRecorder()
	d.Grade(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"code":"unknown_field"`) {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if resolverCalls != 0 {
		t.Fatalf("untrusted claims reached resolver %d times", resolverCalls)
	}
}

func TestGradeRejectsInvalidOrUnboundedPersistenceInput(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{name: "empty from", body: `{"subject":"Hello","from":""}`, want: http.StatusUnprocessableEntity},
		{name: "malformed from", body: `{"subject":"Hello","from":"not-an-address"}`, want: http.StatusUnprocessableEntity},
		{name: "long subject", body: `{"subject":"` + strings.Repeat("s", eqScoreMaxSubjectBytes+1) + `","from":"hello@example.test"}`, want: http.StatusUnprocessableEntity},
		{name: "long from", body: `{"subject":"Hello","from":"` + strings.Repeat("f", eqScoreMaxFromBytes+1) + `"}`, want: http.StatusUnprocessableEntity},
		{name: "long draft label", body: `{"subject":"Hello","from":"hello@example.test","draft_label":"` + strings.Repeat("d", eqScoreMaxDraftLabelBytes+1) + `"}`, want: http.StatusUnprocessableEntity},
		{name: "invalid campaign id", body: `{"subject":"Hello","from":"hello@example.test","campaign_id":"not-a-uuid"}`, want: http.StatusUnprocessableEntity},
		{name: "oversize body", body: `{"subject":"Hello","from":"hello@example.test","html":"` + strings.Repeat("h", int(eqScoreJSONMaxBodyBytes)) + `"}`, want: http.StatusRequestEntityTooLarge},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resolverCalls := 0
			d := &Deps{SenderAuth: SenderAuthResolverFunc(func(
				context.Context,
				string,
				string,
			) (SenderAuthState, error) {
				resolverCalls++
				return SenderAuthState{}, nil
			})}
			req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
			rec := httptest.NewRecorder()
			d.Grade(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, tt.want, rec.Body.String())
			}
			if resolverCalls != 0 {
				t.Fatalf("invalid input reached resolver %d times", resolverCalls)
			}
		})
	}
}

func TestGradeFailsClosedWhenHistoryPersistenceFails(t *testing.T) {
	var persisted HistoryRecord
	d := &Deps{
		SenderAuth: SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (SenderAuthState, error) {
			return SenderAuthState{
				Domain:         "example.test",
				DomainVerified: true,
				DKIMVerified:   true,
				SPFVerified:    true,
				DMARCAligned:   true,
			}, nil
		}),
		Reputation: &fixtureRep{has: false},
		PersistScore: func(_ context.Context, _ *db.Pool, record HistoryRecord) error {
			persisted = record
			return errors.New("private database failure")
		},
	}
	body := `{"subject":"A useful update","html":"<p>Useful detail for the team.</p>","from":"hello@example.test","draft_label":"Version A"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
	rec := httptest.NewRecorder()
	d.Grade(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if persisted.TenantID != "trusted-tenant" || persisted.DraftLabel != "Version A" {
		t.Fatalf("persistence receipt = %+v", persisted)
	}
	if strings.Contains(rec.Body.String(), "private database failure") {
		t.Fatalf("response leaked persistence detail: %s", rec.Body.String())
	}
}

func TestMountRoutesRequiresWriteCampaignsAndAppliesRateLimit(t *testing.T) {
	rateLimitCalls := 0
	d := &Deps{RateLimit: func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rateLimitCalls++
			next.ServeHTTP(w, r)
		})
	}}
	router := chi.NewRouter()
	d.MountRoutes(router)

	request := func(scopes ...apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/deliverability/eq-score", nil)
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}

	readOnly := request(apikeys.ScopeReadReports)
	if readOnly.Code != http.StatusForbidden {
		t.Fatalf("read-only status = %d, body=%s", readOnly.Code, readOnly.Body.String())
	}
	if rateLimitCalls != 0 {
		t.Fatalf("scope-denied call consumed rate limit")
	}
	write := request(apikeys.ScopeWriteCampaigns)
	if write.Code != http.StatusUnauthorized || rateLimitCalls != 1 {
		t.Fatalf("write status=%d rateLimitCalls=%d body=%s", write.Code, rateLimitCalls, write.Body.String())
	}
}

// --- helpers ---

func reasonCodes(r Result) []string {
	out := []string{}
	for _, x := range r.Reasons {
		out = append(out, x.Code)
	}
	return out
}

func hasReason(r Result, code string) bool {
	for _, x := range r.Reasons {
		if x.Code == code {
			return true
		}
	}
	return false
}

// contextCanceled satisfies error without dragging in the real
// context package's sentinel (so the test stays portable across
// stdlib variations).
type contextCanceled struct{}

func (contextCanceled) Error() string { return "context canceled" }
