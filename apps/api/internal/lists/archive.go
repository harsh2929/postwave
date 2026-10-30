// Package lists — archive.go owns the lifecycle endpoints that mutate
// list_metadata or compose lists: archive/unarchive (GAP-LS-056),
// duplicate (GAP-LS-057), merge (GAP-LS-058), and the per-list
// preferences-page customisation (GAP-LS-065).
//
// All endpoints are tenant-scoped and live under /api/v1/lists/{id}/...
// except merge which is the cross-list /api/v1/lists/merge.
//
// Archive semantics:
//   - archived_at IS NULL  -> live; participates in sendloop, campaign
//                             pre-send checks, automations etc.
//   - archived_at IS NOT NULL -> archived; the IsListArchived helper is
//                                what sendloop / pre-send call to gate.
// Membership rows are untouched on archive; restoring is a single UPDATE
// that nulls archived_at.

package lists

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MountArchiveRoutes registers archive/unarchive + duplicate + merge +
// preferences-page. Kept separate from MountRoutes so the original
// Listmonk-proxy surface stays unchanged (additive contract).
func (d *Deps) MountArchiveRoutes(r chi.Router) {
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers))
	write := r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers))
	// p4d-recordsurface-wire-others: mutating archive routes get the
	// pw_lists_<action>_total + pw_lists_duration_seconds pair so
	// lifecycle ops show up next to CRUD in the lists dashboard.
	write.Post("/api/v1/lists/{id}/archive", observability.RecordSurfaceFunc("lists", "archive", d.Archive))
	write.Post("/api/v1/lists/{id}/unarchive", observability.RecordSurfaceFunc("lists", "unarchive", d.Unarchive))
	write.Post("/api/v1/lists/{id}/duplicate", observability.RecordSurfaceFunc("lists", "duplicate", d.Duplicate))
	write.Post("/api/v1/lists/merge", observability.RecordSurfaceFunc("lists", "merge", d.MergeLists))
	read.Get("/api/v1/lists/{id}/preferences-page", d.GetPreferencesPage)
	write.Patch("/api/v1/lists/{id}/preferences-page", observability.RecordSurfaceFunc("lists", "update_preferences_page", d.UpdatePreferencesPage))
}

// archiveJSONMaxBodyBytes caps mutation payloads — these are all small
// settings blobs (no asset uploads, no CSV).
const archiveJSONMaxBodyBytes int64 = 32 << 10

// ----------------- GAP-LS-056: archive / unarchive -----------------

// Archive POST /api/v1/lists/{id}/archive
//
// Marks the list archived_at = now() in list_metadata. The row is
// auto-created on first call (lists in Listmonk that have never been
// touched by the Moosewave sidecar will get a fresh row here).
func (d *Deps) Archive(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	actorID := actorUserID(r.Context())
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
		return
	}
	if err := d.Repo.SetArchived(r.Context(), tenantID, bigintID, true, actorID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.archive", "list", listUUID,
		nil, map[string]any{"archived": true}, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":  listUUID,
		"archived": true,
	})
}

// Unarchive POST /api/v1/lists/{id}/unarchive
func (d *Deps) Unarchive(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	actorID := actorUserID(r.Context())
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
		return
	}
	if err := d.Repo.SetArchived(r.Context(), tenantID, bigintID, false, actorID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.unarchive", "list", listUUID,
		nil, map[string]any{"archived": false}, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id":  listUUID,
		"archived": false,
	})
}

// SetArchived upserts the (tenant_id, listmonk_list_id) row in
// list_metadata with archived_at = now() (or NULL on unarchive).
func (r *Repo) SetArchived(ctx context.Context, tenantID string, bigintID int64, archive bool, actorUserID string) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if archive {
		_, err = tx.Exec(ctx, `
INSERT INTO list_metadata (tenant_id, listmonk_list_id, archived_at, archived_by)
VALUES ($1::uuid, $2, now(), NULLIF($3, '')::uuid)
ON CONFLICT (tenant_id, listmonk_list_id) DO UPDATE
   SET archived_at = now(),
       archived_by = NULLIF($3, '')::uuid,
       updated_at  = now()`,
			tenantID, bigintID, actorUserID)
	} else {
		_, err = tx.Exec(ctx, `
INSERT INTO list_metadata (tenant_id, listmonk_list_id, archived_at, archived_by)
VALUES ($1::uuid, $2, NULL, NULL)
ON CONFLICT (tenant_id, listmonk_list_id) DO UPDATE
   SET archived_at = NULL,
       archived_by = NULL,
       updated_at  = now()`,
			tenantID, bigintID)
	}
	if err != nil {
		return fmt.Errorf("set archived: %w", err)
	}
	return tx.Commit(ctx)
}

// IsListArchived is the gate the sendloop and campaign pre-send checks
// call to skip archived lists. Returns (true, nil) only when an entry
// exists in list_metadata AND archived_at is non-null.
//
// Accepts either Moosewave uuid or Listmonk bigint — symmetric with the
// rest of the lists package.
func (r *Repo) IsListArchived(ctx context.Context, tenantID, listIDRaw string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, nil
	}
	if strings.TrimSpace(listIDRaw) == "" {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var archived bool
	if bigintID, ok := parseInt64Strict(listIDRaw); ok {
		err = tx.QueryRow(ctx, `
SELECT archived_at IS NOT NULL FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
			tenantID, bigintID).Scan(&archived)
	} else {
		// uuid path — resolve to bigint first.
		var bigintID int64
		err = tx.QueryRow(ctx, `
SELECT listmonk_bigint_id FROM list_id_map
 WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid`,
			tenantID, listIDRaw).Scan(&bigintID)
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Commit(ctx)
			return false, nil
		}
		if err != nil {
			return false, err
		}
		err = tx.QueryRow(ctx, `
SELECT archived_at IS NOT NULL FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
			tenantID, bigintID).Scan(&archived)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Commit(ctx)
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return archived, tx.Commit(ctx)
}

// actorUserID extracts the acting user id from the request context,
// returning "" when no session user is present (API-key requests).
func actorUserID(ctx context.Context) string {
	if u, ok := middleware.UserFromContext(ctx); ok && u != nil {
		return u.ID
	}
	return ""
}

// ----------------- GAP-LS-057: duplicate -----------------

type duplicateInput struct {
	Name string `json:"name"`
}

// Duplicate POST /api/v1/lists/{id}/duplicate
//
// Creates a NEW list-metadata row (a placeholder — the Listmonk list
// itself is duplicated by an upstream copy that the desktop UI triggers
// in a follow-up; this endpoint reserves the membership replication so
// the order doesn't matter). The members of {id} are cloned into the
// new list_subscribers row set, sharing source='admin' so the audit
// trail records the duplication.
func (d *Deps) Duplicate(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	var in duplicateInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	newListUUID, copied, err := d.Repo.DuplicateList(r.Context(), tenantID, listUUID, in.Name)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.duplicate", "list", newListUUID,
		nil, map[string]any{"source_id": listUUID, "new_id": newListUUID, "copied": copied, "name": in.Name}, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"source_id": listUUID,
		"new_id":    newListUUID,
		"copied":    copied,
		"note":      "membership cloned; upstream listmonk-side copy is created lazily on first send",
	})
}

// DuplicateList clones every non-removed member of sourceListUUID into
// a freshly-minted list uuid. Returns the new uuid + count copied.
//
// The new list is NOT yet present in Listmonk — list_id_map gets no
// row until the upstream create lands. Pre-send checks that try to
// resolve the new uuid will surface "list not found" until then, which
// is the contract documented in the response note.
func (r *Repo) DuplicateList(ctx context.Context, tenantID, sourceListUUID, _ string) (string, int64, error) {
	if r == nil || r.Pool == nil {
		return "", 0, fmt.Errorf("lists: repo not configured")
	}
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return "", 0, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var newUUID string
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&newUUID); err != nil {
		return "", 0, err
	}

	rows, txErr := tx.Query(ctx, `
WITH copied AS (
    INSERT INTO list_subscribers (
        tenant_id, list_id, subscriber_id, email, source, added_at
    )
    SELECT ls.tenant_id, $2::uuid, ls.subscriber_id,
           COALESCE(ls.email, s.email), 'admin', now()
      FROM list_subscribers ls
      JOIN subscribers s
        ON s.tenant_id = ls.tenant_id
       AND s.id = ls.subscriber_id
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = $3::uuid
       AND ls.removed_at IS NULL
    ON CONFLICT (list_id, subscriber_id) DO NOTHING
    RETURNING subscriber_id::text, email::text, list_id::text, source, added_at
)
SELECT subscriber_id, email, list_id, source, added_at FROM copied`,
		tenantID, newUUID, sourceListUUID)
	if txErr != nil {
		return "", 0, fmt.Errorf("duplicate members: %w", txErr)
	}
	addedEvents, txErr := scanSubscriberAddedMemberships(rows)
	if txErr != nil {
		return "", 0, fmt.Errorf("duplicate members: %w", txErr)
	}
	if txErr := r.fireListSubscriberAddedBatch(
		ctx, tx, tenantID, addedEvents,
	); txErr != nil {
		return "", 0, txErr
	}
	if err := tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return newUUID, int64(len(addedEvents)), nil
}

// ----------------- GAP-LS-058: merge -----------------

type mergeInput struct {
	SourceIDs      []string `json:"source_ids"`
	TargetID       string   `json:"target_id"`
	ArchiveSources bool     `json:"archive_sources"`
}

// MergeLists POST /api/v1/lists/merge
//
// Merges every member of every source list into target_list. Sources
// may optionally be archived after the merge (archive_sources=true).
// Each (source_member, target_list) is INSERTed with ON CONFLICT
// DO NOTHING so members that exist on both sides aren't doubled.
func (d *Deps) MergeLists(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	var in mergeInput
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.TargetID = strings.TrimSpace(in.TargetID)
	if in.TargetID == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_target", "target_id required"))
		return
	}
	if len(in.SourceIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_sources", "source_ids required"))
		return
	}
	if len(in.SourceIDs) > 50 {
		writeJSON(w, http.StatusBadRequest, errEnv("too_many_sources", "max 50 source lists per merge"))
		return
	}

	// Resolve target.
	targetUUID, targetErr := d.Repo.resolveListUUID(r.Context(), t.ID, in.TargetID)
	if targetErr != nil {
		httperror.Write(w, http.StatusNotFound, "target_not_found", "target list not found")
		return
	}

	resolvedSources := make([]string, 0, len(in.SourceIDs))
	for _, sraw := range in.SourceIDs {
		sraw = strings.TrimSpace(sraw)
		if sraw == "" {
			continue
		}
		suuid, err := d.Repo.resolveListUUID(r.Context(), t.ID, sraw)
		if err != nil {
			httperror.Write(w, http.StatusNotFound, "source_not_found",
				fmt.Sprintf("source list %s not found", sraw))
			return
		}
		if suuid == targetUUID {
			writeJSON(w, http.StatusBadRequest, errEnv("source_eq_target",
				"target_id cannot also appear in source_ids"))
			return
		}
		resolvedSources = append(resolvedSources, suuid)
	}

	moved, targetErr := d.Repo.MergeListsMembers(r.Context(), t.ID, resolvedSources, targetUUID)
	if targetErr != nil {
		// Includes a target deleted after it was resolved above: a 404.
		d.writeListIdentityError(w, r, targetErr)
		return
	}

	archived := []string{}
	if in.ArchiveSources {
		actorID := actorUserID(r.Context())
		for _, sUUID := range resolvedSources {
			bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), t.ID, sUUID)
			if err != nil {
				continue
			}
			if err := d.Repo.SetArchived(r.Context(), t.ID, bigintID, true, actorID); err == nil {
				archived = append(archived, sUUID)
			}
		}
	}

	audit.EmitOrLog(r.Context(), d.auditPool(), "list.merge", "list", targetUUID,
		nil, map[string]any{
			"target_id": targetUUID,
			"sources":   resolvedSources,
			"moved":     moved,
			"archived":  archived,
		}, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"target_id": targetUUID,
		"sources":   resolvedSources,
		"moved":     moved,
		"archived":  archived,
	})
}

// MergeListsMembers walks each source list and inserts every
// non-removed member into the target list. One tx per source list — a
// failure on the third source doesn't roll back the first two (the
// merge is best-effort by design; partial progress is recoverable).
func (r *Repo) MergeListsMembers(ctx context.Context, tenantID string, sourceUUIDs []string, targetUUID string) (int64, error) {
	if r == nil || r.Pool == nil {
		return 0, fmt.Errorf("lists: repo not configured")
	}
	var total int64
	for _, src := range sourceUUIDs {
		tx, err := db.WithTenant(ctx, r.Pool, tenantID)
		if err != nil {
			return total, err
		}
		// The target is verified in each writing transaction, FOR KEY SHARE,
		// so a merge cannot keep filling a list deleted part-way through
		// (retire.go); that is ErrListIDNotMapped.
		target, err := ResolveListIdentityTx(ctx, tx, tenantID, targetUUID)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		rows, err := tx.Query(ctx, `
WITH copied AS (
    INSERT INTO list_subscribers (
        tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, added_at
    )
    SELECT ls.tenant_id, $2::uuid, ls.subscriber_id, $4::bigint,
           COALESCE(ls.email, s.email), 'admin', now()
      FROM list_subscribers ls
      JOIN subscribers s
        ON s.tenant_id = ls.tenant_id
       AND s.id = ls.subscriber_id
     WHERE ls.tenant_id = $1::uuid
       AND ls.list_id = $3::uuid
       AND ls.removed_at IS NULL
    ON CONFLICT (list_id, subscriber_id) DO NOTHING
    RETURNING subscriber_id::text, email::text, list_id::text, source, added_at
)
SELECT subscriber_id, email, list_id, source, added_at FROM copied`,
			tenantID, target.UUID, src, target.EngineID)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("merge from %s: %w", src, err)
		}
		addedEvents, err := scanSubscriberAddedMemberships(rows)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("merge from %s: %w", src, err)
		}
		if err := r.fireListSubscriberAddedBatch(
			ctx, tx, tenantID, addedEvents,
		); err != nil {
			_ = tx.Rollback(ctx)
			return total, fmt.Errorf("merge from %s: %w", src, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return total, err
		}
		total += int64(len(addedEvents))
	}
	return total, nil
}

// ----------------- GAP-LS-065: per-list preferences-page -----------------

// PreferencesPage is the per-list overrides for the subscribe /
// preference / unsubscribe page. All fields optional; empty strings
// mean "use the tenant default".
type PreferencesPage struct {
	ThemePrimary   string `json:"theme_primary,omitempty"`
	ThemeSecondary string `json:"theme_secondary,omitempty"`
	Headline       string `json:"headline,omitempty"`
	Description    string `json:"description,omitempty"`
	FooterText     string `json:"footer_text,omitempty"`
	LogoURL        string `json:"logo_url,omitempty"`
	CustomCSS      string `json:"custom_css,omitempty"`
}

// GetPreferencesPage GET /api/v1/lists/{id}/preferences-page
func (d *Deps) GetPreferencesPage(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		writeJSON(w, http.StatusOK, PreferencesPage{})
		return
	}
	p, err := d.Repo.GetPreferencesPage(r.Context(), tenantID, bigintID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// UpdatePreferencesPage PATCH /api/v1/lists/{id}/preferences-page
//
// Whole-object replace under custom_metadata.preferences_page. The
// caller sends every field they want to keep; missing fields become
// empty strings (tenant default).
func (d *Deps) UpdatePreferencesPage(w http.ResponseWriter, r *http.Request) {
	tenantID, listUUID, ok := d.resolveListID(r, w)
	if !ok {
		return
	}
	var in PreferencesPage
	if err := httpbody.DecodeJSON(w, r, archiveJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	bigintID, err := d.Repo.GetListBigintIDByUUID(r.Context(), tenantID, listUUID)
	if err != nil {
		httperror.Write(w, http.StatusNotFound, "not_found", "list not found")
		return
	}
	if err := d.Repo.SetPreferencesPage(r.Context(), tenantID, bigintID, in); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	audit.EmitOrLog(r.Context(), d.auditPool(), "list.preferences_page.update", "list", listUUID,
		nil, in, nil)
	writeJSON(w, http.StatusOK, in)
}

// GetPreferencesPage reads custom_metadata.preferences_page from
// list_metadata. Missing -> zero value.
func (r *Repo) GetPreferencesPage(ctx context.Context, tenantID string, bigintID int64) (PreferencesPage, error) {
	out := PreferencesPage{}
	if r == nil || r.Pool == nil {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var raw []byte
	err = tx.QueryRow(ctx, `
SELECT COALESCE(custom_metadata -> 'preferences_page', '{}'::jsonb)::text::bytea
  FROM list_metadata
 WHERE tenant_id = $1::uuid AND listmonk_list_id = $2`,
		tenantID, bigintID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Commit(ctx)
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return out, nil
}

// SetPreferencesPage upserts the row and writes the JSON blob at
// custom_metadata.preferences_page via jsonb_set.
func (r *Repo) SetPreferencesPage(ctx context.Context, tenantID string, bigintID int64, p PreferencesPage) error {
	if r == nil || r.Pool == nil {
		return fmt.Errorf("lists: repo not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	raw, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal prefs: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO list_metadata (tenant_id, listmonk_list_id, custom_metadata)
VALUES ($1::uuid, $2, jsonb_build_object('preferences_page', $3::jsonb))
ON CONFLICT (tenant_id, listmonk_list_id) DO UPDATE
   SET custom_metadata = jsonb_set(
           COALESCE(list_metadata.custom_metadata, '{}'::jsonb),
           ARRAY['preferences_page'],
           $3::jsonb,
           true
       ),
       updated_at = now()`,
		tenantID, bigintID, string(raw)); err != nil {
		return fmt.Errorf("update prefs: %w", err)
	}
	return tx.Commit(ctx)
}
