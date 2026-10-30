// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

const (
	maxTickNoteRunes = 2048
	maxTickNoteBytes = 8 << 10
)

// TickStore is the narrow write surface the tick runner needs. *ops.Store
// satisfies it; tests use a fake.
type TickStore interface {
	Tick(ctx context.Context, checkID, operatorID, note string, at time.Time) error
}

// ManualTickRunner returns the action runner bound to every manual chore's
// "Mark done" button.
//
// The operator comes from the request CONTEXT, never from the request body.
// The action executor detaches the context with context.WithoutCancel, which
// preserves values, so the authenticated identity survives into the runner --
// and an operator cannot tick a chore in somebody else's name, because the
// name is not an input.
//
// Every tick therefore lands in three places: ops_manual_log (who, when,
// what), audit_log (via the executor's intent/outcome pair), and
// ops_check_results (the re-armed clock). The audit trail is the executor's
// doing and comes free -- which is exactly why the tick is modelled as an
// action rather than as a fourth bespoke endpoint.
// checkID is closed over per chore rather than read from the request, so a
// runner can only ever tick the chore it was bound to. Threading the id
// through the context instead would widen the executor's contract for one
// caller and would let a future bug tick the wrong chore.
func ManualTickRunner(store TickStore, checkID string) ops.ActionRunner {
	return func(ctx context.Context, note string) (string, error) {
		operator, ok := ops.OperatorFromContext(ctx)
		if !ok || strings.TrimSpace(operator.ID) == "" {
			// Fail closed. A tick attributed to nobody is worse than no tick:
			// it is a record that looks like evidence and is not.
			return "", errors.New("no authenticated operator on the request; refusing to record an unattributable tick")
		}

		note = strings.TrimSpace(note)
		switch {
		case note == "":
			return "", ops.ErrTickNoteRequired
		case !utf8.ValidString(note):
			return "", errors.New("tick note is not valid UTF-8")
		case utf8.RuneCountInString(note) > maxTickNoteRunes || len(note) > maxTickNoteBytes:
			return "", fmt.Errorf("tick note is too long (max %d characters)", maxTickNoteRunes)
		}
		for _, r := range note {
			if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
				return "", errors.New("tick note contains control characters")
			}
		}

		now := time.Now().UTC()
		if err := store.Tick(ctx, checkID, operator.ID, note, now); err != nil {
			return "", err
		}
		return fmt.Sprintf("recorded by %s at %s", operator.Email, now.Format(time.RFC3339)), nil
	}
}

// BindManualTicks binds the tick runner to every registered manual chore.
// Called from main.go once the ops store exists.
//
// Iterating ManualChores rather than re-listing the IDs is the point: adding a
// chore to chores.go binds its button automatically, so a new chore can never
// ship with a dead "Mark done".
func BindManualTicks(store TickStore) {
	for _, c := range ManualChores {
		ops.BindAction(c.ID, ManualTickRunner(store, c.ID))
	}
}
