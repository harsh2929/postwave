// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// decaySendRecorder keeps every message deliverEmail hands the mailer. It is
// local to this test rather than decay_worker_test.go's fakeMailer, which
// config/go-lint-baseline.json records as unused: using that one here would
// leave the baseline entry stale, and the lint ratchet fails on stale entries.
type decaySendRecorder struct{ sent []mailer.Message }

func (r *decaySendRecorder) Send(_ context.Context, m mailer.Message) error {
	r.sent = append(r.sent, m)
	return nil
}

// Direct decay emails go to the tenant's owners and admins, so the From they
// carry is only observable once deliverEmail has resolved real recipients. The
// composition root hands the worker the configured platform sender, or "" when
// none is configured; the message must carry the first verbatim and the
// platform default for the second.
func TestDecayEmailCarriesTheWorkerSender_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID := uuid.NewString()
	ownerEmail := "decay-owner-" + tenantID + "@example.test"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for decay sender fixture: %v", err)
	}
	defer func() { _ = seed.Rollback(ctx) }()
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, "decay-sender-"+tenantID); err != nil {
		t.Fatalf("seed decay sender tenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO users (id, tenant_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, 'owner')`, uuid.NewString(), tenantID, ownerEmail); err != nil {
		t.Fatalf("seed decay sender owner: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit decay sender fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	event := DecayEvent{ID: uuid.NewString(), SegmentID: uuid.NewString(), AnomalyKind: AnomalyZeroMatch, PriorCount: 10}
	for _, tc := range []struct{ from, want string }{
		{"", "Moosewave <noreply@moosewave.com>"},
		{"Staging <noreply@staging.example.test>", "Staging <noreply@staging.example.test>"},
	} {
		mail := &decaySendRecorder{}
		worker := &DecayWorker{Pool: pool, Mailer: mail, FromAddress: tc.from}
		worker.deliverEmail(ctx, tenantID, event)
		if len(mail.sent) != 1 {
			t.Fatalf("FromAddress %q: sent %d decay emails, want 1 to the seeded owner", tc.from, len(mail.sent))
		}
		if got := mail.sent[0]; got.To != ownerEmail || got.From != tc.want {
			t.Errorf("FromAddress %q: decay email From=%q To=%q, want From=%q To=%q",
				tc.from, got.From, got.To, tc.want, ownerEmail)
		}
	}
}
