// SPDX-License-Identifier: AGPL-3.0-only
//
// G6 follow-up: static-audience snapshot. FreezeCampaignAudience captures
// the campaign's current segment membership into segment_static_freezes /
// segment_static_freeze_members (migration 0252), stamps the freeze id +
// audience_mode='static' on the campaign, and the queue-fill path then
// sends to the frozen membership instead of re-evaluating the segment.
//
// buildAudienceWhere is the shared subscribers-WHERE builder extracted
// from AudienceEmails so the live email enumeration and the freeze
// snapshot resolve identical audiences.

package campaigns

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
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// MountAudienceFreeze wires POST /api/v1/campaigns/{id}/audience/freeze.
func MountAudienceFreeze(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/campaigns/{id}/audience/freeze", d.freezeAudience)
}

func (d *Deps) freezeAudience(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	campaignID := chi.URLParam(r, "id")
	// Freezing REPLACES the audience and flips `audience_mode` to static, both
	// of which are in the approval fingerprint. It is an edit.
	if d.refuseIfLeaseHeld(w, r, t.ID, campaignID) {
		return
	}
	n, err := d.Repo.FreezeCampaignAudience(r.Context(), t.ID, campaignID)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "campaign not found"))
		case errors.Is(err, ErrFreezeRequiresSegment):
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("freeze_requires_segment",
				"a static snapshot requires a segment audience"))
		case errors.Is(err, ErrSegmentNotFound):
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("segment_not_found", audienceSegmentNotFoundMessage))
		default:
			httperror.WriteInternal(w, d.Logger, err, r.Context())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "frozen_members": n})
}

// ErrFreezeRequiresSegment is returned when a static-audience freeze is
// requested for a campaign with no segment (workspace-wide) audience.
var ErrFreezeRequiresSegment = errors.New("audience freeze requires a segment audience")

// buildAudienceWhere returns the canonical email-activation predicate for a
// campaign audience. Shared by count/checklist, live enumeration, and static
// freeze materialisation so all three answer the exact same population
// question.
func buildAudienceWhere(ctx context.Context, tx pgx.Tx, tenantID, segmentID string) (string, []any, error) {
	whereSQL := "tenant_id = $1::uuid"
	args := []any{tenantID}
	var astRaw json.RawMessage

	if segmentID != "" {
		err := tx.QueryRow(ctx, `
SELECT query_ast FROM segments
WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, segmentID).Scan(&astRaw)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil, ErrSegmentNotFound
			}
			return "", nil, fmt.Errorf("audience: load segment: %w", err)
		}
	}
	predicate, err := segments.CompilePopulation(
		ctx,
		astRaw,
		tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		segments.ActivationPopulation(segments.ActivationChannelEmail),
	)
	if err != nil {
		return "", nil, fmt.Errorf("audience: compile activation population: %w", err)
	}
	whereSQL += " AND (" + renumberPlaceholders(predicate.SQL, len(args)) + ")"
	args = append(args, predicate.Args...)
	return whereSQL, args, nil
}

// FreezeCampaignAudience snapshots the campaign's current segment
// membership into a new freeze, stamps frozen_freeze_id +
// audience_mode='static' on the campaign, and returns the member count.
func (r *Repo) FreezeCampaignAudience(ctx context.Context, tenantID, campaignID string) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var segmentID string
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(segment_id::text, '') FROM campaigns WHERE id = $1::uuid`,
		campaignID).Scan(&segmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	if segmentID == "" {
		// segment_static_freezes.source_segment_id is NOT NULL — a static
		// snapshot only makes sense for a segment audience.
		return 0, ErrFreezeRequiresSegment
	}

	whereSQL, args, err := buildAudienceWhere(ctx, tx, tenantID, segmentID)
	if err != nil {
		return 0, err
	}

	// Create the freeze header.
	var freezeID string
	if err := tx.QueryRow(ctx, `
INSERT INTO segment_static_freezes (tenant_id, source_segment_id, name, member_count)
VALUES ($1::uuid, $2::uuid, $3, 0)
RETURNING id::text`,
		tenantID, segmentID, "campaign "+campaignID).Scan(&freezeID); err != nil {
		return 0, err
	}

	// Snapshot members (id + email) into the freeze.
	rows, err := tx.Query(ctx, "SELECT id::text, email::text FROM subscribers WHERE "+whereSQL, args...)
	if err != nil {
		return 0, err
	}
	type member struct{ id, email string }
	var members []member
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.id, &m.email); err != nil {
			rows.Close()
			return 0, err
		}
		members = append(members, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, m := range members {
		if _, err := tx.Exec(ctx, `
INSERT INTO segment_static_freeze_members (freeze_id, tenant_id, subscriber_id, email)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
ON CONFLICT (freeze_id, subscriber_id) DO NOTHING`,
			freezeID, tenantID, m.id, m.email); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE segment_static_freezes SET member_count = $2 WHERE id = $1::uuid`,
		freezeID, len(members)); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE campaigns SET frozen_freeze_id = $2::uuid, audience_mode = 'static' WHERE id = $1::uuid`,
		campaignID, freezeID); err != nil {
		return 0, err
	}
	return len(members), tx.Commit(ctx)
}

// FrozenAudienceEmails returns the emails captured in a campaign's freeze.
// Used by the queue-fill path when audience_mode='static'.
func (r *Repo) FrozenAudienceEmails(ctx context.Context, tenantID, freezeID string) ([]string, error) {
	tenantID = strings.TrimSpace(tenantID)
	freezeID = strings.TrimSpace(freezeID)
	if tenantID == "" {
		return nil, errors.New("frozen audience: tenant id required")
	}
	if freezeID == "" {
		return nil, ErrFrozenAudienceNotFound
	}
	if r == nil || r.Pool == nil {
		return nil, errors.New("frozen audience: repository unavailable")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM segment_static_freezes
     WHERE tenant_id = $1::uuid
       AND id::text = $2
)`, tenantID, freezeID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrFrozenAudienceNotFound
	}
	rows, err := tx.Query(ctx,
		`SELECT email::text FROM segment_static_freeze_members WHERE tenant_id = $1::uuid AND freeze_id::text = $2`,
		tenantID, freezeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
