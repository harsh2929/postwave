// SPDX-License-Identifier: AGPL-3.0-only
//
// frequency_preference_test.go — SUB-132 (subscriber-level frequency
// preference exposure + write) and SUB-134 (preference-topics hydration).
//
// Pure-function coverage of the frequency_preference / paused_until JSON
// shape + the normalizeUpdate validation gate, plus pg-backed coverage that
// PATCH persists the columns, that paused_until can be set/cleared, and that
// ListSubscriberTopics resolves the per-topic opt-in state with the
// default_opt_in fallback. The DB tests skip cleanly without DATABASE_URL.

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestSubscriberFrequencyPreferenceSerialises pins SUB-132: frequency_preference
// is always present (non-pointer) and paused_until is omitted from JSON when
// nil but present when set. preference_topics is omitted when nil.
func TestSubscriberFrequencyPreferenceSerialises(t *testing.T) {
	b, err := json.Marshal(Subscriber{Email: "x@example.com", FrequencyPreference: "default"})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, `"frequency_preference":"default"`) {
		t.Errorf("frequency_preference must always serialise; got %s", s)
	}
	if strings.Contains(s, `"paused_until"`) {
		t.Errorf("nil paused_until must be omitted; got %s", s)
	}
	if strings.Contains(s, `"preference_topics"`) {
		t.Errorf("nil preference_topics must be omitted; got %s", s)
	}

	until := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	b2, _ := json.Marshal(Subscriber{
		Email:               "x@example.com",
		FrequencyPreference: "paused",
		PausedUntil:         &until,
		PreferenceTopics: []SubscriberTopicView{
			{TopicID: "t1", Slug: "news", Name: "News", DefaultOptIn: true, OptedIn: false},
		},
	})
	s2 := string(b2)
	if !strings.Contains(s2, `"paused_until"`) {
		t.Errorf("set paused_until must serialise; got %s", s2)
	}
	if !strings.Contains(s2, `"preference_topics"`) || !strings.Contains(s2, `"slug":"news"`) {
		t.Errorf("preference_topics must serialise; got %s", s2)
	}
}

// TestNormalizeUpdate_FrequencyPreference pins the SUB-132 validation gate:
// a recognised value passes (and is lowercased/trimmed), an unknown value is
// rejected, and an omitted value is a no-op.
func TestNormalizeUpdate_FrequencyPreference(t *testing.T) {
	valid := "  Paused "
	in := UpdateInput{FrequencyPreference: &valid}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("valid frequency_preference rejected: %v", err)
	}
	if in.FrequencyPreference == nil || *in.FrequencyPreference != "paused" {
		t.Errorf("frequency_preference not normalised; got %v", in.FrequencyPreference)
	}

	bad := "hourly"
	inBad := UpdateInput{FrequencyPreference: &bad}
	if err := normalizeUpdate(&inBad); err == nil {
		t.Error("unknown frequency_preference accepted; want validation error")
	}

	var none UpdateInput
	if err := normalizeUpdate(&none); err != nil {
		t.Fatalf("omitted frequency_preference should be a no-op: %v", err)
	}
	if none.FrequencyPreference != nil {
		t.Errorf("omitted frequency_preference should stay nil; got %v", none.FrequencyPreference)
	}
}

// TestNormalizeUpdate_PauseDays pins SUB-135 vacation mode: a valid pause_days
// computes paused_until = now + days and pins frequency_preference to 'paused'
// when unset; out-of-range values 422; pause_days + clear_paused_until is
// rejected; and an explicit frequency_preference is preserved.
func TestNormalizeUpdate_PauseDays(t *testing.T) {
	// Happy path: pause_days=30 sets paused_until ~30d out and pins 'paused'.
	in := UpdateInput{PauseDays: 30}
	before := time.Now().UTC()
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("valid pause_days rejected: %v", err)
	}
	if in.PausedUntil == nil {
		t.Fatal("pause_days did not compute paused_until")
	}
	got := in.PausedUntil.Sub(before)
	if got < 29*24*time.Hour || got > 31*24*time.Hour {
		t.Errorf("paused_until offset = %v; want ~30 days", got)
	}
	if in.FrequencyPreference == nil || *in.FrequencyPreference != "paused" {
		t.Errorf("pause_days should pin frequency_preference=paused; got %v", in.FrequencyPreference)
	}

	// Bounds: 0 is a no-op (not vacation mode); 366 and negative are rejected.
	var none UpdateInput
	if err := normalizeUpdate(&none); err != nil {
		t.Fatalf("pause_days=0 should be a no-op: %v", err)
	}
	if none.PausedUntil != nil {
		t.Errorf("pause_days=0 must not set paused_until; got %v", none.PausedUntil)
	}
	for _, bad := range []int{-5, -1, 366, 1000} {
		inBad := UpdateInput{PauseDays: bad}
		if err := normalizeUpdate(&inBad); err == nil {
			t.Errorf("pause_days=%d accepted; want 422", bad)
		}
	}

	// Mutually exclusive with clear_paused_until.
	inConflict := UpdateInput{PauseDays: 10, ClearPausedUntil: true}
	if err := normalizeUpdate(&inConflict); err == nil {
		t.Error("pause_days + clear_paused_until accepted; want rejection")
	}

	// An explicit frequency_preference is preserved (not overwritten to paused).
	weekly := "weekly"
	inExplicit := UpdateInput{PauseDays: 7, FrequencyPreference: &weekly}
	if err := normalizeUpdate(&inExplicit); err != nil {
		t.Fatalf("pause_days with explicit pref rejected: %v", err)
	}
	if inExplicit.FrequencyPreference == nil || *inExplicit.FrequencyPreference != "weekly" {
		t.Errorf("explicit frequency_preference overwritten; got %v", inExplicit.FrequencyPreference)
	}
	if inExplicit.PausedUntil == nil {
		t.Error("pause_days should still compute paused_until with explicit pref")
	}
}

// TestValidFrequencyPreference pins the migration 0180 CHECK vocabulary.
func TestValidFrequencyPreference(t *testing.T) {
	for _, ok := range []string{"default", "weekly", "monthly", "paused"} {
		if !ValidFrequencyPreference(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "daily", "DEFAULT", "none"} {
		if ValidFrequencyPreference(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

// ---- DB-backed coverage -----------------------------------------------------

func newFreqPrefTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed frequency_preference test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedFreqPrefTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
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
VALUES ($1::uuid, 'freqpref-test', 'freqpref-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestUpdate_FrequencyPreference_Persists pins SUB-132: a PATCH that sets
// frequency_preference + paused_until persists both on the row, the detail GET
// reads them back, and clear_paused_until drops the timestamp while keeping the
// preference.
func TestUpdate_FrequencyPreference_Persists(t *testing.T) {
	pool := newFreqPrefTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00f2e0c13301"
	seedFreqPrefTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	email := fmt.Sprintf("freqpref-%d@example.test", time.Now().UnixNano())
	sub, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if sub.FrequencyPreference != "default" {
		t.Errorf("fresh subscriber frequency_preference = %q; want default", sub.FrequencyPreference)
	}
	if sub.PausedUntil != nil {
		t.Errorf("fresh subscriber paused_until = %v; want nil", sub.PausedUntil)
	}

	until := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	paused := "paused"
	updated, err := r.Update(ctx, tenantID, sub.ID, UpdateInput{
		FrequencyPreference: &paused,
		PausedUntil:         &until,
	})
	if err != nil {
		t.Fatalf("Update set paused: %v", err)
	}
	if updated.FrequencyPreference != "paused" {
		t.Errorf("frequency_preference = %q; want paused", updated.FrequencyPreference)
	}
	if updated.PausedUntil == nil || !updated.PausedUntil.UTC().Truncate(time.Second).Equal(until) {
		t.Errorf("paused_until = %v; want %v", updated.PausedUntil, until)
	}

	// Detail GET reads them back from the row.
	got, err := r.Get(ctx, tenantID, sub.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.FrequencyPreference != "paused" || got.PausedUntil == nil {
		t.Errorf("Get did not read back paused state: pref=%q until=%v", got.FrequencyPreference, got.PausedUntil)
	}

	// clear_paused_until drops the timestamp but keeps the preference.
	cleared, err := r.Update(ctx, tenantID, sub.ID, UpdateInput{ClearPausedUntil: true})
	if err != nil {
		t.Fatalf("Update clear: %v", err)
	}
	if cleared.PausedUntil != nil {
		t.Errorf("paused_until = %v after clear; want nil", cleared.PausedUntil)
	}
	if cleared.FrequencyPreference != "paused" {
		t.Errorf("frequency_preference = %q after clear; want paused (unchanged)", cleared.FrequencyPreference)
	}
}

// TestListSubscriberTopics_DefaultFallback pins SUB-134: ListSubscriberTopics
// returns one row per tenant topic, resolving the subscriber's explicit opt-in
// where present and falling back to the topic default otherwise.
func TestListSubscriberTopics_DefaultFallback(t *testing.T) {
	pool := newFreqPrefTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-00f2e0c13302"
	seedFreqPrefTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("topics-%d@example.test", suffix)
	slugOptIn := fmt.Sprintf("news-%d", suffix)
	slugDefault := fmt.Sprintf("promo-%d", suffix)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// Topic A: default_opt_in=true, the subscriber explicitly opts OUT.
	var topicA string
	if err := tx.QueryRow(ctx, `
INSERT INTO topics (tenant_id, slug, name, default_opt_in, display_order)
VALUES ($1::uuid, $2, 'News', true, 1) RETURNING id::text`, tenantID, slugOptIn).Scan(&topicA); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert topic A: %v", err)
	}
	// Topic B: default_opt_in=false, the subscriber has NO explicit row.
	if _, err := tx.Exec(ctx, `
INSERT INTO topics (tenant_id, slug, name, default_opt_in, display_order)
VALUES ($1::uuid, $2, 'Promotions', false, 2)`, tenantID, slugDefault); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert topic B: %v", err)
	}
	// Explicit opt-out on topic A.
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_topics (tenant_id, subscriber_email, topic_id, opted_in)
VALUES ($1::uuid, $2::citext, $3::uuid, false)`, tenantID, email, topicA); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("insert subscriber_topics: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit topics fixtures: %v", err)
	}

	r := &Repo{Pool: pool}
	views, err := r.ListSubscriberTopics(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("ListSubscriberTopics: %v", err)
	}
	bySlug := map[string]SubscriberTopicView{}
	for _, v := range views {
		bySlug[v.Slug] = v
	}
	a, ok := bySlug[slugOptIn]
	if !ok {
		t.Fatalf("topic %q missing from %v", slugOptIn, views)
	}
	if a.OptedIn {
		t.Errorf("topic A opted_in = true; want false (explicit opt-out beats default true)")
	}
	if !a.DefaultOptIn {
		t.Errorf("topic A default_opt_in = false; want true")
	}
	b, ok := bySlug[slugDefault]
	if !ok {
		t.Fatalf("topic %q missing from %v", slugDefault, views)
	}
	if b.OptedIn {
		t.Errorf("topic B opted_in = true; want false (no explicit row -> default false)")
	}
}
