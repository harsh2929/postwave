// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeOlarkSecretResolver struct{ json string }

func (f fakeOlarkSecretResolver) Get(_ context.Context, _ string) (string, error) { return f.json, nil }
func (f fakeOlarkSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	if dst, ok := out.(*olarkCredentialPayload); ok {
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestOlarkBackfillMapsTranscripts(t *testing.T) {
	var gotPath, gotAuth, gotOffset string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotOffset = r.URL.Query().Get("offset")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"id": "tr1", "tags": []any{"vip"},
					"topic":   "Sizing help",
					"visitor": map[string]any{"emailAddress": "Ada@Example.com", "fullName": "Ada L", "phoneNumber": "+15551230000"},
					"items": []map[string]any{
						{"kind": "MessageToOperator", "body": "Need help", "nickname": "Ada", "timestamp": "2026-06-20T10:01:00Z"},
						{"kind": "MessageToVisitor", "body": "Checking now", "nickname": "Ops", "timestamp": "2026-06-20T10:02:00Z"},
					}},
			},
			"next": "https://api.olark.com/api/v1/transcripts?offset=1",
		})
	}))
	defer srv.Close()

	backfiller := OlarkRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: OlarkSecretsCredentialResolver{Secrets: fakeOlarkSecretResolver{json: `{"access_token":"olark.tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    1,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderOlark, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/transcripts") || gotAuth != "Bearer olark.tok" || gotOffset != "0" {
		t.Fatalf("path=%q auth=%q offset=%q", gotPath, gotAuth, gotOffset)
	}
	if len(req.Tickets) != 1 {
		t.Fatalf("tickets = %d", len(req.Tickets))
	}
	tk := req.Tickets[0]
	if tk.Email != "ada@example.com" || tk.ConversationID != "tr1" || tk.RequesterName != "Ada L" {
		t.Fatalf("mapped = %+v", tk)
	}
	if tk.SourceID != "olark://transcript/tr1" || tk.Subject != "Sizing help" || tk.Properties["olark_visitor_phone"] != "+15551230000" {
		t.Fatalf("ticket evidence = %+v", tk)
	}
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %d", len(req.Messages))
	}
	first := req.Messages[0]
	if first.SourceID != "olark://transcript/tr1/message/1" || first.Direction != "inbound" || first.SenderType != "customer" || first.Sender != "Ada" || first.BodyText != "Need help" {
		t.Fatalf("first message = %+v", first)
	}
	second := req.Messages[1]
	if second.SourceID != "olark://transcript/tr1/message/2" || second.Direction != "outbound" || second.SenderType != "agent" || second.Sender != "Ops" || second.BodyText != "Checking now" {
		t.Fatalf("second message = %+v", second)
	}
	if req.Cursor != "olark:1" {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

// Regression: a PARTIAL page (fewer results than the page size) that still
// reports a Next link must advance the cursor — otherwise the backfill-on-connect
// drain stops after one page and truncates history. Before the fix the cursor
// froze at olark:complete here.
func TestOlarkBackfillAdvancesOnPartialPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"id": "tr1", "visitor": map[string]any{"emailAddress": "a@x.com"}},
				{"id": "tr2", "visitor": map[string]any{"emailAddress": "b@x.com"}},
			},
			"next": "https://api.olark.com/api/v1/transcripts?offset=2",
		})
	}))
	defer srv.Close()

	backfiller := OlarkRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: OlarkSecretsCredentialResolver{Secrets: fakeOlarkSecretResolver{json: `{"access_token":"olark.tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    5, // 2 results < 5: partial page that nonetheless has a Next
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderOlark, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if req.Cursor != "olark:2" {
		t.Fatalf("partial page with Next must advance the cursor (offset 0 + 2 rows), got %q", req.Cursor)
	}
}

func TestOlarkBackfillRetryAfterError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "29")
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := OlarkRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: OlarkSecretsCredentialResolver{Secrets: fakeOlarkSecretResolver{json: `{"access_token":"olark.tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderOlark, CredentialsRef: "c"}, "")
	if err == nil {
		t.Fatal("expected rate-limit error")
	}
	var restErr OlarkRESTError
	if !errors.As(err, &restErr) || restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter != 29*time.Second {
		t.Fatalf("restErr = %#v err=%v", restErr, err)
	}
	cfg, cfgErr := supportBackfillConfig(ProviderOlark)
	if cfgErr != nil {
		t.Fatalf("missing Olark retry config: %v", cfgErr)
	}
	now := time.Date(2026, 7, 1, 14, 0, 0, 0, time.UTC)
	retryCursor := supportBackfillRetryCursor(cfg, olarkCursorPrefix+"2", "BACKFILL_FAILED", err, now)
	state, ok, err := decodeSupportRetryCursor(cfg, retryCursor)
	if err != nil || !ok {
		t.Fatalf("decode retry cursor ok=%v err=%v cursor=%q", ok, err, retryCursor)
	}
	if state.NextAttemptAt != now.Add(29*time.Second).Format(time.RFC3339) {
		t.Fatalf("next attempt = %q", state.NextAttemptAt)
	}
}
