// SPDX-License-Identifier: AGPL-3.0-only

package agent_routines

import (
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestRepoTargetListUnsupportedAndLegacyCleanup_DB(t *testing.T) {
	fixture := newTargetSegmentDBFixture(t)
	repo := &Repo{Pool: fixture.pool}

	for _, target := range []string{"42", uuid.NewString()} {
		_, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
			Name:         "unsupported-list-" + target,
			Prompt:       "must not persist",
			Kind:         KindDraftCampaign,
			Schedule:     ScheduleManual,
			TargetListID: targetSegmentID(target),
		}, "")
		if !errors.Is(err, ErrUnsupportedTargetList) {
			t.Fatalf("create target %q error = %v, want ErrUnsupportedTargetList", target, err)
		}
	}

	routine, err := repo.CreateRoutine(fixture.context, fixture.tenantID, CreateInput{
		Name:     "unsupported-list-update",
		Prompt:   "keep this prompt",
		Kind:     KindDraftCampaign,
		Schedule: ScheduleManual,
	}, "")
	if err != nil {
		t.Fatalf("create update fixture: %v", err)
	}
	newName := "must not apply"
	_, err = repo.UpdateRoutine(fixture.context, fixture.tenantID, routine.ID, UpdateInput{
		Name:         &newName,
		TargetListID: targetSegmentID("42"),
	})
	if !errors.Is(err, ErrUnsupportedTargetList) {
		t.Fatalf("update error = %v, want ErrUnsupportedTargetList", err)
	}
	persisted, err := repo.GetRoutine(fixture.context, fixture.tenantID, routine.ID)
	if err != nil {
		t.Fatalf("read routine after rejected update: %v", err)
	}
	if persisted.Name != routine.Name || persisted.TargetListID != nil {
		t.Fatalf("rejected update mutated routine: %+v", persisted)
	}

	legacyID := uuid.NewString()
	tx, err := db.WithTenant(fixture.context, fixture.pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open legacy fixture transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(fixture.context) }()
	var legacyRoutineID string
	if err := tx.QueryRow(fixture.context, `
INSERT INTO agent_routines (
    tenant_id, name, prompt, kind, schedule, target_list_id
) VALUES (
    $1::uuid, 'legacy-list-target', 'legacy inert hint',
    'draft_campaign', 'manual', $2::uuid
)
RETURNING id::text`, fixture.tenantID, legacyID).Scan(&legacyRoutineID); err != nil {
		t.Fatalf("seed legacy target-list routine: %v", err)
	}
	if err := tx.Commit(fixture.context); err != nil {
		t.Fatalf("commit legacy target-list routine: %v", err)
	}

	legacy, err := repo.GetRoutine(fixture.context, fixture.tenantID, legacyRoutineID)
	if err != nil {
		t.Fatalf("read legacy routine: %v", err)
	}
	if legacy.TargetListID == nil || *legacy.TargetListID != legacyID {
		t.Fatalf("legacy target = %v, want %s", legacy.TargetListID, legacyID)
	}

	preservedName := "legacy renamed"
	preserved, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, legacyRoutineID,
		UpdateInput{Name: &preservedName})
	if err != nil {
		t.Fatalf("update legacy routine without target-list field: %v", err)
	}
	if preserved.TargetListID == nil || *preserved.TargetListID != legacyID {
		t.Fatalf("omitted legacy target was not preserved: %v", preserved.TargetListID)
	}

	cleared, err := repo.UpdateRoutine(fixture.context, fixture.tenantID, legacyRoutineID,
		UpdateInput{TargetListID: targetSegmentID("  ")})
	if err != nil {
		t.Fatalf("clear legacy target: %v", err)
	}
	if cleared.TargetListID != nil {
		t.Fatalf("cleared legacy target = %v, want nil", *cleared.TargetListID)
	}
}
