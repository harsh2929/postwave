package seqstore

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/sequencecontract"
)

func TestProductionStoreRejectsPausedBeforeOpeningDatabaseTransaction(t *testing.T) {
	store := &Store{} // nil pool proves validation runs before any DB access.
	seq := generation.Sequence{TenantID: "tenant-1", ID: "seq-1", Status: "paused"}

	if err := store.Save(context.Background(), seq); !errors.Is(err, sequencecontract.ErrUnsupportedStatus) {
		t.Fatalf("Save error = %v, want ErrUnsupportedStatus", err)
	}
	if _, err := store.SaveWithVersion(context.Background(), seq, 1); !errors.Is(err, sequencecontract.ErrUnsupportedStatus) {
		t.Fatalf("SaveWithVersion error = %v, want ErrUnsupportedStatus", err)
	}
}

func TestProductionVersionMismatchUsesCanonicalSentinel(t *testing.T) {
	if !errors.Is(ErrVersionMismatch, sequencecontract.ErrVersionMismatch) {
		t.Fatalf("production sentinel %v does not match canonical sentinel %v", ErrVersionMismatch, sequencecontract.ErrVersionMismatch)
	}
}

func TestProductionStoreRejectsUnsafeSequenceIDsBeforeDatabaseAccess(t *testing.T) {
	store := &Store{} // nil pool proves every check runs before a UUID cast/tx.
	ctx := context.Background()
	seq := generation.Sequence{TenantID: "tenant-1", ID: "seq-not-a-uuid", Status: "draft"}

	if err := store.Save(ctx, seq); !errors.Is(err, sequencecontract.ErrNotFound) {
		t.Fatalf("Save error = %v, want canonical ErrNotFound", err)
	}
	if _, err := store.SaveWithVersion(ctx, seq, 1); !errors.Is(err, sequencecontract.ErrNotFound) {
		t.Fatalf("SaveWithVersion error = %v, want canonical ErrNotFound", err)
	}
	if _, err := store.Get(ctx, "tenant-1", seq.ID); !errors.Is(err, sequencecontract.ErrNotFound) {
		t.Fatalf("Get error = %v, want canonical ErrNotFound", err)
	}
	if err := store.Delete(ctx, "tenant-1", seq.ID); !errors.Is(err, sequencecontract.ErrNotFound) {
		t.Fatalf("Delete error = %v, want canonical ErrNotFound", err)
	}
	if err := store.DeleteWithVersion(ctx, "tenant-1", seq.ID, 1); !errors.Is(err, sequencecontract.ErrNotFound) {
		t.Fatalf("DeleteWithVersion error = %v, want canonical ErrNotFound", err)
	}
}

func TestCanonicalSequenceUUIDGrammar(t *testing.T) {
	for _, id := range []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"00000000-0000-0000-0000-000000000000",
	} {
		if !isCanonicalSequenceUUID(id) {
			t.Errorf("expected canonical UUID %q to be accepted", id)
		}
	}
	for _, id := range []string{
		"", "seq-1", "550E8400-E29B-41D4-A716-446655440000",
		"{550e8400-e29b-41d4-a716-446655440000}",
		"550e8400e29b41d4a716446655440000", "../sequence",
	} {
		if isCanonicalSequenceUUID(id) {
			t.Errorf("expected non-canonical UUID %q to be rejected", id)
		}
	}
}

func TestDecodeSequenceJSONFailsClosedWithFieldContext(t *testing.T) {
	for _, tc := range []struct {
		name     string
		emails   string
		steps    string
		goal     string
		wantPart string
	}{
		{name: "emails", emails: `[{`, wantPart: `voice_sequence "seq-corrupt" emails`},
		{name: "steps", emails: `[]`, steps: `[{`, wantPart: `voice_sequence "seq-corrupt" steps`},
		{name: "goal", emails: `[]`, steps: `[]`, goal: `{`, wantPart: `voice_sequence "seq-corrupt" goal`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seq := generation.Sequence{ID: "seq-corrupt"}
			err := decodeSequenceJSON(&seq, []byte(tc.emails), []byte(tc.steps), []byte(tc.goal))
			if err == nil || !strings.Contains(err.Error(), tc.wantPart) {
				t.Fatalf("error = %v, want context containing %q", err, tc.wantPart)
			}
		})
	}
}

func TestDecodeSequenceJSONPreservesValidPersistedShapes(t *testing.T) {
	seq := generation.Sequence{ID: "seq-valid"}
	err := decodeSequenceJSON(
		&seq,
		[]byte(`[{"position":1,"subject":"Subject","body":"Body"}]`),
		[]byte(`[{"type":"exit","position":1}]`),
		[]byte(`{"kind":"click","exit_on_goal":true}`),
	)
	if err != nil {
		t.Fatalf("decode valid sequence JSON: %v", err)
	}
	if len(seq.Emails) != 1 || seq.Emails[0].Subject != "Subject" {
		t.Fatalf("emails = %+v", seq.Emails)
	}
	if len(seq.Steps) != 1 || seq.Steps[0].Type != generation.StepTypeExit {
		t.Fatalf("steps = %+v", seq.Steps)
	}
	if seq.Goal == nil || seq.Goal.Kind != generation.GoalKindClick || !seq.Goal.ExitOnGoal {
		t.Fatalf("goal = %+v", seq.Goal)
	}
}
