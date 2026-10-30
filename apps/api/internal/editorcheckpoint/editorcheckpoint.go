// SPDX-License-Identifier: AGPL-3.0-only
//
// Package editorcheckpoint stores one in-progress draft per (user, entity) so
// an unfinished edit can be resumed on another device.
//
// `activitycursor` already answers "what was I looking at" — a single
// (entity_key, entity_id) reference, deliberately no content. That is enough to
// offer "Continue — <entity>" and nothing more: open the campaign on your phone
// and the half-written subject line from your laptop is not there, because it
// never left the laptop. This is the content half.
//
// PER USER, NOT PER ENTITY. A checkpoint is one person's unsaved work. Two
// people editing the same campaign hold two different half-finished thoughts,
// and merging them — or letting one overwrite the other — is worse than either
// losing theirs. The editing lease (internal/campaigns, migration 1877) is what
// stops them colliding on the SAVED record; this keeps their drafts apart while
// they do.
//
// SESSION-ONLY, like the cursor. A per-user draft makes no sense for a shared
// API key: every holder of the key would read and overwrite one another's
// unfinished work under a single identity.
package editorcheckpoint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// ErrStaleCheckpoint is returned when a save carries an older version than the
// stored one.
//
// The same person on two devices is the NORMAL case here, and it is exactly
// when last-write-wins destroys work: the laptop autosaves a stale buffer three
// seconds after the phone saved a newer one. Refusing lets the client ask
// rather than silently picking the loser.
var ErrStaleCheckpoint = errors.New("editorcheckpoint: stale version")

// ErrNotFound is returned when no checkpoint exists.
var ErrNotFound = errors.New("editorcheckpoint: not found")

// maxContentBytes bounds one checkpoint.
//
// 256 KiB: comfortably past any real subject/body draft, and short of the
// values a runaway client produces. Without a cap this table is an unbounded
// write surface authenticated users can fill.
const maxContentBytes = 256 << 10

// Bounds on the entity reference.
//
// These MATCH internal/activitycursor, which allows 64/256 (migration 1777).
// They were 64/128 here, so an entity the cursor could point at was one the
// checkpoint rejected — the resume offer would appear and the draft behind it
// would 500. Two halves of one feature disagreeing about what an entity id is
// is precisely the drift that mounting them together was supposed to prevent.
const (
	maxEntityKeyLen = 64
	maxEntityIDLen  = 256
)

// maxCheckpointsPerUser bounds how many entities one person may hold drafts for.
//
// The 256 KiB cap is per ROW; without a row cap a signed-in viewer could PUT an
// arbitrary entity_key/entity_id pair as often as they liked, and nothing —
// not the schema, not the handler — ever reclaimed it. The header claimed a
// bound the code did not provide.
//
// 200 is far past anyone genuinely editing in parallel and far short of a
// storage problem. Hitting it is a client bug or an abuse, and both deserve a
// refusal rather than silent growth.
const maxCheckpointsPerUser = 200

// ErrTooManyCheckpoints is returned when a save would exceed that bound.
var ErrTooManyCheckpoints = errors.New("editorcheckpoint: too many checkpoints")

// SweepAge is how long an untouched checkpoint survives.
//
// Exported because the retention sweeper is the caller and the number belongs
// to the package that owns the table's meaning, not to the scheduler that
// happens to run the deletion. A constant restated at the call site drifts the
// first time either side is edited alone, and the drift is invisible: both
// numbers look deliberate.
//
// 14 days is chosen against the two failures on either side of it. Too short
// and the feature breaks its promise — someone who starts a campaign before a
// holiday comes back to an empty form, which is worse than never having been
// offered the resume. Too long and this becomes an undeclared archive of
// things people deliberately chose NOT to save, which is a genuine surprise in
// a data-subject request and the reason the sweep exists at all.
//
// The clock is `updated_at`, not `created_at`: a draft someone touched
// yesterday is alive regardless of when it started, and expiring it on age
// since creation would delete the work in front of them.
const SweepAge = 14 * 24 * time.Hour

// ErrInvalidEntity is returned for an entity reference outside the bounds the
// schema accepts.
//
// Rejected AT THE EDGE rather than left to the CHECK constraint, so an
// over-long id is a 400 telling the caller what is wrong instead of a 500
// telling them nothing. `activitycursor.validRef` already works this way; this
// did not, and three separate inputs — a long entity_id, a long entity_key, and
// a NUL escape inside the content — each produced an opaque internal error.
var ErrInvalidEntity = errors.New("editorcheckpoint: invalid entity reference")

// validEntityRef mirrors the schema's CHECK constraints.
func validEntityRef(entityKey, entityID string) error {
	if entityKey == "" || len(entityKey) > maxEntityKeyLen {
		return ErrInvalidEntity
	}
	if entityID == "" || len(entityID) > maxEntityIDLen {
		return ErrInvalidEntity
	}
	return nil
}

// ErrUnsupportedContent is returned for a body Postgres cannot store as jsonb.
//
// A \u0000 escape is valid JSON and is NOT valid in a Postgres jsonb string, so
// a draft containing one reached the driver and came back as an unreadable
// internal error. Rejecting it here names the problem; the alternative — silently
// stripping it — would hand back a draft that differs from what was typed.
var ErrUnsupportedContent = errors.New("editorcheckpoint: content contains an unsupported escape")

// ErrContentTooLarge is returned for a body past maxContentBytes.
//
// Distinct from ErrUnsupportedContent so the caller is told which rule it broke.
// "Too big" is actionable — trim the draft; "unsupported escape" is a different
// problem with a different fix, and collapsing them produces the same
// unhelpful answer the 500 already gave.
var ErrContentTooLarge = errors.New("editorcheckpoint: content too large")

func validContent(content json.RawMessage) error {
	if len(content) > maxContentBytes {
		return ErrContentTooLarge
	}
	if bytes.Contains(content, []byte(`\u0000`)) || bytes.IndexByte(content, 0) >= 0 {
		return ErrUnsupportedContent
	}
	return nil
}

type Checkpoint struct {
	EntityKey string          `json:"entity_key"`
	EntityID  string          `json:"entity_id"`
	Content   json.RawMessage `json:"content"`
	Version   int64           `json:"version"`
	UpdatedAt time.Time       `json:"updated_at"`
}

type Repo struct{ Pool *db.Pool }

// Save upserts the caller's checkpoint, refusing a write built on an older
// version.
//
// `expectedVersion` of 0 means "I have no checkpoint" and succeeds only when
// none exists — so two devices that both start fresh cannot silently clobber
// each other on the first save either.
func (r *Repo) Save(
	ctx context.Context, tenantID, userID, entityKey, entityID string,
	content json.RawMessage, expectedVersion int64,
) (*Checkpoint, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("editorcheckpoint: repository unavailable")
	}
	if err := validEntityRef(entityKey, entityID); err != nil {
		return nil, err
	}
	if err := validContent(content); err != nil {
		return nil, err
	}
	// Scoped to the USER, not just the tenant: migration 1880's owner_isolation
	// policy reads app.user_id, so a query that forgets its user_id predicate
	// returns nothing instead of a colleague's draft.
	tx, err := db.WithTenantUser(ctx, r.Pool, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Counted inside the same transaction as the insert, so two concurrent
	// saves cannot both observe "199" and both proceed. The count is already
	// user-scoped by the policy above.
	var held int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM editor_checkpoints
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND NOT (entity_key = $3 AND entity_id = $4)`,
		tenantID, userID, entityKey, entityID).Scan(&held); err != nil {
		return nil, err
	}
	if held >= maxCheckpointsPerUser {
		return nil, ErrTooManyCheckpoints
	}

	var out Checkpoint
	err = tx.QueryRow(ctx, `
INSERT INTO editor_checkpoints
    (tenant_id, user_id, entity_key, entity_id, content, version, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, 1, now())
ON CONFLICT (tenant_id, user_id, entity_key, entity_id) DO UPDATE
   SET content    = EXCLUDED.content,
       version    = editor_checkpoints.version + 1,
       updated_at = now()
 WHERE editor_checkpoints.version = $6
RETURNING entity_key, entity_id, content, version, updated_at`,
		tenantID, userID, entityKey, entityID, string(content), expectedVersion).
		Scan(&out.EntityKey, &out.EntityID, &out.Content, &out.Version, &out.UpdatedAt)

	if errors.Is(err, pgx.ErrNoRows) {
		// The DO UPDATE's WHERE filtered the row out: a checkpoint exists and its
		// version is not the one this write was built on.
		return nil, ErrStaleCheckpoint
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Load returns the caller's checkpoint for one entity.
func (r *Repo) Load(ctx context.Context, tenantID, userID, entityKey, entityID string) (*Checkpoint, error) {
	if r == nil || r.Pool == nil {
		return nil, errors.New("editorcheckpoint: repository unavailable")
	}
	if err := validEntityRef(entityKey, entityID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenantUser(ctx, r.Pool, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out Checkpoint
	err = tx.QueryRow(ctx, `
SELECT entity_key, entity_id, content, version, updated_at
  FROM editor_checkpoints
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND entity_key = $3 AND entity_id = $4`,
		tenantID, userID, entityKey, entityID).
		Scan(&out.EntityKey, &out.EntityID, &out.Content, &out.Version, &out.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// Discard removes the caller's checkpoint.
//
// Called when the edit is SAVED or abandoned. Leaving it behind would make the
// next open offer to restore a draft that is already the saved state, which
// reads as a bug and trains people to dismiss the prompt.
func (r *Repo) Discard(ctx context.Context, tenantID, userID, entityKey, entityID string) error {
	if r == nil || r.Pool == nil {
		return errors.New("editorcheckpoint: repository unavailable")
	}
	if err := validEntityRef(entityKey, entityID); err != nil {
		return err
	}
	tx, err := db.WithTenantUser(ctx, r.Pool, tenantID, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM editor_checkpoints
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND entity_key = $3 AND entity_id = $4`,
		tenantID, userID, entityKey, entityID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ErrInvalidSweepAge is returned for a sweep age that is not a positive
// duration.
//
// Zero is the dangerous value, not an obviously silly one: `SweepOlderThan(ctx,
// t, 0)` reads as "no minimum age" and means "delete every draft older than
// now", which takes the paragraph someone is in the middle of typing. A sweep
// that deletes live work is worse than no sweep, so the API refuses rather than
// encoding it.
var ErrInvalidSweepAge = errors.New("editorcheckpoint: sweep age must be positive")

// SweepOlderThan deletes every checkpoint in this tenant that nobody came back
// for.
//
// A checkpoint is a convenience with a short useful life. Keeping unfinished
// drafts forever turns this into an undeclared archive of things people chose
// NOT to save — a surprise in a data-subject request, and a growing table with
// no owner.
//
// UNBOUNDED: one transaction for the whole backlog. Fine for a test fixture or
// a one-off operator call against a known-small tenant; the scheduled sweeper
// must use SweepBatchOlderThan, which is why that exists.
func (r *Repo) SweepOlderThan(ctx context.Context, tenantID string, age time.Duration) (int64, error) {
	return r.deleteOlderThan(ctx, tenantID, age, 0)
}

// SweepBatchOlderThan is SweepOlderThan bounded to at most `limit` rows, for a
// caller that loops until it returns 0.
//
// The bound is not decoration. A row here is up to maxContentBytes and one
// person may hold maxCheckpointsPerUser of them, so a tenant that stopped
// tidying up has a backlog measured in GB rather than rows — and the only index
// on the cutoff column is editor_checkpoints_stale_idx, on `updated_at` alone
// and NOT tenant-prefixed, so the scan behind the DELETE is not narrow either.
// Doing that as one statement holds row locks across the whole backlog in a
// single transaction while everyone still editing in that tenant waits on their
// own autosave.
func (r *Repo) SweepBatchOlderThan(
	ctx context.Context, tenantID string, age time.Duration, limit int,
) (int64, error) {
	if limit <= 0 {
		// Not silently promoted to "unbounded": a caller that computed 0 from a
		// misconfigured batch size would get the very transaction this method
		// exists to avoid, and would get it looking like it had asked for a batch.
		return 0, errors.New("editorcheckpoint: sweep batch limit must be positive")
	}
	return r.deleteOlderThan(ctx, tenantID, age, limit)
}

// deleteOlderThan is the ONE place the cutoff rule lives — `updated_at`, tenant
// scope, nothing else. Both exported sweeps route through it so the bounded and
// unbounded forms cannot drift apart, and a drift here would be silent because
// both copies would go on deleting rows.
//
// limit <= 0 means unbounded: Postgres reads a NULL LIMIT as "no limit", so one
// statement serves both forms rather than two statements restating the cutoff.
//
// THE AGE IS SENT AS SECONDS, NOT age.String(). Go renders sub-second durations
// with units Postgres will not parse — both '500µs'::interval and
// '100ns'::interval are hard errors — so the previous `$2::interval` form
// turned any small duration into an opaque driver error from inside a DELETE.
// SweepAge never produces one, but this is an exported method taking an
// arbitrary time.Duration and "no current caller does that" is not a property
// of an API. A float second count has no unit spelling to get wrong at any
// magnitude.
func (r *Repo) deleteOlderThan(
	ctx context.Context, tenantID string, age time.Duration, limit int,
) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, errors.New("editorcheckpoint: repository unavailable")
	}
	if age <= 0 {
		return 0, ErrInvalidSweepAge
	}
	// Nil for the unbounded form. Typed as a pointer so pgx sends SQL NULL.
	var rowLimit *int
	if limit > 0 {
		rowLimit = &limit
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// ctid-bounded: LIMIT is not legal on a bare DELETE in Postgres. Same shape
	// the sibling retention sweeps use.
	tag, err := tx.Exec(ctx, `
DELETE FROM editor_checkpoints
 WHERE ctid IN (
     SELECT ctid FROM editor_checkpoints
      WHERE tenant_id = $1::uuid
        AND updated_at < now() - ($2::double precision * interval '1 second')
      LIMIT $3::bigint
 )`, tenantID, age.Seconds(), rowLimit)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the checkpoint resource.
//
// Session-only: the handlers pin user_id to the acting session user, so a
// caller can only ever read or write their OWN draft. There is no route that
// takes a user id.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/editor/checkpoints/{entity_key}/{entity_id}", d.Load)
	r.Put("/api/v1/editor/checkpoints/{entity_key}/{entity_id}", d.Save)
	r.Delete("/api/v1/editor/checkpoints/{entity_key}/{entity_id}", d.Discard)
}

func (d *Deps) identity(w http.ResponseWriter, r *http.Request) (tenantID, userID, key, id string, ok bool) {
	t, found := middleware.TenantFromContext(r.Context())
	if !found {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return "", "", "", "", false
	}
	u, hasUser := middleware.UserFromContext(r.Context())
	if !hasUser || u == nil || u.ID == "" {
		// A shared API key has no single owner, so every holder would read and
		// overwrite one another's unfinished work under one identity.
		httperror.Write(w, http.StatusForbidden, "session_required",
			"draft checkpoints are per-person and need a signed-in session")
		return "", "", "", "", false
	}
	key = strings.TrimSpace(chi.URLParam(r, "entity_key"))
	id = strings.TrimSpace(chi.URLParam(r, "entity_id"))
	if key == "" || id == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_entity", "entity_key and entity_id required")
		return "", "", "", "", false
	}
	return t.ID, u.ID, key, id, true
}

func (d *Deps) Load(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, key, id, ok := d.identity(w, r)
	if !ok {
		return
	}
	cp, err := d.Repo.Load(r.Context(), tenantID, userID, key, id)
	if d.writeRefusal(w, r, err) {
		return
	}
	if errors.Is(err, ErrNotFound) {
		// 200 with `found: false`, not 404. "No draft" is the ordinary answer on
		// every clean open, and a 404 would put an error in the console on the
		// happy path — which is how real errors stop being noticed.
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": true, "checkpoint": cp})
}

type saveInput struct {
	Content json.RawMessage `json:"content"`
	// Version the client last saw. 0 means "I have no checkpoint".
	Version int64 `json:"version"`
}

func (d *Deps) Save(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, key, id, ok := d.identity(w, r)
	if !ok {
		return
	}
	var in saveInput
	// httpbody rather than a bare decoder, for the reason the rest of the
	// handler already cares about: telling the caller which mistake they made.
	//
	// The old form answered 400 `bad_json` to everything, so a client whose
	// draft had simply outgrown the cap was told its JSON was malformed. That is
	// the one failure an autosave loop cannot recover from — the client retries
	// the same too-large body forever, and the person watching sees "saving…"
	// and loses the work anyway. 413 with the limit is a different instruction.
	// The over-size case is not theoretical here: this endpoint carries draft
	// bodies, and the cap is deliberately only 1 KiB above what Save accepts.
	if err := httpbody.DecodeJSON(w, r, maxContentBytes+1024, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Content) == 0 {
		httperror.Write(w, http.StatusUnprocessableEntity, "missing_content",
			"content is required; use DELETE to discard a checkpoint")
		return
	}
	cp, err := d.Repo.Save(r.Context(), tenantID, userID, key, id, in.Content, in.Version)
	if errors.Is(err, ErrStaleCheckpoint) {
		// 409 with the CURRENT checkpoint, so the client can show both rather
		// than just reporting a conflict it cannot explain.
		current, loadErr := d.Repo.Load(r.Context(), tenantID, userID, key, id)
		body := map[string]any{"code": "stale_checkpoint",
			"message": "a newer draft was saved from another device"}
		if loadErr == nil {
			body["current"] = current
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": body})
		return
	}
	if d.writeRefusal(w, r, err) {
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, cp)
}

// writeRefusal turns a caller's mistake into an answer they can act on, and
// reports whether it handled the error.
//
// Every one of these previously fell through to WriteInternal: an over-long
// entity id, an over-long entity key, a NUL escape inside the draft, and a body
// in the 1 KiB gap between what MaxBytesReader admits and what Save accepts all
// returned 500 `internal_error`. A 500 tells the client to retry, which cannot
// work, and tells the operator an outage happened, which is not true.
func (d *Deps) writeRefusal(w http.ResponseWriter, r *http.Request, err error) bool {
	switch {
	case errors.Is(err, ErrInvalidEntity):
		httperror.Write(w, http.StatusBadRequest, "invalid_entity",
			"entity_key must be 1-64 characters and entity_id 1-256")
	case errors.Is(err, ErrContentTooLarge):
		httperror.Write(w, http.StatusRequestEntityTooLarge, "content_too_large",
			"a draft checkpoint is limited to 256 KiB")
	case errors.Is(err, ErrUnsupportedContent):
		httperror.Write(w, http.StatusUnprocessableEntity, "unsupported_content",
			`a draft cannot contain a \u0000 escape`)
	case errors.Is(err, ErrTooManyCheckpoints):
		httperror.Write(w, http.StatusConflict, "too_many_checkpoints",
			"this account already holds the maximum number of open drafts; "+
				"discard one before starting another")
	default:
		return false
	}
	return true
}

func (d *Deps) Discard(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, key, id, ok := d.identity(w, r)
	if !ok {
		return
	}
	if err := d.Repo.Discard(r.Context(), tenantID, userID, key, id); err != nil {
		if d.writeRefusal(w, r, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"discarded": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
