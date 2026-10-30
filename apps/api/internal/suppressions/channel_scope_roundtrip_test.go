// SPDX-License-Identifier: AGPL-3.0-only

package suppressions

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestChannelScopeRoundTrip proves GOV-031: an operator-chosen channel/scope
// (via AddWithChannel) is written to the columns and surfaced by
// ListPagedFiltered, while a plain Add defaults to email/marketing.
func TestChannelScopeRoundTrip(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := newSuppressionTestTenant(t, ctx, pool)
	store := &Store{Pool: pool}
	tag := randHex4(t)
	smsEmail := "sms" + tag + "@example.com"
	defEmail := "def" + tag + "@example.com"
	t.Cleanup(func() {
		_ = store.Remove(context.Background(), tenantID, smsEmail)
		_ = store.Remove(context.Background(), tenantID, defEmail)
	})

	// Channel-aware add writes the columns.
	got, err := store.AddWithChannel(ctx, tenantID, smsEmail, ReasonListManual, SourceManual,
		"", nil, nil, ChannelSMS, ScopeTransactional)
	if err != nil {
		t.Fatalf("AddWithChannel: %v", err)
	}
	if got.Channel != ChannelSMS || got.Scope != ScopeTransactional {
		t.Fatalf("returned entry channel/scope = %q/%q, want sms/transactional", got.Channel, got.Scope)
	}

	// Plain add defaults to email/marketing.
	def, err := store.Add(ctx, tenantID, defEmail, ReasonListManual, SourceManual, "", nil, nil)
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if def.Channel != ChannelEmail || def.Scope != ScopeMarketing {
		t.Fatalf("plain add channel/scope = %q/%q, want email/marketing", def.Channel, def.Scope)
	}

	// List surfaces the persisted columns for both rows.
	entries, _, err := store.ListPagedFiltered(ctx, tenantID, "", "", 1, 100)
	if err != nil {
		t.Fatalf("ListPagedFiltered: %v", err)
	}
	byEmail := map[string]Entry{}
	for _, e := range entries {
		byEmail[e.Email] = e
	}
	if e, ok := byEmail[smsEmail]; !ok {
		t.Fatalf("sms row missing from list")
	} else if e.Channel != ChannelSMS || e.Scope != ScopeTransactional {
		t.Fatalf("listed sms row channel/scope = %q/%q, want sms/transactional", e.Channel, e.Scope)
	}
	if e, ok := byEmail[defEmail]; !ok {
		t.Fatalf("default row missing from list")
	} else if e.Channel != ChannelEmail || e.Scope != ScopeMarketing {
		t.Fatalf("listed default row channel/scope = %q/%q, want email/marketing", e.Channel, e.Scope)
	}

	// An invalid channel is rejected cleanly, not surfaced as a DB 500.
	if _, err := store.AddWithChannel(ctx, tenantID, "bad"+tag+"@example.com",
		ReasonListManual, SourceManual, "", nil, nil, Channel("carrier-pigeon"), ScopeMarketing); err == nil {
		t.Fatal("expected invalid channel to error")
	}
}
