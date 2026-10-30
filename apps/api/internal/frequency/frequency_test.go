// SPDX-License-Identifier: AGPL-3.0-only
//
// frequency_test.go — coverage for the SUB-132 subscriber-level frequency
// preference filter (FilterBySubscriberPreference) and the SUB-133 per-channel
// frequency cap (channel-scoped FilterAudienceForChannel + RecordSendsBatch).
//
// Pure-function tests (channel normalisation / scoping / validation) run with
// no DB. The end-to-end gates need Postgres and skip cleanly without
// DATABASE_URL.

package frequency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ---- pure-function coverage -------------------------------------------------

// TestNormalizeChannel pins the empty→email default + lowercasing/trim used by
// the SUB-133 record + filter paths.
func TestNormalizeChannel(t *testing.T) {
	cases := map[string]string{
		"":      "email",
		"  ":    "email",
		"EMAIL": "email",
		" SMS ": "sms",
		"Push":  "push",
	}
	for in, want := range cases {
		if got := normalizeChannel(in); got != want {
			t.Errorf("normalizeChannel(%q) = %q; want %q", in, got, want)
		}
	}
}

// TestNormalizeChannels pins the SUB-133 rule-scope normalisation: empty input
// defaults to ['email'], duplicates collapse, casing is canonicalised, and an
// unknown channel is rejected with a message.
func TestNormalizeChannels(t *testing.T) {
	if got, msg := normalizeChannels(nil); msg != "" || len(got) != 1 || got[0] != "email" {
		t.Errorf("nil -> (%v,%q); want ([email],\"\")", got, msg)
	}
	if got, msg := normalizeChannels([]string{}); msg != "" || len(got) != 1 || got[0] != "email" {
		t.Errorf("empty -> (%v,%q); want ([email],\"\")", got, msg)
	}
	got, msg := normalizeChannels([]string{"Email", "SMS", "email", " push "})
	if msg != "" {
		t.Fatalf("valid channels rejected: %q", msg)
	}
	want := map[string]bool{"email": true, "sms": true, "push": true}
	if len(got) != 3 {
		t.Fatalf("dedupe failed: %v", got)
	}
	for _, c := range got {
		if !want[c] {
			t.Errorf("unexpected channel %q in %v", c, got)
		}
	}
	if _, msg := normalizeChannels([]string{"carrier-pigeon"}); msg == "" {
		t.Error("unknown channel accepted; want a validation message")
	}
}

func TestNormalizeRuleLabel(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		want      string
		wantError bool
	}{
		{name: "trims", input: "  Daily cap  ", want: "Daily cap"},
		{name: "empty", input: " \t\n ", wantError: true},
		{name: "160 ASCII units", input: strings.Repeat("a", 160), want: strings.Repeat("a", 160)},
		{name: "161 ASCII units", input: strings.Repeat("a", 161), wantError: true},
		{name: "160 multibyte units are not bytes", input: strings.Repeat("é", 160), want: strings.Repeat("é", 160)},
		{name: "160 non-BMP UTF-16 units", input: strings.Repeat("😀", 80), want: strings.Repeat("😀", 80)},
		{name: "162 non-BMP UTF-16 units", input: strings.Repeat("😀", 81), wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, msg := normalizeRuleLabel(tt.input)
			if tt.wantError {
				if msg == "" {
					t.Fatalf("normalizeRuleLabel accepted %q", tt.input)
				}
				return
			}
			if msg != "" {
				t.Fatalf("normalizeRuleLabel rejected valid input: %s", msg)
			}
			if got != tt.want {
				t.Fatalf("normalizeRuleLabel() = %q; want %q", got, tt.want)
			}
		})
	}
}

func TestAdmissionLockStripesAreBoundedAndDeterministic(t *testing.T) {
	emails := make([]string, 100_000)
	for i := range emails {
		emails[i] = fmt.Sprintf("subscriber-%d@example.test", i)
	}
	first := admissionLockStripes(emails)
	second := admissionLockStripes(emails)
	if len(first) == 0 || len(first) > int(frequencyAdmissionLockStripes) {
		t.Fatalf("lock stripes=%d, want 1..%d", len(first), frequencyAdmissionLockStripes)
	}
	if fmt.Sprint(first) != fmt.Sprint(second) {
		t.Fatal("lock stripe selection is not deterministic")
	}
	for i := 1; i < len(first); i++ {
		if first[i] <= first[i-1] {
			t.Fatalf("lock stripes are not unique and ordered at %d: %v", i, first)
		}
	}
}

func TestHandlersRejectInvalidLabelsBeforeDatabase(t *testing.T) {
	tests := []struct {
		name   string
		method string
		label  string
	}{
		{name: "create empty", method: http.MethodPost, label: " \t "},
		{name: "create too long", method: http.MethodPost, label: strings.Repeat("a", 161)},
		{name: "patch empty", method: http.MethodPatch, label: "\n "},
		{name: "patch too long UTF-16", method: http.MethodPatch, label: strings.Repeat("😀", 81)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := map[string]any{"label": tt.label}
			if tt.method == http.MethodPost {
				body["max_sends"] = 3
				body["window_hours"] = 24
			} else {
				body["expected_updated_at"] = "2026-08-30T10:15:16.123456Z"
			}
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatalf("marshal request: %v", err)
			}
			req := httptest.NewRequest(tt.method, "/api/v1/sending/frequency-caps/00000000-0000-4000-8000-000000000003", strings.NewReader(string(encoded)))
			req.Header.Set("Content-Type", "application/json")
			routeContext := chi.NewRouteContext()
			routeContext.URLParams.Add("id", "00000000-0000-4000-8000-000000000003")
			ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeContext)
			req = req.WithContext(middleware.WithTenant(ctx, &middleware.Tenant{
				ID: "00000000-0000-4000-8000-000000000001",
			}))
			rec := httptest.NewRecorder()
			deps := &Deps{}
			if tt.method == http.MethodPost {
				deps.create(rec, req)
			} else {
				deps.patch(rec, req)
			}
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s; want 400", rec.Code, rec.Body.String())
			}
			if body := rec.Body.String(); !strings.Contains(body, `"code":"validation_failed"`) {
				t.Fatalf("body = %s; want validation_failed", body)
			}
		})
	}
}

type scriptedRuleRows struct {
	scanErrors []error
	rowErr     error
	index      int
}

func (r *scriptedRuleRows) Next() bool {
	return r.index < len(r.scanErrors)
}

func (r *scriptedRuleRows) Scan(_ ...any) error {
	err := r.scanErrors[r.index]
	r.index++
	return err
}

func (r *scriptedRuleRows) Err() error {
	return r.rowErr
}

func TestScanRuleRowsFailsClosed(t *testing.T) {
	t.Run("scan failure discards earlier rows", func(t *testing.T) {
		scanErr := errors.New("scan failed")
		rows := &scriptedRuleRows{scanErrors: []error{nil, scanErr}}
		got, err := scanRuleRows(rows)
		if !errors.Is(err, scanErr) {
			t.Fatalf("error = %v; want wrapped scan failure", err)
		}
		if got != nil {
			t.Fatalf("rules = %#v; want nil so a partial list cannot be returned", got)
		}
	})

	t.Run("cursor failure rejects the list", func(t *testing.T) {
		rowErr := errors.New("cursor failed")
		rows := &scriptedRuleRows{rowErr: rowErr}
		got, err := scanRuleRows(rows)
		if !errors.Is(err, rowErr) {
			t.Fatalf("error = %v; want wrapped cursor failure", err)
		}
		if got != nil {
			t.Fatalf("rules = %#v; want nil on cursor failure", got)
		}
	})

	t.Run("empty success remains an empty array", func(t *testing.T) {
		got, err := scanRuleRows(&scriptedRuleRows{})
		if err != nil {
			t.Fatalf("empty rows returned error: %v", err)
		}
		if got == nil || len(got) != 0 {
			t.Fatalf("rules = %#v; want a non-nil empty slice", got)
		}
	})
}

// TestRuleAppliesToChannel pins the scoping rule: an empty Channels set is a
// global cap (applies to every channel), otherwise membership is required.
func TestRuleAppliesToChannel(t *testing.T) {
	global := Rule{Channels: nil}
	for _, ch := range []string{"email", "sms", "push"} {
		if !ruleAppliesToChannel(global, ch) {
			t.Errorf("empty-channel rule should apply to %q", ch)
		}
	}
	emailOnly := Rule{Channels: []string{"email"}}
	if !ruleAppliesToChannel(emailOnly, "email") {
		t.Error("email-only rule should apply to email")
	}
	if ruleAppliesToChannel(emailOnly, "sms") {
		t.Error("email-only rule should NOT apply to sms")
	}
	multi := Rule{Channels: []string{"email", "sms"}}
	if !ruleAppliesToChannel(multi, "sms") {
		t.Error("[email,sms] rule should apply to sms")
	}
	if ruleAppliesToChannel(multi, "push") {
		t.Error("[email,sms] rule should NOT apply to push")
	}
}

// TestFilterBySubscriberPreference_NilPool: an unwired activation-time policy
// store is unknown authority and must never become permission to send.
func TestFilterBySubscriberPreference_NilPool(t *testing.T) {
	cands := []string{"a@x.test", "b@x.test"}
	res, err := FilterBySubscriberPreference(context.Background(), nil, "t", cands)
	if err == nil {
		t.Fatal("nil subscriber-preference store passed recipients through")
	}
	if res.Skipped != 0 || res.Kept != nil || res.Breakdown != nil {
		t.Fatalf("nil store leaked result: %+v", res)
	}
}

func TestFilterBySubscriberPreference_EmptyAudienceNeedsNoStore(t *testing.T) {
	res, err := FilterBySubscriberPreference(context.Background(), nil, "t", nil)
	if err != nil || res.Skipped != 0 || len(res.Kept) != 0 || res.Breakdown != nil {
		t.Fatalf("empty audience result=%+v err=%v, want empty success", res, err)
	}
}

// TestFilterAudienceForChannel_NilPool: a non-empty tenant-cap check requires
// policy storage; a configured callback around a nil store cannot hide it.
func TestFilterAudienceForChannel_NilPool(t *testing.T) {
	cands := []string{"a@x.test"}
	res, err := FilterAudienceForChannel(context.Background(), nil, "t", "sms", cands)
	if err == nil {
		t.Fatal("nil frequency-cap store passed recipients through")
	}
	if res.Skipped != 0 || res.Kept != nil || res.Breakdown != nil {
		t.Fatalf("nil store leaked result: %+v", res)
	}
}

func TestFilterAudienceForChannel_EmptyAudienceNeedsNoStore(t *testing.T) {
	res, err := FilterAudienceForChannel(context.Background(), nil, "t", "sms", nil)
	if err != nil || res.Skipped != 0 || len(res.Kept) != 0 || res.Breakdown != nil {
		t.Fatalf("empty audience result=%+v err=%v, want empty success", res, err)
	}
}

// ---- DB-backed coverage -----------------------------------------------------

func newFreqTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed frequency test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedFreqTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`, tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'freq-test', 'freq-test-' || right($1::text, 12), 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func TestAdmitAndReserveTxLinearizesCampaignAndRetryAdmissions(t *testing.T) {
	pool := newFreqTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedFreqTenant(t, pool, tenantID)
	email := "linearizable-" + strings.ReplaceAll(tenantID, "-", "")[:12] + "@example.test"

	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin admission fixture: %v", err)
	}
	var campaignA, campaignB string
	for _, destination := range []*string{&campaignA, &campaignB} {
		if err := seed.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, 'frequency admission proof', 'proof', 'draft')
RETURNING id::text`, tenantID).Scan(destination); err != nil {
			_ = seed.Rollback(ctx)
			t.Fatalf("insert admission campaign: %v", err)
		}
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active, channels)
VALUES ($1::uuid, 'one send', 1, 24, true, ARRAY['email']::text[])`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("insert admission rule: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit admission fixture: %v", err)
	}

	first, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin first admission: %v", err)
	}
	defer func() { _ = first.Rollback(context.Background()) }()
	firstResult, err := AdmitAndReserveTx(ctx, first, tenantID, campaignA, "email", []string{email})
	if err != nil || firstResult.Skipped != 0 || len(firstResult.ReservationIDs) != 1 {
		t.Fatalf("first admission=%+v err=%v, want one reservation", firstResult, err)
	}

	type admissionOutcome struct {
		result AdmissionResult
		err    error
	}
	secondDone := make(chan admissionOutcome, 1)
	go func() {
		tx, beginErr := db.WithTenant(ctx, pool, tenantID)
		if beginErr != nil {
			secondDone <- admissionOutcome{err: beginErr}
			return
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		result, admitErr := AdmitAndReserveTx(ctx, tx, tenantID, campaignB, "email", []string{email})
		if admitErr == nil {
			admitErr = tx.Commit(ctx)
		}
		secondDone <- admissionOutcome{result: result, err: admitErr}
	}()
	select {
	case outcome := <-secondDone:
		t.Fatalf("competing admission bypassed the held subscriber lock: %+v err=%v", outcome.result, outcome.err)
	case <-time.After(150 * time.Millisecond):
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit first admission: %v", err)
	}
	second := <-secondDone
	if second.err != nil || second.result.Skipped != 1 || len(second.result.Kept) != 0 || len(second.result.ReservationIDs) != 0 {
		t.Fatalf("second admission=%+v err=%v, want capped with no reservation", second.result, second.err)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin reservation verification: %v", err)
	}
	defer func() { _ = verify.Rollback(context.Background()) }()
	var reservations int
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM subscriber_send_log
 WHERE tenant_id = $1::uuid AND subscriber_email = $2::citext`, tenantID, email).Scan(&reservations); err != nil {
		t.Fatalf("count admission reservations: %v", err)
	}
	if reservations != 1 {
		t.Fatalf("admission reservations=%d, want exactly one", reservations)
	}
}

// TestFilterBySubscriberPreference_Gate pins SUB-132 end-to-end: a 'paused'
// subscriber with no paused_until and one paused into the future are both
// excluded; a 'paused' subscriber whose paused_until has elapsed (auto-
// reactivation) and a 'default' subscriber are both kept; and the skip is
// attributed to the subscriber_preference synthetic rule.
func TestFilterBySubscriberPreference_Gate(t *testing.T) {
	pool := newFreqTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00f2e0c13201"
	seedFreqTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	pausedIndef := fmt.Sprintf("paused-indef-%d@example.test", suffix)
	pausedFuture := fmt.Sprintf("paused-future-%d@example.test", suffix)
	pausedElapsed := fmt.Sprintf("paused-elapsed-%d@example.test", suffix)
	normal := fmt.Sprintf("normal-%d@example.test", suffix)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	insert := func(email, pref string, pausedUntil any) {
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source, frequency_preference, paused_until)
VALUES ($1::uuid, $2, 'enabled', 'single_optin', $3, $4)`, tenantID, email, pref, pausedUntil); err != nil {
			t.Fatalf("insert %s: %v", email, err)
		}
	}
	insert(pausedIndef, "paused", nil)
	insert(pausedFuture, "paused", time.Now().UTC().Add(72*time.Hour))
	insert(pausedElapsed, "paused", time.Now().UTC().Add(-1*time.Hour))
	insert(normal, "default", nil)
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixtures: %v", err)
	}

	cands := []string{pausedIndef, pausedFuture, pausedElapsed, normal}
	res, err := FilterBySubscriberPreference(ctx, pool, tenantID, cands)
	if err != nil {
		t.Fatalf("FilterBySubscriberPreference: %v", err)
	}
	if res.Skipped != 2 {
		t.Fatalf("skipped = %d; want 2 (indefinite + future-paused)", res.Skipped)
	}
	keptSet := map[string]bool{}
	for _, e := range res.Kept {
		keptSet[e] = true
	}
	if !keptSet[normal] || !keptSet[pausedElapsed] {
		t.Errorf("kept = %v; want normal + elapsed-pause kept", res.Kept)
	}
	if keptSet[pausedIndef] || keptSet[pausedFuture] {
		t.Errorf("kept = %v; want paused-indef + paused-future excluded", res.Kept)
	}
	if len(res.Breakdown) != 1 || res.Breakdown[0].RuleID != SubscriberPreferenceSkipRule {
		t.Errorf("breakdown = %+v; want one %q entry", res.Breakdown, SubscriberPreferenceSkipRule)
	}
}

// TestFilterAudienceForChannel_PerChannel pins SUB-133: a rule scoped to 'sms'
// with max_sends=1 skips a recipient who has one logged 'sms' send but NOT one
// who has only an 'email' send — proving the channel column partitions the cap.
func TestFilterAudienceForChannel_PerChannel(t *testing.T) {
	pool := newFreqTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00f2e0c13202"
	seedFreqTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	smsHeavy := fmt.Sprintf("sms-heavy-%d@example.test", suffix)
	emailOnly := fmt.Sprintf("email-only-%d@example.test", suffix)

	// A campaign row is needed for the FK on subscriber_send_log.campaign_id.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, 'freq-chan-test', 'freq-chan-subject', 'draft') RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert campaign (schema mismatch?): %v", err)
	}
	// An sms-scoped rule, max 1 send / 24h.
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active, channels)
VALUES ($1::uuid, 'sms cap', 1, 24, true, ARRAY['sms']::text[])`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert rule: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rule/campaign: %v", err)
	}

	// Log one sms send for smsHeavy and one email send for emailOnly.
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{smsHeavy}, "sms"); err != nil {
		t.Fatalf("record sends: %v", err)
	}
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{emailOnly}, "email"); err != nil {
		t.Fatalf("record sends: %v", err)
	}

	cands := []string{smsHeavy, emailOnly}
	res, err := FilterAudienceForChannel(ctx, pool, tenantID, "sms", cands)
	if err != nil {
		t.Fatalf("FilterAudienceForChannel(sms): %v", err)
	}
	if res.Skipped != 1 {
		t.Fatalf("sms-channel skipped = %d; want 1 (only the sms-heavy recipient)", res.Skipped)
	}
	keptSet := map[string]bool{}
	for _, e := range res.Kept {
		keptSet[e] = true
	}
	if keptSet[smsHeavy] {
		t.Errorf("sms-heavy recipient should be capped on the sms channel; kept=%v", res.Kept)
	}
	if !keptSet[emailOnly] {
		t.Errorf("email-only recipient should NOT be capped by an sms rule; kept=%v", res.Kept)
	}

	// The same audience filtered on the email channel: the sms rule does not
	// apply, so nobody is skipped.
	resEmail, err := FilterAudienceForChannel(ctx, pool, tenantID, "email", cands)
	if err != nil {
		t.Fatalf("FilterAudienceForChannel(email): %v", err)
	}
	if resEmail.Skipped != 0 {
		t.Errorf("email-channel skipped = %d; want 0 (no email-scoped rule)", resEmail.Skipped)
	}
}

// TestFilterAudienceForChannel_CrossChannelSharedCap pins the core SUB-133
// promise: a rule scoped to channels=['email','sms'] with max_sends=2 counts
// sends across BOTH channels toward one shared cap. A recipient with one email
// send + one sms send has consumed the budget and is skipped on the next
// dispatch regardless of which channel that dispatch is on; a recipient with a
// single send on either channel is still under cap and kept.
func TestFilterAudienceForChannel_CrossChannelSharedCap(t *testing.T) {
	pool := newFreqTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00f2e0c13203"
	seedFreqTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	mixed := fmt.Sprintf("mixed-%d@example.test", suffix)       // 1 email + 1 sms = at cap
	oneEmail := fmt.Sprintf("oneemail-%d@example.test", suffix) // 1 email = under cap
	oneSMS := fmt.Sprintf("onesms-%d@example.test", suffix)     // 1 sms = under cap

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, status)
VALUES ($1::uuid, 'freq-xchan-test', 'freq-xchan-subject', 'draft') RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert campaign (schema mismatch?): %v", err)
	}
	// A cross-channel rule covering email + sms, max 2 sends / 24h.
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active, channels)
VALUES ($1::uuid, 'cross-channel cap', 2, 24, true, ARRAY['email','sms']::text[])`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert rule: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rule/campaign: %v", err)
	}

	// Log sends across the two channels.
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{mixed}, "email"); err != nil {
		t.Fatalf("record sends: %v", err)
	}
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{mixed}, "sms"); err != nil {
		t.Fatalf("record sends: %v", err)
	}
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{oneEmail}, "email"); err != nil {
		t.Fatalf("record sends: %v", err)
	}
	if err = RecordSendsBatchForChannel(ctx, pool, tenantID, campaignID, []string{oneSMS}, "sms"); err != nil {
		t.Fatalf("record sends: %v", err)
	}

	cands := []string{mixed, oneEmail, oneSMS}

	// Dispatching on the sms channel: the rule applies (sms is in its set) and
	// counts BOTH the email and sms log rows, so `mixed` (1+1) is at the cap
	// of 2 and skipped; the single-send recipients are kept.
	resSMS, err := FilterAudienceForChannel(ctx, pool, tenantID, "sms", cands)
	if err != nil {
		t.Fatalf("FilterAudienceForChannel(sms): %v", err)
	}
	if resSMS.Skipped != 1 {
		t.Fatalf("sms-dispatch skipped = %d; want 1 (the mixed recipient at the shared cap)", resSMS.Skipped)
	}
	smsKept := map[string]bool{}
	for _, e := range resSMS.Kept {
		smsKept[e] = true
	}
	if smsKept[mixed] {
		t.Errorf("mixed recipient (1 email + 1 sms) should hit the shared max_sends=2 cap; kept=%v", resSMS.Kept)
	}
	if !smsKept[oneEmail] || !smsKept[oneSMS] {
		t.Errorf("single-send recipients should be under the shared cap; kept=%v", resSMS.Kept)
	}

	// Dispatching on the email channel: same shared cap, same outcome — the
	// email send counts toward the sms send and vice versa, so `mixed` is
	// skipped here too. This is the cross-channel guarantee: the cap does NOT
	// degrade to email-only.
	resEmail, err := FilterAudienceForChannel(ctx, pool, tenantID, "email", cands)
	if err != nil {
		t.Fatalf("FilterAudienceForChannel(email): %v", err)
	}
	if resEmail.Skipped != 1 {
		t.Fatalf("email-dispatch skipped = %d; want 1 (the same mixed recipient, shared cap)", resEmail.Skipped)
	}
	emailKept := map[string]bool{}
	for _, e := range resEmail.Kept {
		emailKept[e] = true
	}
	if emailKept[mixed] {
		t.Errorf("mixed recipient should be capped on the email dispatch too (shared cap counts the sms send); kept=%v", resEmail.Kept)
	}
}
