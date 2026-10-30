// SPDX-License-Identifier: AGPL-3.0-only

package editorcheckpoint

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The two guarantees this package exists to provide, tested for real.
//
// Both were nominally covered and neither was actually held. An adversarial
// review changed the upsert's guard to `WHERE false AND ...` — so every save
// after the first fails — and all six existing tests passed. It removed Load's
// `AND user_id = $2` predicate, so any colleague could read anyone's draft
// content, and the test NAMED for that guarantee still passed, on row order.
//
// The common cause: every existing test saves at expectedVersion 0, which can
// only insert or be refused, and reads back through a single-row fixture where
// an unfiltered query returns the right row by luck.

// The autosave loop — what this package spends most of its life doing, and what
// nothing exercised.
func TestAnAutosaveLoopKeepsAdvancingTheVersion(t *testing.T) {
	pool := checkpointPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool)
	repo := &Repo{Pool: pool}
	user := uuid.NewString()

	var version int64
	for i := 1; i <= 4; i++ {
		body := json.RawMessage(`{"subject":"draft ` + string(rune('0'+i)) + `"}`)
		cp, err := repo.Save(ctx, tenantID, user, "campaign", "c1", body, version)
		if err != nil {
			t.Fatalf("save %d at version %d: %v", i, version, err)
		}
		if cp.Version != int64(i) {
			t.Fatalf("save %d returned version %d, want %d — the upsert is not "+
				"advancing, so an editor autosaving every few seconds would be "+
				"refused from its second keystroke onward", i, cp.Version, i)
		}
		version = cp.Version
	}

	got, err := repo.Load(ctx, tenantID, user, "campaign", "c1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Compared as a VALUE, not as text: jsonb re-serialises with its own
	// spacing, so a byte comparison fails on formatting and says nothing about
	// which draft won.
	if subjectOf(t, got.Content) != "draft 4" {
		t.Fatalf("content = %s, want the newest draft; an earlier write is winning",
			got.Content)
	}
}

// Per-user privacy, arranged so it cannot pass on row order.
//
// Ada is seeded FIRST, so an unfiltered query returns HERS — the arrangement
// that makes a missing predicate visible rather than invisible.
func TestOnePersonsDraftIsNotReadableByAnother(t *testing.T) {
	pool := checkpointPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool)
	repo := &Repo{Pool: pool}
	ada, bob := uuid.NewString(), uuid.NewString()

	if _, err := repo.Save(ctx, tenantID, ada, "campaign", "shared",
		json.RawMessage(`{"subject":"ada private"}`), 0); err != nil {
		t.Fatalf("ada save: %v", err)
	}

	// Bob has never saved anything for this entity. He must be told there is no
	// draft — not handed Ada's.
	_, err := repo.Load(ctx, tenantID, bob, "campaign", "shared")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Bob's load of an entity he has no draft for returned %v; when "+
			"that is nil he is reading Ada's unfinished text", err)
	}

	if _, err := repo.Save(ctx, tenantID, bob, "campaign", "shared",
		json.RawMessage(`{"subject":"bob private"}`), 0); err != nil {
		t.Fatalf("bob save: %v", err)
	}
	got, err := repo.Load(ctx, tenantID, bob, "campaign", "shared")
	if err != nil {
		t.Fatalf("bob load: %v", err)
	}
	if subjectOf(t, got.Content) != "bob private" {
		t.Fatalf("Bob read %s — that is not his draft", got.Content)
	}
	adaGot, err := repo.Load(ctx, tenantID, ada, "campaign", "shared")
	if err != nil {
		t.Fatalf("ada load: %v", err)
	}
	if subjectOf(t, adaGot.Content) != "ada private" {
		t.Fatalf("Ada's draft is now %s; Bob's save landed on her row", adaGot.Content)
	}
}

// The DATABASE, not the query text, is what keeps drafts apart.
//
// The test above still passes while the Go predicate is present. This one runs a
// query that deliberately omits `user_id` — the exact mistake a future reader
// makes — inside a user-scoped transaction, and requires nothing to come back.
func TestAQueryThatForgetsTheUserPredicateStillSeesNothing(t *testing.T) {
	pool := checkpointPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool)
	repo := &Repo{Pool: pool}
	ada, bob := uuid.NewString(), uuid.NewString()

	if _, err := repo.Save(ctx, tenantID, ada, "campaign", "shared",
		json.RawMessage(`{"subject":"ada private"}`), 0); err != nil {
		t.Fatalf("ada save: %v", err)
	}

	tx, err := db.WithTenantUser(ctx, pool, tenantID, bob)
	if err != nil {
		t.Fatalf("WithTenantUser: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM editor_checkpoints WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("a tenant-wide count run as Bob returned %d row(s); owner_isolation "+
			"(migration 1880) is not constraining, so per-user privacy rests "+
			"entirely on every query remembering its predicate", n)
	}
}

// A caller's mistake must come back as an answer, not an outage.
func TestAMalformedEntityReferenceIsRefusedNotCrashed(t *testing.T) {
	pool := checkpointPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool)
	repo := &Repo{Pool: pool}
	user := uuid.NewString()
	body := json.RawMessage(`{"subject":"x"}`)

	cases := []struct {
		name    string
		key, id string
		want    error
	}{
		{"an entity id past the schema's limit", "campaign", strings.Repeat("x", 300), ErrInvalidEntity},
		{"an entity key past the schema's limit", strings.Repeat("x", 100), "c1", ErrInvalidEntity},
		{"an empty entity id", "campaign", "", ErrInvalidEntity},
		// 256 is what activitycursor allows. The two halves must agree, or the
		// cursor points at an entity the checkpoint refuses to hold a draft for.
		{"an entity id at the cursor's limit is accepted", "campaign", strings.Repeat("x", 256), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := repo.Save(ctx, tenantID, user, tc.key, tc.id, body, 0)
			if !errors.Is(err, tc.want) {
				t.Fatalf("Save = %v, want %v — a CHECK violation here surfaces as an "+
					"opaque 500 instead of a 400 naming the field", err, tc.want)
			}
		})
	}

	// A NUL escape is valid JSON and invalid inside a Postgres jsonb string.
	// Built by concatenation so the test source carries no control character.
	nulEscape := json.RawMessage(`{"subject":"a` + `\u0000` + `b"}`)
	if _, err := repo.Save(ctx, tenantID, user, "campaign", "nul", nulEscape, 0); !errors.Is(err, ErrUnsupportedContent) {
		t.Fatalf("a NUL escape gave %v, want ErrUnsupportedContent; Postgres rejects "+
			"it inside jsonb and the driver's error is unreadable to a client", err)
	}
}

// The 256 KiB cap is per ROW. Without a per-user row cap, a signed-in viewer
// could PUT an arbitrary entity reference as often as they liked and nothing —
// not the schema, not the handler, and not the sweeper, which no worker runs —
// ever reclaimed it. The package header claimed a bound the code did not have.
func TestOnePersonCannotHoldUnboundedDrafts(t *testing.T) {
	pool := checkpointPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool)
	repo := &Repo{Pool: pool}
	user := uuid.NewString()
	body := json.RawMessage(`{"subject":"x"}`)

	for i := 0; i < maxCheckpointsPerUser; i++ {
		if _, err := repo.Save(ctx, tenantID, user, "campaign", "c"+strings.Repeat("0", 3)+itoa(i), body, 0); err != nil {
			t.Fatalf("save %d: %v", i, err)
		}
	}
	_, err := repo.Save(ctx, tenantID, user, "campaign", "one-too-many", body, 0)
	if !errors.Is(err, ErrTooManyCheckpoints) {
		t.Fatalf("the %dth checkpoint returned %v, want ErrTooManyCheckpoints",
			maxCheckpointsPerUser+1, err)
	}

	// An existing draft must still be updatable at the cap — otherwise the
	// person who hit it can no longer save the document they are actually in,
	// which turns a quota into data loss.
	if _, err := repo.Save(ctx, tenantID, user, "campaign", "c0000", body, 1); err != nil {
		t.Fatalf("updating an existing draft at the cap failed: %v", err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var out []byte
	for i > 0 {
		out = append([]byte{byte('0' + i%10)}, out...)
		i /= 10
	}
	return string(out)
}

func subjectOf(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var out struct {
		Subject string `json:"subject"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("checkpoint content is not the object it was saved as: %v (%s)", err, raw)
	}
	return out.Subject
}
