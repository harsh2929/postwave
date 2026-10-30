// SPDX-License-Identifier: AGPL-3.0-only

package presend

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/eqscore"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fixtureReputation struct {
	stats eqscore.Last7dStats
	has   bool
	err   error
}

func (f fixtureReputation) Last7d(
	context.Context,
	string,
) (eqscore.Last7dStats, bool, error) {
	return f.stats, f.has, f.err
}

func completeDeps(d *Deps) *Deps {
	if d.SenderAuth == nil {
		d.SenderAuth = eqscore.SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (eqscore.SenderAuthState, error) {
			return eqscore.SenderAuthState{
				Domain:         "example.test",
				DomainVerified: true,
				DKIMVerified:   true,
				SPFVerified:    true,
				DMARCAligned:   true,
			}, nil
		})
	}
	if d.Reputation == nil {
		d.Reputation = fixtureReputation{}
	}
	return d
}

func TestComputeVerdictHonestyAndPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		components    []Component
		wantVerdict   Verdict
		wantComplete  bool
		wantSummary   string
		forbidSummary string
	}{
		{
			name: "all completed checks pass",
			components: []Component{
				{Name: "eq_score", Status: "ok"},
				{Name: "voice_drift", Status: "ok"},
				{Name: "placement", Status: "ok"},
			},
			wantVerdict: VerdictOK, wantComplete: true,
			wantSummary: "All pre-send checks passed.",
		},
		{
			name: "skipped check is incomplete",
			components: []Component{
				{Name: "eq_score", Status: "ok"},
				{Name: "voice_drift", Status: "skipped"},
				{Name: "placement", Status: "ok"},
			},
			wantVerdict: VerdictIncomplete, wantComplete: false,
			wantSummary: "Voice alignment", forbidSummary: "All pre-send checks passed",
		},
		{
			name: "warning plus error remains incomplete",
			components: []Component{
				{Name: "eq_score", Status: "warn", Message: "review auth"},
				{Name: "voice_drift", Status: "error"},
				{Name: "placement", Status: "ok"},
			},
			wantVerdict: VerdictIncomplete, wantComplete: false,
			wantSummary: "Available checks also reported warnings",
		},
		{
			name: "known critical outranks incomplete",
			components: []Component{
				{Name: "eq_score", Status: "ok"},
				{Name: "voice_drift", Status: "error"},
				{Name: "placement", Status: "critical", Message: "low primary"},
			},
			wantVerdict: VerdictCritical, wantComplete: false,
			wantSummary: "Checks incomplete: Voice alignment",
		},
		{
			name: "complete critical stays complete",
			components: []Component{
				{Name: "eq_score", Status: "critical"},
				{Name: "voice_drift", Status: "warn"},
				{Name: "placement", Status: "ok"},
			},
			wantVerdict: VerdictCritical, wantComplete: true,
			wantSummary: "Critical issues detected",
		},
		{
			name: "unknown status is incomplete",
			components: []Component{
				{Name: "eq_score", Status: "ok"},
				{Name: "voice_drift", Status: "pending"},
				{Name: "placement", Status: "ok"},
			},
			wantVerdict: VerdictIncomplete, wantComplete: false,
			wantSummary: "Voice alignment",
		},
		{
			name:          "missing components cannot pass",
			components:    nil,
			wantVerdict:   VerdictIncomplete,
			wantComplete:  false,
			wantSummary:   "Content quality, Voice alignment, Primary placement",
			forbidSummary: "All pre-send checks passed",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			verdict, summary, complete := computeVerdict(tt.components)
			if verdict != tt.wantVerdict || complete != tt.wantComplete {
				t.Fatalf("computeVerdict = (%q, %t), want (%q, %t); summary=%q",
					verdict, complete, tt.wantVerdict, tt.wantComplete, summary)
			}
			if tt.wantSummary != "" && !strings.Contains(summary, tt.wantSummary) {
				t.Errorf("summary %q does not contain %q", summary, tt.wantSummary)
			}
			if tt.forbidSummary != "" && strings.Contains(summary, tt.forbidSummary) {
				t.Errorf("summary %q must not contain %q", summary, tt.forbidSummary)
			}
		})
	}
}

type capturedUpstreamRequest struct {
	Path          string
	TenantHeader  string
	Authorization string
	ContentType   string
	Accept        string
	Body          map[string]json.RawMessage
}

func captureUpstreamRequest(r *http.Request) capturedUpstreamRequest {
	captured := capturedUpstreamRequest{
		Path:          r.URL.Path,
		TenantHeader:  r.Header.Get("X-Tenant-ID"),
		Authorization: r.Header.Get("Authorization"),
		ContentType:   r.Header.Get("Content-Type"),
		Accept:        r.Header.Get("Accept"),
		Body:          map[string]json.RawMessage{},
	}
	_ = json.NewDecoder(r.Body).Decode(&captured.Body)
	return captured
}

func TestHandleUsesVoiceWireContractAndTrustedTenant(t *testing.T) {
	voiceRequests := make(chan capturedUpstreamRequest, 1)
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		voiceRequests <- captureUpstreamRequest(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"score":87,"severity":"ok","suggestions":["Keep the concise tone."]}`)
	}))
	t.Cleanup(voice.Close)

	predictorRequests := make(chan capturedUpstreamRequest, 1)
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		predictorRequests <- captureUpstreamRequest(r)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"predicted":{"primary":0.81,"promotions":0.14,"spam":0.05}}`)
	}))
	t.Cleanup(predictor.Close)

	var resolvedTenant, resolvedFrom string
	d := completeDeps(&Deps{
		VoiceServiceURL:     voice.URL,
		PredictorServiceURL: predictor.URL,
		InternalToken:       "service-secret",
		HTTPClient:          voice.Client(),
		SenderAuth: eqscore.SenderAuthResolverFunc(func(
			_ context.Context,
			tenantID string,
			from string,
		) (eqscore.SenderAuthState, error) {
			resolvedTenant, resolvedFrom = tenantID, from
			return eqscore.SenderAuthState{
				Domain:         "example.test",
				DomainVerified: true,
				DKIMVerified:   true,
				SPFVerified:    true,
				DMARCAligned:   true,
			}, nil
		}),
	})
	body := map[string]any{
		"subject":          "A useful product update",
		"html":             "<p>Here is a detailed and useful product update for your team to review today.</p>",
		"text":             "plain fallback must not replace HTML",
		"from":             "sender@example.test",
		"voice_profile_id": "profile-42",
	}
	rec, response := executeHandler(t, d, body, "trusted-tenant", "spoofed-tenant")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if response.Verdict != VerdictOK || !response.Complete {
		t.Fatalf("response = %+v, want complete ok", response)
	}
	if resolvedTenant != "trusted-tenant" || resolvedFrom != body["from"] {
		t.Fatalf("sender auth lookup = tenant %q from %q, want trusted request context", resolvedTenant, resolvedFrom)
	}
	if got := []string{response.Components[0].Name, response.Components[1].Name, response.Components[2].Name}; strings.Join(got, ",") != "eq_score,voice_drift,placement" {
		t.Fatalf("component order = %v", got)
	}

	voiceReq := <-voiceRequests
	assertUpstreamHeaders(t, voiceReq, "/v1/voice/drift")
	if got := sortedJSONKeys(voiceReq.Body); got != "body,profile_id,subject" {
		t.Fatalf("voice request keys = %q, want body,profile_id,subject", got)
	}
	assertJSONString(t, voiceReq.Body, "body", body["html"].(string))
	assertJSONString(t, voiceReq.Body, "subject", body["subject"].(string))
	assertJSONString(t, voiceReq.Body, "profile_id", body["voice_profile_id"].(string))

	predictorReq := <-predictorRequests
	assertUpstreamHeaders(t, predictorReq, "/v1/predict")
	if got := sortedJSONKeys(predictorReq.Body); got != "html,subject" {
		t.Fatalf("predictor request keys = %q, want html,subject", got)
	}
}

func TestHandleCriticalPrecedenceAndNoUpstreamLeakage(t *testing.T) {
	const secret = "provider-secret-do-not-leak"
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, secret, http.StatusInternalServerError)
	}))
	t.Cleanup(voice.Close)
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"predicted":{"primary":0.1,"spam":0.8}}`)
	}))
	t.Cleanup(predictor.Close)

	rec, response := executeHandler(t, completeDeps(&Deps{
		VoiceServiceURL:     voice.URL,
		PredictorServiceURL: predictor.URL,
		HTTPClient:          voice.Client(),
	}), goodInput(), "tenant-1", "attacker-tenant")
	if response.Verdict != VerdictCritical || response.Complete {
		t.Fatalf("response = %+v, want incomplete critical", response)
	}
	if strings.Contains(rec.Body.String(), secret) || strings.Contains(rec.Body.String(), "500 Internal Server Error") {
		t.Fatalf("response leaked upstream detail: %s", rec.Body.String())
	}
	voiceComponent := response.Components[1]
	if voiceComponent.Status != "error" || voiceComponent.Error != "Voice drift check unavailable." {
		t.Fatalf("voice component = %+v", voiceComponent)
	}
	if !strings.Contains(response.Summary, "Checks incomplete: Voice alignment") {
		t.Fatalf("summary does not disclose incompleteness: %q", response.Summary)
	}
}

func TestHandleSkippedAndMalformedChecksAreIncomplete(t *testing.T) {
	tests := []struct {
		name     string
		voiceURL func(t *testing.T) string
		status   string
	}{
		{
			name: "not configured",
			voiceURL: func(_ *testing.T) string {
				return ""
			},
			status: "skipped",
		},
		{
			name: "malformed success",
			voiceURL: func(t *testing.T) string {
				t.Helper()
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					_, _ = io.WriteString(w, `{"score":101,"severity":"ok"}`)
				}))
				t.Cleanup(server.Close)
				return server.URL
			},
			status: "error",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"predicted":{"primary":0.8,"spam":0.05}}`)
			}))
			t.Cleanup(predictor.Close)
			rec, response := executeHandler(t, completeDeps(&Deps{
				VoiceServiceURL:     tt.voiceURL(t),
				PredictorServiceURL: predictor.URL,
				HTTPClient:          predictor.Client(),
			}), goodInput(), "tenant-1", "")
			if response.Verdict != VerdictIncomplete || response.Complete {
				t.Fatalf("response = %+v, want incomplete", response)
			}
			if response.Components[1].Status != tt.status {
				t.Fatalf("voice status = %q, want %q", response.Components[1].Status, tt.status)
			}
			if strings.Contains(rec.Body.String(), "All pre-send checks passed") {
				t.Fatalf("incomplete response made green claim: %s", rec.Body.String())
			}
		})
	}
}

func TestHandleSerializesRealZeroScore(t *testing.T) {
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"score":0,"severity":"critical"}`)
	}))
	t.Cleanup(voice.Close)
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"predicted":{"primary":0.8,"spam":0.05}}`)
	}))
	t.Cleanup(predictor.Close)

	_, response := executeHandler(t, completeDeps(&Deps{
		VoiceServiceURL:     voice.URL,
		PredictorServiceURL: predictor.URL,
		HTTPClient:          voice.Client(),
	}), goodInput(), "tenant-1", "")
	voiceComponent := response.Components[1]
	if voiceComponent.Score == nil || *voiceComponent.Score != 0 {
		t.Fatalf("zero score was omitted or changed: %+v", voiceComponent)
	}
}

func TestHandleRejectsMissingPredictorScore(t *testing.T) {
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"score":80,"severity":"ok"}`)
	}))
	t.Cleanup(voice.Close)
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"predicted":{"spam":0.05}}`)
	}))
	t.Cleanup(predictor.Close)

	_, response := executeHandler(t, completeDeps(&Deps{
		VoiceServiceURL:     voice.URL,
		PredictorServiceURL: predictor.URL,
		HTTPClient:          voice.Client(),
	}), goodInput(), "tenant-1", "")
	if response.Verdict != VerdictIncomplete || response.Complete {
		t.Fatalf("missing predictor score produced trusted verdict: %+v", response)
	}
	placement := response.Components[2]
	if placement.Status != "error" || placement.Score != nil || placement.Error != "Placement prediction unavailable." {
		t.Fatalf("placement component = %+v", placement)
	}
}

func TestHandleDoesNotForwardTenantOrTokenAcrossRedirect(t *testing.T) {
	redirected := make(chan capturedUpstreamRequest, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected <- captureUpstreamRequest(r)
		_, _ = io.WriteString(w, `{"score":80,"severity":"ok"}`)
	}))
	t.Cleanup(target.Close)
	voice := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", target.URL+"/capture")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	t.Cleanup(voice.Close)
	predictor := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"predicted":{"primary":0.8}}`)
	}))
	t.Cleanup(predictor.Close)

	_, response := executeHandler(t, completeDeps(&Deps{
		VoiceServiceURL:     voice.URL,
		PredictorServiceURL: predictor.URL,
		InternalToken:       "must-not-cross-origin",
		HTTPClient:          voice.Client(),
	}), goodInput(), "trusted-tenant", "spoofed-tenant")
	if response.Verdict != VerdictIncomplete || response.Components[1].Status != "error" {
		t.Fatalf("redirect response = %+v, want unavailable voice check", response)
	}
	select {
	case req := <-redirected:
		t.Fatalf("downstream redirect was followed and leaked headers: %+v", req)
	default:
		// Expected: the internal client treats every redirect as an upstream
		// protocol error before any trusted header can cross origins.
	}
}

func TestHandleRejectsCallerSuppliedSenderAuthClaims(t *testing.T) {
	resolverCalls := 0
	d := completeDeps(&Deps{
		SenderAuth: eqscore.SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (eqscore.SenderAuthState, error) {
			resolverCalls++
			return eqscore.SenderAuthState{}, nil
		}),
	})
	body := `{"subject":"Hello","from":"sender@example.test","verifiedDomains":["example.test"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/presend/verdict", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "trusted-tenant"}))
	rec := httptest.NewRecorder()
	d.Handle(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if resolverCalls != 0 {
		t.Fatalf("untrusted auth claim reached resolver %d times", resolverCalls)
	}
	if !strings.Contains(rec.Body.String(), `"code":"unknown_field"`) {
		t.Fatalf("response did not use the stable unknown-field envelope: %s", rec.Body.String())
	}
}

func TestHandleSenderAuthorityFailureMakesEQIncomplete(t *testing.T) {
	d := completeDeps(&Deps{
		SenderAuth: eqscore.SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (eqscore.SenderAuthState, error) {
			return eqscore.SenderAuthState{}, errors.New("database unavailable")
		}),
	})
	_, response := executeHandler(t, d, goodInput(), "tenant-1", "")
	if response.Verdict != VerdictIncomplete || response.Complete {
		t.Fatalf("response = %+v, want incomplete", response)
	}
	if got := response.Components[0]; got.Status != "error" || got.Error != "EQ score check unavailable." {
		t.Fatalf("EQ component = %+v", got)
	}
}

func TestHandleUnverifiedServerStateCannotBecomeGreen(t *testing.T) {
	d := completeDeps(&Deps{
		SenderAuth: eqscore.SenderAuthResolverFunc(func(
			context.Context,
			string,
			string,
		) (eqscore.SenderAuthState, error) {
			return eqscore.SenderAuthState{Domain: "example.test"}, nil
		}),
		Reputation: fixtureReputation{
			stats: eqscore.Last7dStats{Sent: 10_000, Delivered: 10_000},
			has:   true,
		},
	})
	_, response := executeHandler(t, d, goodInput(), "tenant-1", "")
	eq := response.Components[0]
	if eq.Status != "critical" {
		t.Fatalf("unverified sender EQ = %+v, want critical despite compensating reputation", eq)
	}
	if strings.Contains(eq.Message, "C-grade") {
		t.Fatalf("EQ copy states a grade inconsistent with the canonical score: %q", eq.Message)
	}
}

func TestHandleProviderCeilingReputationCannotBecomeGreen(t *testing.T) {
	tests := []struct {
		name  string
		stats eqscore.Last7dStats
	}{
		{
			name:  "complaint ceiling",
			stats: eqscore.Last7dStats{Sent: 10_000, Delivered: 9_950, Complained: 50},
		},
		{
			name:  "critical bounce rate",
			stats: eqscore.Last7dStats{Sent: 10_000, Delivered: 9_400, Bounced: 600},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := completeDeps(&Deps{
				Reputation: fixtureReputation{stats: tt.stats, has: true},
			})
			_, response := executeHandler(t, d, goodInput(), "tenant-1", "")
			if got := response.Components[0]; got.Status != "critical" {
				t.Fatalf("provider-ceiling reputation became %+v", got)
			}
		})
	}
}

func TestHandleReputationOutageMakesEQIncomplete(t *testing.T) {
	d := completeDeps(&Deps{
		Reputation: fixtureReputation{err: errors.New("events unavailable")},
	})
	_, response := executeHandler(t, d, goodInput(), "tenant-1", "")
	if response.Verdict != VerdictIncomplete || response.Complete {
		t.Fatalf("response = %+v, want incomplete", response)
	}
	if got := response.Components[0]; got.Status != "error" || got.Error != "EQ score check unavailable." {
		t.Fatalf("EQ component = %+v", got)
	}
}

func TestMountRoutesRequiresWriteCampaigns(t *testing.T) {
	router := chi.NewRouter()
	MountRoutes(router, &Deps{})

	request := func(scopes ...apikeys.Scope) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/presend/verdict", nil)
		ctx := middleware.WithAPIKeyAuth(req.Context())
		ctx = apikeys.WithScopes(ctx, scopes)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req.WithContext(ctx))
		return rec
	}

	readOnly := request(apikeys.ScopeReadReports)
	if readOnly.Code != http.StatusForbidden || !strings.Contains(readOnly.Body.String(), "insufficient_scope") {
		t.Fatalf("read:reports reached write route: status=%d body=%q", readOnly.Code, readOnly.Body.String())
	}
	write := request(apikeys.ScopeWriteCampaigns)
	if write.Code != http.StatusUnauthorized || !strings.Contains(write.Body.String(), "no_tenant") {
		t.Fatalf("write:campaigns did not reach handler: status=%d body=%q", write.Code, write.Body.String())
	}
}

func goodInput() map[string]any {
	return map[string]any{
		"subject": "A useful product update",
		"html":    "<p>Here is a detailed and useful product update for your team to review today.</p>",
		"from":    "sender@example.test",
	}
}

func executeHandler(
	t *testing.T,
	d *Deps,
	body map[string]any,
	tenantID string,
	spoofedTenantHeader string,
) (*httptest.ResponseRecorder, Response) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/presend/verdict", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	if spoofedTenantHeader != "" {
		req.Header.Set("X-Tenant-ID", spoofedTenantHeader)
	}
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	rec := httptest.NewRecorder()
	d.Handle(rec, req.WithContext(ctx))
	var response Response
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	wantComponents := 3
	if _, requested := body["campaign_id"]; requested {
		wantComponents = 4
	}
	if len(response.Components) != wantComponents {
		t.Fatalf("components = %d, want exactly %d; body=%s", len(response.Components), wantComponents, rec.Body.String())
	}
	return rec, response
}

func assertUpstreamHeaders(t *testing.T, got capturedUpstreamRequest, wantPath string) {
	t.Helper()
	if got.Path != wantPath {
		t.Errorf("path = %q, want %q", got.Path, wantPath)
	}
	if got.TenantHeader != "trusted-tenant" {
		t.Errorf("X-Tenant-ID = %q, want authenticated tenant", got.TenantHeader)
	}
	if got.Authorization != "Bearer service-secret" {
		t.Errorf("Authorization = %q", got.Authorization)
	}
	if got.ContentType != "application/json" || got.Accept != "application/json" {
		t.Errorf("content negotiation = (%q, %q)", got.ContentType, got.Accept)
	}
}

func assertJSONString(t *testing.T, body map[string]json.RawMessage, key, want string) {
	t.Helper()
	var got string
	if err := json.Unmarshal(body[key], &got); err != nil {
		t.Fatalf("decode %s: %v", key, err)
	}
	if got != want {
		t.Errorf("%s = %q, want %q", key, got, want)
	}
}

func sortedJSONKeys(body map[string]json.RawMessage) string {
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}
