// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestAmplitudeFreeExportPreservesProfileProperties(t *testing.T) {
	body, err := os.ReadFile("testdata/amplitude-free-cohort.csv")
	if err != nil {
		t.Fatal(err)
	}
	profiles, err := parseAmplitudeCohortCSV(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 {
		t.Fatalf("expected one exported fixture, got %d", len(profiles))
	}
	p := profiles[0]
	if p.Email != "qa-certification@moosewave.example" || p.UserID != "moosewave-qa-20261025" || p.AnonymousID != "1759322819168" || p.Traits["gp:qa_fixture"] != "True" || p.Traits["library"] != "http/2.0" {
		t.Fatal("the real free CSV export lost identity or user properties")
	}
}

func TestAmplitudeCSVUsesExactEmailPropertyAndPreservesNames(t *testing.T) {
	body := []byte("\ufeffamplitude_id,user_id,gp:email_opt_in,gp:email,gp:first_name,gp:last_name,gp:name,gp:phone,gp:plan\n9007199254740993,u1,true,Ada@Example.com,Ada,Lovelace,Ada Lovelace,+12025550123,free\n")
	profiles, err := parseAmplitudeCohortCSV(body)
	if err != nil || len(profiles) != 1 {
		t.Fatalf("parse: count=%d error=%v", len(profiles), err)
	}
	p := profiles[0]
	if p.Email != "ada@example.com" || p.AnonymousID != "9007199254740993" || p.FirstName != "Ada" || p.LastName != "Lovelace" || p.FullName != "Ada Lovelace" || p.Phone != "+12025550123" || p.Traits["gp:email_opt_in"] != "true" || p.Traits["gp:plan"] != "free" {
		t.Fatal("CSV selected a consent flag as an email, lost a large ID, or dropped profile fields")
	}
}

func TestAmplitudeCSVRejectsAmbiguousOrMalformedExports(t *testing.T) {
	for _, body := range []string{
		"",
		"user_id,gp:email_opt_in\nu1,true\n",
		"user_id,email,email\nu1,ada@example.com,other@example.com\n",
		"user_id,email\nu1,ada@example.com,unexpected\n",
		"user_id,email\nu1,ada@example.com\nu2,\"unfinished\n",
	} {
		if profiles, err := parseAmplitudeCohortCSV([]byte(body)); err == nil || profiles != nil {
			t.Fatal("ambiguous/malformed export was accepted or returned a partial import")
		}
	}
}

func TestAmplitudeDownloadRejectsOversizeBeforeTruncation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(amplitudeResponseMaxBytes+1))
		_, _ = w.Write([]byte("user_id,email\nu1,ada@example.com\n"))
	}))
	defer srv.Close()
	if body, err := amplitudeGetRaw(context.Background(), srv.Client(), srv.URL, nil, "test"); err == nil || body != nil {
		t.Fatal("oversized cohort download was accepted as a partial import")
	}
}

func TestAmplitudeDownloadLimitRejectsCompleteCSVPrefix(t *testing.T) {
	// The old LimitReader accepted this complete first-row prefix and silently
	// dropped the rest of an export without Content-Length (chunked transfer).
	prefix := "user_id,email\nu1,ada@example.com\n"
	if body, err := amplitudeReadBounded(strings.NewReader(prefix+"u2,two@example.com\n"), int64(len(prefix))); err == nil || body != nil {
		t.Fatal("a download longer than the limit was silently truncated")
	}
	if body, err := amplitudeReadBounded(strings.NewReader(prefix), int64(len(prefix))); err != nil || string(body) != prefix {
		t.Fatal("a complete export at the exact limit was rejected")
	}
}

func TestAmplitudePollRejectsFailedOrMissingJobStatus(t *testing.T) {
	for _, status := range []string{"", "JOB FAILED", "JOB CANCELLED", "unexpected"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]string{"async_status": status})
		}))
		b := AmplitudeRESTBackfiller{HTTPClient: srv.Client(), APIBaseURL: srv.URL, Credentials: AmplitudeSecretsCredentialResolver{Secrets: fakeAmplitudeSecretResolver{json: `{"api_key":"ak","secret_key":"sk"}`}}}
		page, err := b.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAmplitude, CredentialsRef: "c", Settings: map[string]any{"cohort_id": "COH1"}}, "amplitude:poll:req123")
		srv.Close()
		if err == nil || page.Cursor != "" || len(page.Profiles) != 0 {
			t.Fatal("a failed/missing status was accepted as a pending or completed export")
		}
	}
}

type fakeAmplitudeSecretResolver struct{ json string }

func (f fakeAmplitudeSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeAmplitudeSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*amplitudeCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errAnalyticsNotJSONSecret
}

func TestAmplitudeBackfillRequestsExportThenPolls(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/cohorts/request/COH1") {
			_ = json.NewEncoder(w).Encode(map[string]any{"request_id": "req123"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	backfiller := AmplitudeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AmplitudeSecretsCredentialResolver{Secrets: fakeAmplitudeSecretResolver{json: `{"api_key":"ak","secret_key":"sk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAmplitude, CredentialsRef: "c", Settings: map[string]any{"cohort_id": "COH1"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(req.Profiles) != 0 || req.Cursor != "amplitude:poll:req123" {
		t.Fatalf("expected request->poll cursor, got profiles=%d cursor=%q", len(req.Profiles), req.Cursor)
	}
}

func TestAmplitudeBackfillDownloadsCompletedExport(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch {
		case strings.Contains(r.URL.Path, "/cohorts/request-status/req123"):
			_ = json.NewEncoder(w).Encode(map[string]any{"async_status": "JOB COMPLETED", "request_id": "req123"})
		case strings.Contains(r.URL.Path, "/cohorts/request/req123/file"):
			_, _ = w.Write([]byte("amplitude_id,user_id,email\n9001,u1,Ada@Example.com\n9002,u2,\n"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	backfiller := AmplitudeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AmplitudeSecretsCredentialResolver{Secrets: fakeAmplitudeSecretResolver{json: `{"api_key":"ak","secret_key":"sk"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAmplitude, CredentialsRef: "c", Settings: map[string]any{"cohort_id": "COH1"}}, "amplitude:poll:req123")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("ak:sk"))
	if gotAuth != wantAuth {
		t.Fatalf("auth=%q want=%q", gotAuth, wantAuth)
	}
	if len(req.Profiles) != 1 {
		t.Fatalf("profiles = %d (row without email must be skipped)", len(req.Profiles))
	}
	p := req.Profiles[0]
	if p.Email != "ada@example.com" || p.UserID != "u1" {
		t.Fatalf("mapped = %+v", p)
	}
	if p.SourceID != "amplitude://user/u1" {
		t.Fatalf("source id = %q", p.SourceID)
	}
	if req.Cursor != amplitudeCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

// The Behavioral Cohort export request/status/file workflow lives under /api/5/
// (only /api/3/cohorts/usage remains v3). Using /api/3/ for the export flow hits
// a deprecated path.
func TestAmplitudeUsesV5CohortEndpoints(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{"request_id": "req123"})
	}))
	defer srv.Close()

	backfiller := AmplitudeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AmplitudeSecretsCredentialResolver{Secrets: fakeAmplitudeSecretResolver{json: `{"api_key":"ak","secret_key":"sk"}`}},
		APIBaseURL:  srv.URL,
	}
	if _, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderAmplitude, CredentialsRef: "c", Settings: map[string]any{"cohort_id": "COH1"}}, ""); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.HasPrefix(gotPath, "/api/5/cohorts/request/") {
		t.Fatalf("export request path = %q, want /api/5/ cohort endpoint", gotPath)
	}
}

// A still-running export must re-emit a poll cursor with an incremented attempt
// counter, and once the ceiling is hit it must error rather than poll forever.
func TestAmplitudePollIncrementsThenGivesUp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"async_status": "JOB INPROGRESS", "request_id": "req123"})
	}))
	defer srv.Close()

	backfiller := AmplitudeRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AmplitudeSecretsCredentialResolver{Secrets: fakeAmplitudeSecretResolver{json: `{"api_key":"ak","secret_key":"sk"}`}},
		APIBaseURL:  srv.URL,
	}
	integ := Integration{Provider: ProviderAmplitude, CredentialsRef: "c", Settings: map[string]any{"cohort_id": "COH1"}}
	req, err := backfiller.BackfillPage(context.Background(), "t", integ, "amplitude:poll:req123")
	if err != nil {
		t.Fatalf("in-progress poll: %v", err)
	}
	if req.Cursor != "amplitude:poll:req123#1" {
		t.Fatalf("poll cursor = %q, want incremented attempt counter", req.Cursor)
	}
	last := amplitudeCursorPollPrefix + "req123#" + strconv.Itoa(amplitudeMaxPollAttempts-1)
	if _, err := backfiller.BackfillPage(context.Background(), "t", integ, last); err == nil {
		t.Fatalf("expected error after exhausting %d poll attempts", amplitudeMaxPollAttempts)
	}
}
