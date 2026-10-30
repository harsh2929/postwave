// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_verbs_test.go — DB-free unit coverage for SUB-099 (undo) + SUB-100
// (extended bulk verbs): token minting, snapshot coercion helpers, consent
// vocabulary gating, and the pre-DB validation/auth branches of every new
// handler (these reject before any pool access, so they run without a live
// Postgres).

package subscribers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// --- newRecoveryToken: 64-char hex, unique per call ---

func TestNewRecoveryToken_ShapeAndUniqueness(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		tok, err := newRecoveryToken()
		if err != nil {
			t.Fatalf("newRecoveryToken: %v", err)
		}
		if len(tok) != 64 {
			t.Fatalf("token len = %d, want 64 (32 bytes hex)", len(tok))
		}
		for _, c := range tok {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
				t.Fatalf("token has non-hex char %q: %s", c, tok)
			}
		}
		if seen[tok] {
			t.Fatalf("duplicate token minted: %s", tok)
		}
		seen[tok] = true
	}
}

// --- coerceStringList: JSON round-trip []any -> []string ---

func TestCoerceStringList(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want int
	}{
		{"nil", nil, 0},
		{"wrong type", "not-a-list", 0},
		{"empty slice", []any{}, 0},
		{"strings", []any{"a", "b", "c"}, 3},
		{"drops blanks", []any{"a", "", "b"}, 2},
		{"drops non-strings", []any{"a", 7, "b", nil}, 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := coerceStringList(c.in)
			if len(got) != c.want {
				t.Fatalf("len = %d, want %d (%v)", len(got), c.want, got)
			}
		})
	}
}

// --- recoveryTagArgs: exact post-mutation revisions, never legacy ids ---

func TestRecoveryTagArgs(t *testing.T) {
	first := time.Date(2026, 7, 19, 5, 0, 0, 123, time.UTC)
	second := first.Add(time.Microsecond)
	rows, tag := recoveryTagArgs(map[string]any{
		"rows": []any{
			map[string]any{"id": "id-1", "updated_at": first.Format(time.RFC3339Nano)},
			map[string]any{"id": "id-2", "updated_at": second.Format(time.RFC3339Nano)},
		},
		"tag": " vip ",
	})
	if tag != "vip" {
		t.Fatalf("tag = %q, want vip", tag)
	}
	if len(rows) != 2 || rows[0].ID != "id-1" || rows[1].ID != "id-2" ||
		!rows[0].UpdatedAt.Equal(first) || !rows[1].UpdatedAt.Equal(second) {
		t.Fatalf("rows = %+v, want exact version-bound rows", rows)
	}
	// Historical id-only receipts fail closed because no exact revision was
	// captured; duplicate/malformed revisions do the same.
	for _, snapshot := range []map[string]any{
		{"ids": []any{"id-1"}, "tag": "vip"},
		{"rows": []any{map[string]any{"id": "id-1"}}, "tag": "vip"},
		{"rows": []any{
			map[string]any{"id": "id-1", "updated_at": first.Format(time.RFC3339Nano)},
			map[string]any{"id": "id-1", "updated_at": second.Format(time.RFC3339Nano)},
		}, "tag": "vip"},
	} {
		rows, _ = recoveryTagArgs(snapshot)
		if len(rows) != 0 {
			t.Fatalf("unsafe snapshot produced recoverable rows: %+v", rows)
		}
	}
}

func TestReplayRecovery_LegacyTerminalTokensFailClosed(t *testing.T) {
	d := &Deps{}
	for _, operation := range []string{"delete", "unsubscribe"} {
		t.Run(operation, func(t *testing.T) {
			// The historical snapshot deliberately carries enough data to prove
			// that the terminal branch does not inspect or reconstruct it. A nil
			// tx is safe only when no database operation is attempted.
			restored, err := d.replayRecovery(context.Background(), nil, "tenant-id", operation, map[string]any{
				"rows": []any{map[string]any{
					"id":    "erased-subscriber-id",
					"email": "erased@example.test",
				}},
				"emails": []any{"erased@example.test"},
			})
			if err != nil {
				t.Fatalf("legacy %s recovery returned an error: %v", operation, err)
			}
			if restored != 0 {
				t.Fatalf("legacy %s recovery restored %d rows, want zero", operation, restored)
			}
		})
	}
}

// --- consent vocabulary gates ---

func TestConsentVocabulary(t *testing.T) {
	for _, ok := range []string{"email_marketing", "ai_processing", "targeted_advertising", "sensitive_data"} {
		if !consentCategories[ok] {
			t.Errorf("category %q should be accepted", ok)
		}
	}
	for _, bad := range []string{"", "spam", "EMAIL_MARKETING", "marketing_email"} {
		if consentCategories[bad] {
			t.Errorf("category %q should be rejected", bad)
		}
	}
	for _, ok := range []string{"web", "mobile", "desktop", "email", "import", "api"} {
		if !consentChannels[ok] {
			t.Errorf("channel %q should be accepted", ok)
		}
	}
	if consentChannels["sms"] {
		t.Error("channel sms should be rejected")
	}
}

func validConsentProvenance() ConsentProvenanceInput {
	when := time.Date(2026, 7, 1, 10, 30, 0, 0, time.UTC)
	return ConsentProvenanceInput{
		Source:        "double_optin",
		Channel:       "email",
		LegalBasis:    "consent",
		OccurredAt:    &when,
		Jurisdiction:  "gb",
		Evidence:      "receipt:consent-123",
		Reason:        "Reviewed the double opt-in receipt.",
		PolicyVersion: "privacy-2026-07",
	}
}

func TestNormalizeConsentProvenance_FailsClosed(t *testing.T) {
	base := validConsentProvenance()
	cases := []struct {
		name string
		edit func(*ConsentProvenanceInput)
	}{
		{"missing source", func(in *ConsentProvenanceInput) { in.Source = "" }},
		{"inferred admin source", func(in *ConsentProvenanceInput) { in.Source = "admin" }},
		{"missing channel", func(in *ConsentProvenanceInput) { in.Channel = "" }},
		{"missing legal basis", func(in *ConsentProvenanceInput) { in.LegalBasis = "" }},
		{"missing occurred at", func(in *ConsentProvenanceInput) { in.OccurredAt = nil }},
		{"future occurred at", func(in *ConsentProvenanceInput) {
			future := time.Now().UTC().Add(10 * time.Minute)
			in.OccurredAt = &future
		}},
		{"missing jurisdiction", func(in *ConsentProvenanceInput) { in.Jurisdiction = "" }},
		{"missing evidence", func(in *ConsentProvenanceInput) { in.Evidence = "" }},
		{"missing reason", func(in *ConsentProvenanceInput) { in.Reason = "" }},
		{"missing policy", func(in *ConsentProvenanceInput) { in.PolicyVersion = "" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			tc.edit(&in)
			if err := normalizeConsentProvenance(&in, true); err == nil {
				t.Fatal("expected invalid provenance to be rejected")
			}
		})
	}
	got := base
	if err := normalizeConsentProvenance(&got, true); err != nil {
		t.Fatalf("complete provenance rejected: %v", err)
	}
	if got.Jurisdiction != "GB" || got.OccurredAt == nil || got.OccurredAt.Location() != time.UTC {
		t.Fatalf("provenance was not canonicalized: %+v", got)
	}
}

func TestBulkConsentAndResubscribe_RejectMissingEvidenceBeforeDB(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	// Keep the assertions explicit so a handler cannot accidentally reach a
	// nil database before validating provenance.
	resubscribe := httptest.NewRecorder()
	d.BulkResubscribe(resubscribe, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"]}`))
	if resubscribe.Code != http.StatusBadRequest {
		t.Fatalf("resubscribe status = %d, want 400", resubscribe.Code)
	}
	grant := httptest.NewRecorder()
	d.BulkGrantConsent(grant, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"],"category":"email_marketing"}`))
	if grant.Code != http.StatusBadRequest {
		t.Fatalf("grant status = %d, want 400", grant.Code)
	}
}

// --- resolveAudience validation (explicit-ids path is DB-free) ---

func TestResolveAudience_Validation(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	ctx := context.Background()

	// Both supplied -> error.
	if _, _, err := d.resolveAudience(ctx, "t1", BulkTarget{SubscriberIDs: []string{"a"}, SegmentID: "s1"}); err == nil {
		t.Error("both ids+segment should error")
	}
	// Neither supplied -> error.
	if _, _, err := d.resolveAudience(ctx, "t1", BulkTarget{}); err == nil {
		t.Error("neither ids nor segment should error")
	}
	// Over the cap -> error.
	big := make([]string, MaxBulkIDs+1)
	if _, _, err := d.resolveAudience(ctx, "t1", BulkTarget{SubscriberIDs: big}); err == nil {
		t.Error("over MaxBulkIDs should error")
	}
	// Valid explicit ids -> source explicit_ids, no DB hit.
	firstID := "00000000-0000-4000-8000-000000000001"
	secondID := "00000000-0000-4000-8000-000000000002"
	ids, source, err := d.resolveAudience(ctx, "t1", BulkTarget{SubscriberIDs: []string{firstID, secondID, firstID}})
	if err != nil {
		t.Fatalf("valid explicit ids: %v", err)
	}
	if source != "explicit_ids" || len(ids) != 2 {
		t.Fatalf("source=%q ids=%v, want explicit_ids/2 deduplicated", source, ids)
	}
	if _, _, err := d.resolveAudience(ctx, "t1", BulkTarget{SubscriberIDs: []string{"not-a-uuid"}}); err == nil {
		t.Fatal("malformed subscriber id should fail validation")
	}
}

// --- handler auth/validation branches (reject before any pool access) ---

func TestBulkVerbHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	cases := []struct {
		name string
		fn   func(*httptest.ResponseRecorder)
	}{
		{"recover", func(rec *httptest.ResponseRecorder) {
			d.BulkRecover(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/recover", nil))
		}},
		{"resubscribe", func(rec *httptest.ResponseRecorder) {
			d.BulkResubscribe(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/resubscribe", nil))
		}},
		{"set-custom-field", func(rec *httptest.ResponseRecorder) {
			d.BulkSetCustomField(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/set-custom-field", nil))
		}},
		{"update-merge-field", func(rec *httptest.ResponseRecorder) {
			d.BulkUpdateMergeField(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/update-merge-field", nil))
		}},
		{"grant-consent", func(rec *httptest.ResponseRecorder) {
			d.BulkGrantConsent(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/grant-consent", nil))
		}},
		{"revoke-consent", func(rec *httptest.ResponseRecorder) {
			d.BulkRevokeConsent(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/revoke-consent", nil))
		}},
		{"export-by-segment", func(rec *httptest.ResponseRecorder) {
			d.BulkExportBySegment(rec, httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/bulk/export-by-segment", nil))
		}},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		c.fn(rec)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status = %d, want 401 without tenant", c.name, rec.Code)
		}
	}
}

// BulkRecover rejects a missing/blank token with 400 (after tenant context),
// before any pool access.
func TestBulkRecover_MissingToken(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.BulkRecover(rec, subscriberTenantRequest(http.MethodPost, "/api/v1/subscribers/bulk/recover", `{"recovery_token":"   "}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for blank token", rec.Code)
	}
}

// set-custom-field / update-merge-field reject a missing key with 400 before
// any pool access.
func TestBulkJSONField_MissingKey(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	for _, tc := range []struct {
		name string
		fn   func(*httptest.ResponseRecorder)
	}{
		{"custom", func(rec *httptest.ResponseRecorder) {
			d.BulkSetCustomField(rec, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"],"value":1}`))
		}},
		{"merge", func(rec *httptest.ResponseRecorder) {
			d.BulkUpdateMergeField(rec, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"],"value":1}`))
		}},
	} {
		rec := httptest.NewRecorder()
		tc.fn(rec)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 for missing key", tc.name, rec.Code)
		}
	}
}

// grant/revoke-consent reject an out-of-vocabulary category with 400 before
// any pool access.
func TestBulkConsent_InvalidCategory(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.BulkGrantConsent(rec, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"],"category":"nope"}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for invalid category", rec.Code)
	}
	// Missing category likewise rejected.
	rec = httptest.NewRecorder()
	d.BulkRevokeConsent(rec, subscriberTenantRequest(http.MethodPost, "/x", `{"subscriber_ids":["a"]}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for missing category", rec.Code)
	}
}
