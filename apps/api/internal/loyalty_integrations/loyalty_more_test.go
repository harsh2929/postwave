// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeMoreLoyaltySecretResolver struct{ json string }

func (f fakeMoreLoyaltySecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeMoreLoyaltySecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	switch dst := out.(type) {
	case *rivoCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *referralCandyCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestRivoBackfillMapsMembers(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"customers": []map[string]any{
				{"id": 42, "email": "Ada@Example.com", "first_name": "Ada", "last_name": "L",
					"points_balance": 275, "vip_tier": map[string]any{"name": "Silver"}},
			},
		})
	}))
	defer srv.Close()

	backfiller := RivoRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: RivoSecretsCredentialResolver{Secrets: fakeMoreLoyaltySecretResolver{json: `{"api_token":"rivo_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderRivo, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/customers") || gotAuth != "Bearer rivo_tok" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "ada@example.com" || m.PointsBalance != 275 || m.VIPTier != "Silver" {
		t.Fatalf("mapped = %+v", m)
	}
	if m.SourceID != "rivo://customer/42" {
		t.Fatalf("source id = %q", m.SourceID)
	}
}

func TestReferralCandyBackfillSignsAndMapsReferrers(t *testing.T) {
	var gotAccessID, gotSignature, gotTimestamp string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccessID = r.URL.Query().Get("accessID")
		gotSignature = r.URL.Query().Get("signature")
		gotTimestamp = r.URL.Query().Get("timestamp")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"referrers": []map[string]any{
				{"email": "Bo@Example.com", "name": "Bo R", "referral_code": "BO-123", "rewards_count": 3},
			},
		})
	}))
	defer srv.Close()

	fixed := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	backfiller := ReferralCandyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ReferralCandySecretsCredentialResolver{Secrets: fakeMoreLoyaltySecretResolver{json: `{"access_id":"acc-1","secret_key":"sek"}`}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return fixed },
	}
	req, err := backfiller.BackfillPage(context.Background(), "t", Integration{Provider: ProviderReferralCandy, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotAccessID != "acc-1" || gotSignature == "" || gotTimestamp == "" {
		t.Fatalf("accessID=%q signature=%q timestamp=%q", gotAccessID, gotSignature, gotTimestamp)
	}
	// Signature must match the canonical ReferralCandy parameter signer.
	wantSig := ReferralCandyParameterSignature("sek", map[string]string{
		"accessID": "acc-1", "timestamp": gotTimestamp, "page": "1",
	})
	if gotSignature != wantSig {
		t.Fatalf("signature = %q want %q", gotSignature, wantSig)
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "bo@example.com" || m.ReferralCode != "BO-123" || m.FullName != "Bo R" {
		t.Fatalf("mapped = %+v", m)
	}
	if m.SourceID != "referralcandy://referrer/bo@example.com" {
		t.Fatalf("source id = %q", m.SourceID)
	}
}

// ReferralCandy sends no page-size param, so termination must be "page until an
// empty page" — a short non-empty first page must not be treated as the last
// (which would silently drop every later page).
func TestReferralCandyPaginatesUntilEmptyPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "1" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"referrers": []map[string]any{
					{"email": "a@example.com", "name": "A"},
					{"email": "b@example.com", "name": "B"},
				},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"referrers": []map[string]any{}})
	}))
	defer srv.Close()

	backfiller := ReferralCandyRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ReferralCandySecretsCredentialResolver{Secrets: fakeMoreLoyaltySecretResolver{json: `{"access_id":"acc-1","secret_key":"sek"}`}},
		APIBaseURL:  srv.URL,
		Now:         func() time.Time { return time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC) },
	}
	integ := Integration{Provider: ProviderReferralCandy, CredentialsRef: "c"}
	req, err := backfiller.BackfillPage(context.Background(), "t", integ, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(req.Members) != 2 {
		t.Fatalf("page 1 members = %d", len(req.Members))
	}
	if req.Cursor != referralCandyCursorPrefix+"2" {
		t.Fatalf("page 1 cursor = %q, want advance to page 2", req.Cursor)
	}
	req2, err := backfiller.BackfillPage(context.Background(), "t", integ, req.Cursor)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if req2.Cursor != referralCandyCursorComplete {
		t.Fatalf("page 2 cursor = %q, want complete on empty page", req2.Cursor)
	}
}
