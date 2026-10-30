// SPDX-License-Identifier: AGPL-3.0-only

package agent_routines

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type targetSegmentDBFixture struct {
	pool           *db.Pool
	tenantID       string
	otherTenantID  string
	segmentID      string
	otherSegmentID string
	context        context.Context
	cancel         context.CancelFunc
}

func newTargetSegmentDBFixture(t *testing.T) *targetSegmentDBFixture {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed agent-routine target-segment tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		cancel()
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)

	fixture := &targetSegmentDBFixture{
		pool:          pool,
		tenantID:      uuid.NewString(),
		otherTenantID: uuid.NewString(),
		context:       ctx,
		cancel:        cancel,
	}
	t.Cleanup(cancel)
	fixture.seedTenant(t, fixture.tenantID, "primary")
	fixture.seedTenant(t, fixture.otherTenantID, "other")
	fixture.segmentID = fixture.seedSegment(t, fixture.tenantID, "primary")
	fixture.otherSegmentID = fixture.seedSegment(t, fixture.otherTenantID, "other")
	return fixture
}

func (f *targetSegmentDBFixture) seedTenant(t *testing.T, tenantID, label string) {
	t.Helper()
	tx, err := db.WithTenant(f.context, f.pool, tenantID)
	if err != nil {
		t.Fatalf("open %s tenant fixture transaction: %v", label, err)
	}
	defer func() { _ = tx.Rollback(f.context) }()
	if _, err := tx.Exec(f.context, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')`, tenantID,
		"agent-routine-target-"+label, "agent-routine-target-"+tenantID); err != nil {
		t.Fatalf("database role cannot seed tenant-scoped fixtures: %v", err)
	}
	if err := tx.Commit(f.context); err != nil {
		t.Fatalf("commit %s tenant fixture: %v", label, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, f.pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, err := cleanupTx.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err == nil {
			_ = cleanupTx.Commit(cleanupCtx)
		}
	})
}

func (f *targetSegmentDBFixture) seedSegment(t *testing.T, tenantID, label string) string {
	t.Helper()
	tx, err := db.WithTenant(f.context, f.pool, tenantID)
	if err != nil {
		t.Fatalf("open %s segment fixture transaction: %v", label, err)
	}
	defer func() { _ = tx.Rollback(f.context) }()
	var id string
	if err := tx.QueryRow(f.context, `
INSERT INTO segments (tenant_id, name, query_ast)
VALUES (
    $1::uuid,
    $2,
    '{"op":"condition","field":"status","comparator":"equals","value":"enabled"}'::jsonb
)
RETURNING id::text`, tenantID, "agent-routine-target-"+label+"-"+uuid.NewString()).Scan(&id); err != nil {
		t.Fatalf("seed %s segment: %v", label, err)
	}
	if err := tx.Commit(f.context); err != nil {
		t.Fatalf("commit %s segment fixture: %v", label, err)
	}
	return id
}

func targetSegmentRoutineInput(name string, targetSegmentID *string) CreateInput {
	return CreateInput{
		Name:            name,
		Prompt:          "Draft a tenant-safe campaign.",
		Kind:            KindDraftCampaign,
		Schedule:        ScheduleManual,
		TargetSegmentID: targetSegmentID,
	}
}

func targetSegmentID(value string) *string {
	return &value
}

func TestRepoTargetSegmentTenantBoundary_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}

	t.Run("optional and same-tenant targets round-trip", func(t *testing.T) {
		untargeted, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("untargeted", nil), "db-test@example.test")
		if err != nil {
			t.Fatalf("create untargeted routine: %v", err)
		}
		if untargeted.TargetSegmentID != nil {
			t.Fatalf("untargeted target = %v, want nil", *untargeted.TargetSegmentID)
		}

		targeted, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("same-tenant", targetSegmentID(fixture.segmentID)),
			"db-test@example.test")
		if err != nil {
			t.Fatalf("create same-tenant targeted routine: %v", err)
		}
		if targeted.TargetSegmentID == nil || *targeted.TargetSegmentID != fixture.segmentID {
			t.Fatalf("targeted target = %v, want %s", targeted.TargetSegmentID, fixture.segmentID)
		}
	})

	t.Run("missing malformed and cross-tenant targets are indistinguishable", func(t *testing.T) {
		cases := []struct {
			name string
			id   string
		}{
			{name: "missing", id: uuid.NewString()},
			{name: "malformed", id: "not-a-segment-uuid"},
			{name: "cross-tenant", id: fixture.otherSegmentID},
		}
		for _, tc := range cases {
			t.Run("create "+tc.name, func(t *testing.T) {
				_, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
					targetSegmentRoutineInput("invalid-create-"+tc.name, targetSegmentID(tc.id)), "")
				if !errors.Is(err, ErrInvalidTargetSegment) {
					t.Fatalf("create error = %v, want ErrInvalidTargetSegment", err)
				}
			})
		}

		routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("invalid-update", targetSegmentID(fixture.segmentID)), "")
		if err != nil {
			t.Fatalf("create update fixture: %v", err)
		}
		for _, tc := range cases {
			t.Run("update "+tc.name, func(t *testing.T) {
				_, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID,
					UpdateInput{TargetSegmentID: targetSegmentID(tc.id)})
				if !errors.Is(err, ErrInvalidTargetSegment) {
					t.Fatalf("update error = %v, want ErrInvalidTargetSegment", err)
				}
				persisted, getErr := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
				if getErr != nil {
					t.Fatalf("read routine after rejected update: %v", getErr)
				}
				if persisted.TargetSegmentID == nil || *persisted.TargetSegmentID != fixture.segmentID {
					t.Fatalf("rejected update changed target to %v", persisted.TargetSegmentID)
				}
			})
		}
	})

	t.Run("empty string clears an existing target", func(t *testing.T) {
		routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("clear-target", targetSegmentID(fixture.segmentID)), "")
		if err != nil {
			t.Fatalf("create clear fixture: %v", err)
		}
		cleared, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID,
			UpdateInput{TargetSegmentID: targetSegmentID("  ")})
		if err != nil {
			t.Fatalf("clear target: %v", err)
		}
		if cleared.TargetSegmentID != nil {
			t.Fatalf("cleared target = %v, want nil", *cleared.TargetSegmentID)
		}
	})

	t.Run("composite foreign key rejects bypass writes", func(t *testing.T) {
		tx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("open direct-write transaction: %v", err)
		}
		defer func() { _ = tx.Rollback(fixture.context) }()
		var targetIndex string
		if err := tx.QueryRow(fixture.context, `
SELECT COALESCE(to_regclass('agent_routines_tenant_target_segment_idx')::text, '')`).Scan(&targetIndex); err != nil {
			t.Fatalf("inspect target-segment index: %v", err)
		}
		if targetIndex == "" {
			t.Fatal("agent_routines_tenant_target_segment_idx is missing")
		}
		_, err = tx.Exec(fixture.context, `
INSERT INTO agent_routines (
    tenant_id, name, prompt, kind, schedule, target_segment_id
) VALUES ($1::uuid, 'cross-tenant-bypass', 'must fail', 'draft_campaign', 'manual', $2::uuid)`,
			fixture.tenantID, fixture.otherSegmentID)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23503" ||
			pgErr.ConstraintName != "agent_routines_tenant_target_segment_fkey" {
			t.Fatalf("direct cross-tenant insert error = %v, want composite FK violation", err)
		}
	})

	t.Run("target update losing a delete race is rejected without mutation", func(t *testing.T) {
		segmentID := fixture.seedSegment(t, fixture.tenantID, "update-race")
		routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("update-delete-race", targetSegmentID(fixture.segmentID)), "")
		if err != nil {
			t.Fatalf("create update-race fixture: %v", err)
		}
		deleteTx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("open update-race delete transaction: %v", err)
		}
		defer func() { _ = deleteTx.Rollback(fixture.context) }()
		if _, err := deleteTx.Exec(fixture.context,
			`DELETE FROM segments WHERE tenant_id = $1::uuid AND id::text = $2`,
			fixture.tenantID, segmentID); err != nil {
			t.Fatalf("stage update-race target deletion: %v", err)
		}

		result := make(chan error, 1)
		go func() {
			_, updateErr := repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID,
				UpdateInput{TargetSegmentID: targetSegmentID(segmentID)})
			result <- updateErr
		}()
		select {
		case earlyErr := <-result:
			t.Fatalf("target update returned before competing delete committed: %v", earlyErr)
		case <-time.After(150 * time.Millisecond):
		}
		if err := deleteTx.Commit(fixture.context); err != nil {
			t.Fatalf("commit update-race target deletion: %v", err)
		}
		select {
		case updateErr := <-result:
			if !errors.Is(updateErr, ErrInvalidTargetSegment) {
				t.Fatalf("post-delete update error = %v, want ErrInvalidTargetSegment", updateErr)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("target update stayed blocked after delete committed")
		}
		persisted, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
		if err != nil {
			t.Fatalf("read routine after rejected racing update: %v", err)
		}
		if persisted.TargetSegmentID == nil || *persisted.TargetSegmentID != fixture.segmentID {
			t.Fatalf("rejected racing update changed target to %v", persisted.TargetSegmentID)
		}
	})

	t.Run("deleting a valid target safely detaches the routine", func(t *testing.T) {
		segmentID := fixture.seedSegment(t, fixture.tenantID, "delete")
		routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID,
			targetSegmentRoutineInput("delete-target", targetSegmentID(segmentID)), "")
		if err != nil {
			t.Fatalf("create delete fixture: %v", err)
		}
		tx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("open delete transaction: %v", err)
		}
		defer func() { _ = tx.Rollback(fixture.context) }()
		if _, err := tx.Exec(fixture.context,
			`DELETE FROM segments WHERE tenant_id = $1::uuid AND id::text = $2`,
			fixture.tenantID, segmentID); err != nil {
			t.Fatalf("delete target segment: %v", err)
		}
		if err := tx.Commit(fixture.context); err != nil {
			t.Fatalf("commit target deletion: %v", err)
		}
		persisted, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
		if err != nil {
			t.Fatalf("read detached routine: %v", err)
		}
		if persisted.TargetSegmentID != nil {
			t.Fatalf("target after segment deletion = %v, want nil", *persisted.TargetSegmentID)
		}
	})

	t.Run("delete-first race returns safe validation error", func(t *testing.T) {
		segmentID := fixture.seedSegment(t, fixture.tenantID, "race")
		deleteTx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("open racing delete transaction: %v", err)
		}
		defer func() { _ = deleteTx.Rollback(fixture.context) }()
		if _, err := deleteTx.Exec(fixture.context,
			`DELETE FROM segments WHERE tenant_id = $1::uuid AND id::text = $2`,
			fixture.tenantID, segmentID); err != nil {
			t.Fatalf("stage target deletion: %v", err)
		}

		result := make(chan error, 1)
		go func() {
			_, createErr := repo.CreateRoutine(fixture.context, fixture.tenantID,
				targetSegmentRoutineInput("delete-race", targetSegmentID(segmentID)), "")
			result <- createErr
		}()

		select {
		case earlyErr := <-result:
			t.Fatalf("targeted create returned before competing delete committed: %v", earlyErr)
		case <-time.After(150 * time.Millisecond):
			// The SELECT ... FOR KEY SHARE is waiting on the deleting row.
		}
		if err := deleteTx.Commit(fixture.context); err != nil {
			t.Fatalf("commit racing target deletion: %v", err)
		}

		select {
		case createErr := <-result:
			if !errors.Is(createErr, ErrInvalidTargetSegment) {
				t.Fatalf("post-delete create error = %v, want ErrInvalidTargetSegment", createErr)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("targeted create stayed blocked after delete committed")
		}
	})
}
