// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeLoyaltySecretResolver struct{ json string }

func (f fakeLoyaltySecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeLoyaltySecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	switch dst := out.(type) {
	case *smileCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *loyaltyLionCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestSmileBackfillMapsMembers(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"customers": []map[string]any{
				{"id": 91, "email": "Ada@Example.com", "first_name": "Ada", "last_name": "L",
					"state": "active", "points_balance": 320,
					"vip_tier": map[string]any{"name": "Gold"}},
			},
		})
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/customers") || gotAuth != "Bearer smile_tok" {
		t.Fatalf("path=%q auth=%q", gotPath, gotAuth)
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "ada@example.com" || m.PointsBalance != 320 || m.VIPTier != "Gold" {
		t.Fatalf("mapped member = %+v", m)
	}
	if m.SourceID != "smile://customer/91" {
		t.Fatalf("source id = %q", m.SourceID)
	}
	if req.Cursor != smilePointsCursor {
		t.Fatalf("cursor = %q, want points transaction phase", req.Cursor)
	}
}

func TestSmileBackfillMapsPointsTransactions(t *testing.T) {
	var gotPaths []string
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		gotAuth = r.Header.Get("Authorization")
		switch r.URL.Path {
		case "/v1/points_transactions":
			if r.URL.Query().Get("limit") != "2" || r.URL.Query().Get("cursor") != "" {
				t.Fatalf("points query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"points_transactions": []map[string]any{
					{"id": 825673452, "customer_id": 304169228, "points_change": 100, "description": "Points correction", "created_at": "2026-06-28T10:15:27.893Z"},
					{"id": 825673453, "customer_id": 304169228, "points_change": -40, "description": "Reward redemption", "created_at": "2026-06-28T10:16:27.893Z"},
				},
				"metadata": map[string]any{"next_cursor": "next page token"},
			})
		case "/v1/customers/304169228":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{
					"id": 304169228, "email": "Ada@Example.com", "first_name": "Ada",
					"points_balance": 320, "vip_tier": map[string]any{"name": "Gold"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
		PageSize:    2,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, smilePointsCursor)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotAuth != "Bearer smile_tok" {
		t.Fatalf("auth=%q", gotAuth)
	}
	if len(gotPaths) != 2 || gotPaths[0] != "/v1/points_transactions" || gotPaths[1] != "/v1/customers/304169228" {
		t.Fatalf("paths=%+v", gotPaths)
	}
	if len(req.Events) != 2 {
		t.Fatalf("events = %d", len(req.Events))
	}
	if len(req.Members) != 1 || req.Members[0].Email != "ada@example.com" || req.Members[0].PointsBalance != 320 {
		t.Fatalf("member refresh = %+v", req.Members)
	}
	earned := req.Events[0]
	if earned.SourceID != "smile://points_transaction/825673452" ||
		earned.Email != "ada@example.com" ||
		earned.EventName != "loyalty.points_earned" ||
		earned.Points != 100 ||
		earned.VIPTier != "Gold" ||
		earned.OccurredAt == nil ||
		earned.OccurredAt.Format(time.RFC3339Nano) != "2026-06-28T10:15:27.893Z" {
		t.Fatalf("earned event = %+v", earned)
	}
	if req.Events[1].EventName != "loyalty.points_redeemed" || req.Events[1].Points != -40 {
		t.Fatalf("redeemed event = %+v", req.Events[1])
	}
	if req.Cursor != encodeSmilePointsCursor("next page token") {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestSmileBackfillMapsRewardFulfillments(t *testing.T) {
	var gotPaths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPaths = append(gotPaths, r.URL.Path)
		switch r.URL.Path {
		case "/v1/reward_fulfillments":
			if r.URL.Query().Get("cursor") != "reward cursor" {
				t.Fatalf("reward query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"reward_fulfillments": []map[string]any{
					{"id": 625478984, "customer_id": 304169228, "name": "$5 off coupon", "code": "5off-e26d02e39149", "fulfillment_status": "issued", "usage_status": "unused", "created_at": "2026-06-28T11:15:27.893Z"},
					{"id": 625478985, "customer_id": 304169228, "name": "$10 off coupon", "fulfillment_status": "issued", "usage_status": "used", "used_at": "2026-06-28T11:20:27.893Z"},
				},
			})
		case "/v1/customers/304169228":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{
					"id": 304169228, "email": "Ada@Example.com", "points_balance": 320,
					"vip_tier": map[string]any{"name": "Gold"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, encodeSmileRewardsCursor("reward cursor"))
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if len(gotPaths) != 2 || gotPaths[0] != "/v1/reward_fulfillments" || gotPaths[1] != "/v1/customers/304169228" {
		t.Fatalf("paths=%+v", gotPaths)
	}
	if len(req.Events) != 2 {
		t.Fatalf("events = %d", len(req.Events))
	}
	if len(req.Members) != 1 || req.Members[0].Email != "ada@example.com" || req.Members[0].VIPTier != "Gold" {
		t.Fatalf("member refresh = %+v", req.Members)
	}
	issued := req.Events[0]
	if issued.SourceID != "smile://reward_fulfillment/625478984" ||
		issued.Email != "ada@example.com" ||
		issued.EventName != "loyalty.reward_issued" ||
		issued.RewardID != "625478984" ||
		issued.RewardName != "$5 off coupon" ||
		issued.Properties["reward_code"] != "5off-e26d02e39149" {
		t.Fatalf("issued event = %+v", issued)
	}
	if req.Events[1].EventName != "loyalty.reward_redeemed" || req.Events[1].OccurredAt == nil ||
		req.Events[1].OccurredAt.Format(time.RFC3339Nano) != "2026-06-28T11:20:27.893Z" {
		t.Fatalf("redeemed event = %+v", req.Events[1])
	}
	if req.Cursor != smileCursorComplete {
		t.Fatalf("cursor = %q", req.Cursor)
	}
}

func TestSmileRewardFulfillmentEventNameStates(t *testing.T) {
	cases := []struct {
		name   string
		reward smileRewardFulfillment
		want   string
	}{
		{name: "pending", reward: smileRewardFulfillment{FulfillmentStatus: "pending"}, want: "loyalty.reward_pending"},
		{name: "issued unused", reward: smileRewardFulfillment{FulfillmentStatus: "issued", UsageStatus: "unused"}, want: "loyalty.reward_issued"},
		{name: "used", reward: smileRewardFulfillment{FulfillmentStatus: "issued", UsageStatus: "used"}, want: "loyalty.reward_redeemed"},
		{name: "cancelled", reward: smileRewardFulfillment{FulfillmentStatus: "cancelled"}, want: "loyalty.reward_cancelled"},
		{name: "failed", reward: smileRewardFulfillment{FulfillmentStatus: "failed"}, want: "loyalty.reward_failed"},
		{name: "untracked", reward: smileRewardFulfillment{FulfillmentStatus: "unexpected"}, want: "loyalty.reward_issued"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := smileRewardFulfillmentEventName(tc.reward); got != tc.want {
				t.Fatalf("event name=%q want %q", got, tc.want)
			}
		})
	}
}

func TestSmileCompleteCursorPollsIncrementalPointsTransactions(t *testing.T) {
	watermark := time.Date(2026, 6, 28, 11, 0, 0, 0, time.UTC)
	var gotUpdatedAtMin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/points_transactions":
			gotUpdatedAtMin = r.URL.Query().Get("updated_at_min")
			if r.URL.Query().Get("cursor") != "" {
				t.Fatalf("points query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"points_transactions": []map[string]any{
					{"id": 825673454, "customer_id": 304169229, "points_change": 25, "description": "Incremental earn", "updated_at": "2026-06-28T11:15:27.893Z"},
				},
				"metadata": map[string]any{"next_cursor": "points-next"},
			})
		case "/v1/customers/304169229":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{
					"id": 304169229, "email": "Grace@Example.com", "points_balance": 450,
					"vip_tier": map[string]any{"name": "Platinum"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{
		Provider:       ProviderSmile,
		CredentialsRef: "c",
		Settings:       map[string]any{"shop_domain": "acme.myshopify.com"},
		LastSyncAt:     &watermark,
	}, smileCursorComplete)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotUpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("updated_at_min=%q", gotUpdatedAtMin)
	}
	if len(req.Events) != 1 || req.Events[0].EventName != "loyalty.points_earned" || req.Events[0].Email != "grace@example.com" {
		t.Fatalf("events=%+v", req.Events)
	}
	if len(req.Members) != 1 || req.Members[0].Email != "grace@example.com" || req.Members[0].VIPTier != "Platinum" {
		t.Fatalf("members=%+v", req.Members)
	}
	state, ok := decodeSmilePointsCursorState(req.Cursor)
	if !ok || state.Cursor != "points-next" || state.UpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("cursor state ok=%v state=%+v raw=%q", ok, state, req.Cursor)
	}
}

func TestSmilePointsCursorCarriesUpdatedAtMinIntoRewards(t *testing.T) {
	var gotUpdatedAtMin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/points_transactions":
			gotUpdatedAtMin = r.URL.Query().Get("updated_at_min")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"points_transactions": []map[string]any{
					{"id": 825673455, "customer_id": 304169230, "points_change": 10, "updated_at": "2026-06-28T11:20:27.893Z"},
				},
			})
		case "/v1/customers/304169230":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{"id": 304169230, "email": "Lin@Example.com", "points_balance": 25},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	cursor := encodeSmilePointsCursorState(smileEventCursorState{UpdatedAtMin: "2026-06-28T11:00:00Z"})
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, cursor)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotUpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("updated_at_min=%q", gotUpdatedAtMin)
	}
	state, ok := decodeSmileRewardsCursorState(req.Cursor)
	if !ok || state.Cursor != "" || state.UpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("reward cursor state ok=%v state=%+v raw=%q", ok, state, req.Cursor)
	}
}

func TestSmileRewardCursorUsesUpdatedAtMinAndPreservesNextCursor(t *testing.T) {
	var gotCursor, gotUpdatedAtMin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/reward_fulfillments":
			gotCursor = r.URL.Query().Get("cursor")
			gotUpdatedAtMin = r.URL.Query().Get("updated_at_min")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"reward_fulfillments": []map[string]any{
					{"id": 625478986, "customer_id": 304169231, "name": "$15 off coupon", "fulfillment_status": "issued", "usage_status": "unused", "updated_at": "2026-06-28T11:25:27.893Z"},
				},
				"metadata": map[string]any{"next_cursor": "reward-next"},
			})
		case "/v1/customers/304169231":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{"id": 304169231, "email": "Katherine@Example.com", "vip_tier": map[string]any{"name": "Gold"}},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	cursor := encodeSmileRewardsCursorState(smileEventCursorState{Cursor: "reward-cursor", UpdatedAtMin: "2026-06-28T11:00:00Z"})
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, cursor)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if gotCursor != "reward-cursor" || gotUpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("cursor=%q updated_at_min=%q", gotCursor, gotUpdatedAtMin)
	}
	state, ok := decodeSmileRewardsCursorState(req.Cursor)
	if !ok || state.Cursor != "reward-next" || state.UpdatedAtMin != "2026-06-28T11:00:00Z" {
		t.Fatalf("next reward cursor state ok=%v state=%+v raw=%q", ok, state, req.Cursor)
	}
}

func TestSmileBackfillSurfacesRetryAfterOnProviderFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "9")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, "")
	var restErr LoyaltyRESTError
	if !errors.As(err, &restErr) {
		t.Fatalf("expected LoyaltyRESTError, got %T %[1]v", err)
	}
	if restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter.String() != "9s" {
		t.Fatalf("rest error = %+v", restErr)
	}
}

func TestSmilePointsBackfillSurfacesRetryAfterOnProviderFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/points_transactions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Retry-After", "7")
		http.Error(w, "too many points", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	backfiller := SmileRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
		APIBaseURL:  srv.URL,
	}
	_, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderSmile, CredentialsRef: "c", Settings: map[string]any{"shop_domain": "acme.myshopify.com"}}, smilePointsCursor)
	var restErr LoyaltyRESTError
	if !errors.As(err, &restErr) {
		t.Fatalf("expected LoyaltyRESTError, got %T %[1]v", err)
	}
	if restErr.StatusCode != http.StatusTooManyRequests || restErr.RetryAfter.String() != "7s" || !strings.Contains(restErr.Operation, "/v1/points_transactions") {
		t.Fatalf("rest error = %+v", restErr)
	}
}

func TestLoyaltyLionBackfillMapsMembers(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"customers": []map[string]any{
				{"id": 77, "email": "Bo@Example.com", "points_approved": 540,
					"loyalty_tier_membership": map[string]any{"tier": map[string]any{"name": "Platinum"}}},
			},
		})
	}))
	defer srv.Close()

	backfiller := LoyaltyLionRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: LoyaltyLionSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"token":"site_tok","secret":"site_sec"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderLoyaltyLion, CredentialsRef: "c", Settings: map[string]any{"site_id": "9999"}}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("site_tok:site_sec"))
	if !strings.Contains(gotPath, "/customers") || gotAuth != wantAuth {
		t.Fatalf("path=%q auth=%q want=%q", gotPath, gotAuth, wantAuth)
	}
	if len(req.Members) != 1 {
		t.Fatalf("members = %d", len(req.Members))
	}
	m := req.Members[0]
	if m.Email != "bo@example.com" || m.PointsBalance != 540 || m.VIPTier != "Platinum" {
		t.Fatalf("mapped member = %+v", m)
	}
	if m.SourceID != "loyaltylion://customer/77" {
		t.Fatalf("source id = %q", m.SourceID)
	}
}

func TestVerifyLoyaltyLionWebhookExists(t *testing.T) {
	// The verifier already exists (base64 HMAC-SHA256); confirm a valid signature
	// passes and a tampered one fails via the package helper.
	secret := "ll_webhook"
	body := []byte(`{"id":1}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	header := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !VerifyLoyaltyLionWebhookSignature(secret, body, header) {
		t.Fatal("valid signature rejected")
	}
	if VerifyLoyaltyLionWebhookSignature(secret, append(body, '!'), header) {
		t.Fatal("tampered body accepted")
	}
}
