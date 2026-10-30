// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the audience-syncs surface (A13): input validation,
// secret masking, batch chunking, and the HMAC-signed webhook delivery
// path. DB-backed paths (repo CRUD, member resolution, scheduler scan)
// are exercised against a live pool elsewhere; everything here runs
// hermetically.
package audience_destinations

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func strPtr(s string) *string { return &s }

func TestValidateSchedule(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"", ScheduleManual, false},
		{"manual", ScheduleManual, false},
		{"  Hourly ", ScheduleHourly, false},
		{"DAILY", ScheduleDaily, false},
		{"weekly", "", true},
		{"cron", "", true},
	}
	for _, c := range cases {
		got, err := validateSchedule(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("validateSchedule(%q): want error, got %q", c.in, got)
			} else if !errors.Is(err, ErrInvalidInput) {
				t.Errorf("validateSchedule(%q): error not ErrInvalidInput: %v", c.in, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("validateSchedule(%q): unexpected error %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("validateSchedule(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestValidateDestinationURL(t *testing.T) {
	cases := []struct {
		name         string
		url          string
		requireHTTPS bool
		wantErr      bool
	}{
		{"https ok", "https://example.com/hook", true, false},
		{"http ok in dev", "http://localhost:9999/hook", false, false},
		{"http rejected when https required", "http://example.com/hook", true, true},
		{"empty", "", false, true},
		{"too long", "https://example.com/" + strings.Repeat("x", 2048), false, true},
		{"embedded creds", "https://user:pass@example.com/hook", false, true},
		{"bad scheme", "ftp://example.com/hook", false, true},
		{"no host", "https://", false, true},
		{"garbage", "not a url", false, true},
	}
	for _, c := range cases {
		err := validateDestinationURL(c.url, c.requireHTTPS)
		if c.wantErr && err == nil {
			t.Errorf("%s: want error, got nil", c.name)
		}
		if !c.wantErr && err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
		}
		if c.wantErr && err != nil && !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: error not ErrInvalidInput: %v", c.name, err)
		}
	}
}

func TestValidateSourceXOR(t *testing.T) {
	if err := validateSource(SyncSource{}); err == nil {
		t.Error("empty source: want error")
	}
	if err := validateSource(SyncSource{ListID: strPtr("a"), SegmentID: strPtr("b")}); err == nil {
		t.Error("both set: want error")
	}
	if err := validateSource(SyncSource{ListID: strPtr(" ")}); err == nil {
		t.Error("whitespace-only list_id: want error")
	}
	if err := validateSource(SyncSource{ListID: strPtr("a")}); err != nil {
		t.Errorf("list only: unexpected error %v", err)
	}
	if err := validateSource(SyncSource{SegmentID: strPtr("b")}); err != nil {
		t.Errorf("segment only: unexpected error %v", err)
	}
}

func validInput() SyncCreateInput {
	return SyncCreateInput{
		Name:   "My sync",
		Source: SyncSource{ListID: strPtr("00000000-0000-0000-0000-000000000001")},
		Destination: SyncDestination{
			URL:    "https://example.com/hook",
			Secret: "shh-super-secret",
		},
		Schedule: "hourly",
	}
}

func TestValidateCreate(t *testing.T) {
	in := validInput()
	if err := validateCreate(&in, true); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	if in.Destination.Type != DestinationTypeWebhook {
		t.Errorf("type not defaulted to webhook: %q", in.Destination.Type)
	}
	if in.Schedule != ScheduleHourly {
		t.Errorf("schedule = %q, want hourly", in.Schedule)
	}

	in = validInput()
	in.Name = "   "
	if err := validateCreate(&in, true); err == nil {
		t.Error("blank name accepted")
	}

	in = validInput()
	in.Name = strings.Repeat("n", 201)
	if err := validateCreate(&in, true); err == nil {
		t.Error("201-char name accepted")
	}

	in = validInput()
	in.Destination.Type = "s3"
	if err := validateCreate(&in, true); err == nil {
		t.Error("unsupported destination type accepted")
	}

	in = validInput()
	in.Destination.Secret = "  "
	if err := validateCreate(&in, true); err == nil {
		t.Error("blank secret accepted")
	}

	in = validInput()
	in.Schedule = ""
	if err := validateCreate(&in, true); err != nil {
		t.Errorf("empty schedule should default to manual: %v", err)
	} else if in.Schedule != ScheduleManual {
		t.Errorf("schedule = %q, want manual", in.Schedule)
	}
}

// TestValidateCreatePlatformDestination pins the SUB-113 gap #3 change:
// platform destination types are no longer hardcoded to webhook — they are
// accepted and validated, require a config block, and do NOT require a
// webhook URL/secret.
func TestValidateCreatePlatformDestination(t *testing.T) {
	for _, dtype := range []string{
		DestinationTypeMeta, DestinationTypeGoogleAds, DestinationTypeTikTok,
		DestinationTypeLinkedIn, DestinationTypeSnap,
	} {
		in := SyncCreateInput{
			Name:   "Platform sync " + dtype,
			Source: SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
			Destination: SyncDestination{
				Type:   dtype,
				Config: map[string]any{"audience_id": "123", "credentials_ref": "vault://ads/" + dtype},
			},
			Schedule: "daily",
		}
		if err := validateCreate(&in, true); err != nil {
			t.Fatalf("%s: valid platform destination rejected: %v", dtype, err)
		}
		if in.Destination.Type != dtype {
			t.Errorf("%s: type not preserved (got %q)", dtype, in.Destination.Type)
		}
	}

	// Platform destination WITHOUT a config is rejected.
	in := SyncCreateInput{
		Name:        "No config",
		Source:      SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{Type: DestinationTypeMeta},
		Schedule:    "manual",
	}
	if err := validateCreate(&in, true); err == nil {
		t.Error("platform destination without config accepted")
	}

	in = SyncCreateInput{
		Name:   "Raw token",
		Source: SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{
			Type:   DestinationTypeMeta,
			Config: map[string]any{"audience_id": "123", "access_token": "tok"},
		},
		Schedule: "manual",
	}
	if err := validateCreate(&in, true); err == nil {
		t.Error("platform destination accepted raw token config")
	}

	in = SyncCreateInput{
		Name:   "Nested raw token",
		Source: SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{
			Type: DestinationTypeMeta,
			Config: map[string]any{
				"audience_id": "123",
				"oauth":       map[string]any{"access_token": "tok"},
			},
		},
		Schedule: "manual",
	}
	if err := validateCreate(&in, true); err == nil || !strings.Contains(err.Error(), "oauth.access_token") {
		t.Fatalf("nested raw token validation = %v", err)
	}

	in = SyncCreateInput{
		Name:   "Unsafe host override",
		Source: SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{
			Type: DestinationTypeMeta,
			Config: map[string]any{
				"audience_id":     "123",
				"credentials_ref": "vault://ads/meta",
				"api_base":        "https://example.invalid",
			},
		},
		Schedule: "manual",
	}
	if err := validateCreate(&in, true); err == nil || !strings.Contains(err.Error(), "api_base") {
		t.Fatalf("api_base validation = %v", err)
	}

	in = SyncCreateInput{
		Name:   "Unsafe Data Manager host override",
		Source: SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{
			Type: DestinationTypeGoogleAds,
			Config: map[string]any{
				"credentials_ref":       "vault://ads/google",
				"customer_id":           "1234567890",
				"data_manager_api_base": "https://example.invalid",
				"user_list_id":          "999",
			},
		},
		Schedule: "manual",
	}
	if err := validateCreate(&in, true); err == nil || !strings.Contains(err.Error(), "data_manager_api_base") {
		t.Fatalf("data_manager_api_base validation = %v", err)
	}

	// An unknown destination type is still rejected.
	in = SyncCreateInput{
		Name:        "Bad type",
		Source:      SyncSource{SegmentID: strPtr("00000000-0000-0000-0000-000000000009")},
		Destination: SyncDestination{Type: "s3", Config: map[string]any{"x": "y"}},
		Schedule:    "manual",
	}
	if err := validateCreate(&in, true); err == nil {
		t.Error("unknown destination type accepted")
	}
}

// TestNormalizeDestinationType covers the validation helper directly.
func TestNormalizeDestinationType(t *testing.T) {
	cases := map[string]struct {
		want    string
		wantErr bool
	}{
		"":           {DestinationTypeWebhook, false},
		"  webhook ": {DestinationTypeWebhook, false},
		"META":       {DestinationTypeMeta, false},
		"google_ads": {DestinationTypeGoogleAds, false},
		"TikTok":     {DestinationTypeTikTok, false},
		"linkedin":   {DestinationTypeLinkedIn, false},
		"snap":       {DestinationTypeSnap, false},
		"s3":         {"", true},
		"snowflake":  {"", true},
	}
	for in, c := range cases {
		got, err := normalizeDestinationType(in)
		if c.wantErr {
			if err == nil {
				t.Errorf("normalizeDestinationType(%q): want error", in)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizeDestinationType(%q): %v", in, err)
		}
		if got != c.want {
			t.Errorf("normalizeDestinationType(%q) = %q, want %q", in, got, c.want)
		}
	}
}

func TestStripMaskedConfigKeys(t *testing.T) {
	// GAP-1#1: a round-tripped masked config must drop the sentinel keys so
	// they merge as no-ops (preserving the stored secret), while genuinely
	// edited values pass through.
	cfg := map[string]any{
		"credential_ref": configMaskSentinel, // masked → dropped
		"account_id":     "acct_123",         // real value → kept
		"api_key":        "sk_new_value",     // operator typed a new key → kept
		"audience_id":    "aud_1",            // non-secret → kept
	}
	stripMaskedConfigKeys(cfg)
	if _, ok := cfg["credential_ref"]; ok {
		t.Errorf("masked credential_ref should have been stripped, got %v", cfg["credential_ref"])
	}
	if cfg["account_id"] != "acct_123" {
		t.Errorf("account_id should survive, got %v", cfg["account_id"])
	}
	if cfg["api_key"] != "sk_new_value" {
		t.Errorf("a genuinely re-typed api_key must survive, got %v", cfg["api_key"])
	}
	if cfg["audience_id"] != "aud_1" {
		t.Errorf("audience_id should survive, got %v", cfg["audience_id"])
	}
}

func TestMaskSecret(t *testing.T) {
	if got := maskSecret(""); got != "" {
		t.Errorf("empty secret: got %q", got)
	}
	if got := maskSecret("short"); got != "••••" {
		t.Errorf("short secret: got %q", got)
	}
	if got := maskSecret("a-long-secret-abcd"); got != "••••abcd" {
		t.Errorf("long secret: got %q, want ••••abcd", got)
	}
}

// fakeRow lets scanSync run without a database.
type fakeRow struct{ vals []any }

func (f fakeRow) Scan(dest ...any) error {
	if len(dest) != len(f.vals) {
		return errors.New("fakeRow: arity mismatch")
	}
	for i, v := range f.vals {
		switch d := dest[i].(type) {
		case *string:
			*d = v.(string)
		case **string:
			if v == nil {
				*d = nil
			} else {
				s := v.(string)
				*d = &s
			}
		case *bool:
			*d = v.(bool)
		case *time.Time:
			*d = v.(time.Time)
		case **time.Time:
			if v == nil {
				*d = nil
			} else {
				tv := v.(time.Time)
				*d = &tv
			}
		default:
			return errors.New("fakeRow: unsupported dest type")
		}
	}
	return nil
}

// TestScanSyncMasksSecret pins the wire contract: the plaintext secret
// never appears in the serialized Sync — only secret_set + a hint.
func TestScanSyncMasksSecret(t *testing.T) {
	now := time.Now().UTC()
	s, err := scanSync(fakeRow{vals: []any{
		"id-1", "My sync",
		"list-1", nil,
		"webhook", "https://example.com/hook", "topsecret-zzz9",
		"hourly", true,
		nil, "succeeded",
		"",   // required_consent_purpose (feature #2)
		"{}", // destination_config (SUB-113)
		now, now,
	}})
	if err != nil {
		t.Fatalf("scanSync: %v", err)
	}
	// hint = mask + last 4 chars of "topsecret-zzz9" = "zzz9"
	if !s.Destination.SecretSet || s.Destination.SecretHint != "••••zzz9" {
		t.Errorf("secret hint = %q, set = %v", s.Destination.SecretHint, s.Destination.SecretSet)
	}
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "topsecret") {
		t.Fatalf("plaintext secret leaked into JSON: %s", raw)
	}
	if !strings.Contains(string(raw), `"secret_set":true`) {
		t.Errorf("secret_set missing from JSON: %s", raw)
	}
}

func TestChunkRows(t *testing.T) {
	if got := chunkRows(nil, 10); got != nil {
		t.Errorf("empty input: want zero batches, got %d", len(got))
	}
	rows := make([]MemberRow, 1201)
	batches := chunkRows(rows, 500)
	if len(batches) != 3 {
		t.Fatalf("want 3 batches, got %d", len(batches))
	}
	if len(batches[0]) != 500 || len(batches[1]) != 500 || len(batches[2]) != 201 {
		t.Errorf("batch sizes = %d/%d/%d", len(batches[0]), len(batches[1]), len(batches[2]))
	}
	// Non-positive size falls back to SyncBatchSize rather than looping.
	if got := chunkRows(make([]MemberRow, 3), 0); len(got) != 1 {
		t.Errorf("size 0: want 1 batch, got %d", len(got))
	}
}

// TestDeliverBatchSignsAndPosts drives one delivery end-to-end against
// an httptest receiver and verifies headers + the HMAC signature using
// the same verifier customers are pointed at.
func TestDeliverBatchSignsAndPosts(t *testing.T) {
	const secret = "test-signing-secret"
	var gotBody []byte
	var gotSig, gotEvent, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotSig = r.Header.Get(SyncSignatureHeader)
		gotEvent = r.Header.Get(SyncEventHeader)
		gotCT = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	fixed := time.Unix(1_770_000_000, 0)
	sr := &SyncRunner{now: func() time.Time { return fixed }}
	s := &Sync{
		ID:   "sync-1",
		Name: "My sync",
		Destination: SyncDestination{
			Type: DestinationTypeWebhook,
			URL:  srv.URL,
		},
		secret: secret,
	}
	payload := SyncBatchPayload{
		Type: SyncEventType, SyncID: s.ID, SyncName: s.Name,
		RunID: "run-1", Sequence: 1, BatchCount: 1, RowCount: 1,
		SentAt: fixed.UTC(),
		Rows:   []MemberRow{{Email: "a@example.com", Status: "enabled", Tags: []string{}}},
	}
	if err := sr.deliverBatch(context.Background(), s, payload); err != nil {
		t.Fatalf("deliverBatch: %v", err)
	}
	if gotEvent != SyncEventType {
		t.Errorf("event header = %q, want %q", gotEvent, SyncEventType)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type = %q", gotCT)
	}
	if err := outbound_webhooks.VerifySignature(gotSig, gotBody, secret, fixed, 5*time.Minute); err != nil {
		t.Errorf("signature did not verify: %v (header %q)", err, gotSig)
	}
	var decoded SyncBatchPayload
	if err := json.Unmarshal(gotBody, &decoded); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if decoded.Type != SyncEventType || decoded.RowCount != 1 || len(decoded.Rows) != 1 {
		t.Errorf("decoded payload mismatch: %+v", decoded)
	}
}

// TestDeliverBatchRejectsNon2xx pins the "receiver must 2xx" contract.
func TestDeliverBatchRejectsNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()

	sr := &SyncRunner{}
	s := &Sync{
		Destination: SyncDestination{Type: DestinationTypeWebhook, URL: srv.URL},
		secret:      "x",
	}
	err := sr.deliverBatch(context.Background(), s, SyncBatchPayload{})
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("want HTTP 403 error, got %v", err)
	}
}

// TestExecuteFailsWhenSourceMissing pins the ghost-source guard: a
// deleted list/segment must FAIL the run with a clear error instead of
// recording a 'succeeded' run with rows_exported = 0 (the silent state
// the 2026-06-10 desktop audit flagged). The verifier is stubbed; the
// DB-backed half of the check lives in sync_runner_db_test.go.
func TestExecuteFailsWhenSourceMissing(t *testing.T) {
	wantErr := errors.New("source list no longer exists (list abc) — point the sync at a new source or delete it")
	var gotTenant string
	sr := &SyncRunner{
		Repo: &Repo{},
		verifySourceFn: func(_ context.Context, tenantID string, _ *Sync) error {
			gotTenant = tenantID
			return wantErr
		},
	}
	result, err := sr.execute(context.Background(), "t1", &Sync{
		Source:      SyncSource{ListID: strPtr("8b7d3f7e-0000-4000-8000-000000000001")},
		Destination: SyncDestination{Type: DestinationTypeWebhook, URL: "https://example.invalid/hook"},
		secret:      "x",
	}, "run-1")
	if !errors.Is(err, wantErr) {
		t.Fatalf("execute err = %v, want the verifier error", err)
	}
	if result.RowsExported != 0 || result.BatchesSent != 0 {
		t.Errorf("rows/batches = %d/%d, want 0/0 (nothing may be delivered for a missing source)", result.RowsExported, result.BatchesSent)
	}
	if gotTenant != "t1" {
		t.Errorf("verifier tenant = %q, want %q", gotTenant, "t1")
	}
}

// TestExecuteGuards covers the pre-DB guard paths in execute.
func TestExecuteGuards(t *testing.T) {
	sr := &SyncRunner{Repo: &Repo{}}

	_, err := sr.execute(context.Background(), "t1", &Sync{
		Destination: SyncDestination{Type: "s3"},
		secret:      "x",
	}, "run-1")
	if err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Errorf("unsupported type: got %v", err)
	}

	_, err = sr.execute(context.Background(), "t1", &Sync{
		Destination: SyncDestination{Type: DestinationTypeWebhook},
	}, "run-1")
	if err == nil || !strings.Contains(err.Error(), "secret missing") {
		t.Errorf("missing secret: got %v", err)
	}
}
