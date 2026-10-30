// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

type fakeTickStore struct {
	checkID, operatorID, note string
	calls                     int
}

func (f *fakeTickStore) Tick(_ context.Context, checkID, operatorID, note string, _ time.Time) error {
	f.calls++
	f.checkID, f.operatorID, f.note = checkID, operatorID, note
	return nil
}

func operatorCtx(t *testing.T) context.Context {
	t.Helper()
	return ops.ContextWithOperator(context.Background(),
		ops.Operator{ID: "op-1", Email: "ops@postwave.local"})
}

// A tick records that a control was exercised. Attributing it to nobody would
// produce a record that LOOKS like evidence and is not, which is worse than
// having no record at all.
func TestManualTickRunner_RefusesAnUnauthenticatedTick(t *testing.T) {
	store := &fakeTickStore{}
	_, err := ManualTickRunner(store, "security.access-review")(context.Background(), "did the thing")
	if err == nil {
		t.Fatal("a tick with no authenticated operator must be refused")
	}
	if store.calls != 0 {
		t.Fatal("nothing may be written for an unattributable tick")
	}
}

// The operator is taken from the authenticated context, never from the body,
// so one operator cannot record a tick in another's name.
func TestManualTickRunner_AttributesToTheSessionOperator(t *testing.T) {
	store := &fakeTickStore{}
	result, err := ManualTickRunner(store, "database.restore-drill")(operatorCtx(t), "restored in 41m")
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if store.operatorID != "op-1" {
		t.Fatalf("the tick must be attributed to the session operator, got %q", store.operatorID)
	}
	if store.checkID != "database.restore-drill" {
		t.Fatalf("a runner may only tick the chore it was bound to, got %q", store.checkID)
	}
	if !strings.Contains(result, "ops@postwave.local") {
		t.Fatalf("the result must name who recorded it, got %q", result)
	}
}

func TestManualTickRunner_RequiresANote(t *testing.T) {
	store := &fakeTickStore{}
	if _, err := ManualTickRunner(store, "x")(operatorCtx(t), "   "); err == nil {
		t.Fatal("a blank note must be refused: an unexplained tick is a click, not evidence")
	}
	if store.calls != 0 {
		t.Fatal("a rejected tick must not write")
	}
}

func TestManualTickRunner_RejectsHostileNotes(t *testing.T) {
	store := &fakeTickStore{}
	for name, note := range map[string]string{
		"control characters": "done\x00now",
		"over length":        strings.Repeat("x", maxTickNoteRunes+1),
	} {
		if _, err := ManualTickRunner(store, "x")(operatorCtx(t), note); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
	if store.calls != 0 {
		t.Fatal("a rejected tick must not write")
	}
}

// Every chore in chores.go must get its button bound. A chore shipping with a
// dead "Mark done" would train operators that the button does not work.
func TestBindManualTicks_BindsEveryChore(t *testing.T) {
	for _, c := range ManualChores {
		if c.Action == nil {
			t.Errorf("chore %q has no action, so it cannot be ticked at all", c.ID)
			continue
		}
		if c.Kind != ops.KindManual || c.Cadence == 0 {
			t.Errorf("chore %q is in ManualChores but is not a cadenced manual check", c.ID)
		}
	}
}
