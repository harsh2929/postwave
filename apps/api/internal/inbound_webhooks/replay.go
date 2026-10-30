// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var (
	errReplayIdempotencyRequired = errors.New("inbound_webhooks: replay idempotency key required")
	errReplayIdempotencyInvalid  = errors.New("inbound_webhooks: replay idempotency key invalid")
)

func requiredReplayIdempotencyKey(header http.Header) (string, error) {
	values := header.Values(idempotency.HeaderName)
	if len(values) != 1 {
		if len(values) == 0 {
			return "", errReplayIdempotencyRequired
		}
		return "", errReplayIdempotencyInvalid
	}
	key := strings.TrimSpace(values[0])
	if key == "" {
		return "", errReplayIdempotencyRequired
	}
	if len(key) > idempotency.MaxKeyLength ||
		!utf8.ValidString(key) ||
		strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return "", errReplayIdempotencyInvalid
	}
	return key, nil
}

// LoadEventBody fetches the raw bytes of one stored inbound event
// so the replay handler can re-fire it through EvaluateTriggers.
// Returns ErrNotFound when the row is missing OR when its body is
// NULL (legacy rows from before bytes were retained).
//
// PR 2: enables the "fix your trigger, re-fire the event" debug loop.
func (r *Repo) LoadEventBody(ctx context.Context, tenantID string, eventID int64) (webhookID string, body []byte, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT endpoint_id::text, body_bytes
FROM inbound_events
WHERE id = $1`, eventID).Scan(&webhookID, &body)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, ErrNotFound
		}
		return "", nil, err
	}
	if len(body) == 0 {
		return "", nil, ErrNotFound
	}
	return webhookID, body, tx.Commit(ctx)
}

// ReplayEvent POST /api/v1/inbound-webhooks/{id}/events/{event_id}/replay
//
// Re-runs trigger evaluation against a stored inbound event body.
// Returns the match list so the UI can show "your trigger now
// fires" / "still no match" inline.
//
// Note: this DOES re-execute trigger actions (sequence enrollment,
// tag add/remove, automation start). That's the point — the user is
// fixing a trigger that should have fired the first time. The UI
// makes this clear in the confirm copy.
func (d *Deps) ReplayEvent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	repo := d.replayRepository()
	if repo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", ""))
		return
	}
	webhookID := chi.URLParam(r, "id")
	parsedWebhookID, err := uuid.Parse(webhookID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, errEnv(
			"not_found",
			"event does not belong to this webhook",
		))
		return
	}
	webhookID = parsedWebhookID.String()
	eventIDStr := chi.URLParam(r, "event_id")
	eventID, err := strconv.ParseInt(eventIDStr, 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_event_id", "event_id must be an integer"))
		return
	}
	canonicalEventID := strconv.FormatInt(eventID, 10)
	replayKey, err := requiredReplayIdempotencyKey(r.Header)
	if err != nil {
		if errors.Is(err, errReplayIdempotencyRequired) {
			writeJSON(w, http.StatusBadRequest, errEnv(
				"idempotency_key_required",
				"Idempotency-Key is required for event replay",
			))
			return
		}
		writeJSON(w, http.StatusBadRequest, errEnv(
			"invalid_idempotency_key",
			"Idempotency-Key must be one value without control characters and at most 255 bytes",
		))
		return
	}
	replayID := uuid.NewHash(
		sha256.New(),
		uuid.NameSpaceURL,
		[]byte(t.ID+"\x00"+webhookID+"\x00"+canonicalEventID+"\x00"+replayKey),
		5,
	).String()
	replayID, matches, err := repo.QueueReplayWithID(
		r.Context(), t.ID, webhookID, eventID, replayID,
	)
	if err != nil {
		if errors.Is(err, ErrUnverifiedEvent) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("event_not_verified",
				"invalid-signature events cannot be replayed"))
			return
		}
		if errors.Is(err, ErrPayloadNotRetained) {
			writeJSON(w, http.StatusUnprocessableEntity, errEnv("payload_not_retained",
				"event body is missing — too old to replay"))
			return
		}
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "event does not belong to this webhook"))
			return
		}
		httperror.WriteInternal(w, d.SafeLogger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if matches == nil {
		// A zero-match replay (and its same-key retry, read back from the
		// frozen receipt) is an empty list, not JSON null.
		matches = []Match{}
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"ok":        true,
		"queued":    true,
		"replay_id": replayID,
		"matches":   matches,
	})
}
