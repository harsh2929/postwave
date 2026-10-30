// SPDX-License-Identifier: AGPL-3.0-only
//
// session_link.go — session-replay deep-link lookup for audit_log rows.
//
// Audit-2026 UX (P1). Given an audit_log row id, return the URL of the
// session replay recording that covers the moment the row was emitted,
// plus a ±ReplayScopeWindow time window the player should seek to.
//
// The replay backend is currently external (PostHog / rrweb-on-S3).
// When the operator has not configured a session-replay provider this
// returns ErrNotAvailable so the handler responds with a structured
// JSON {available:false} payload — the UI surfaces "Watch session
// replay" only when available=true comes back.
package audit

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ReplayScopeWindow is the half-width of the time window the player
// is asked to seek to. Two minutes either side of the audit event
// gives a viewer plenty of context to see the click that triggered
// the action without forcing them to scrub a 30-minute session.
const ReplayScopeWindow = 2 * time.Minute

// ErrNotAvailable is the sentinel the lookup returns when no replay
// can be linked to the audit row — either the row carries no
// session_id, or no replay provider is configured for the tenant.
var ErrNotAvailable = errors.New("session-replay: not available")

// ReplayURLResponse is the structured result of a successful lookup.
// The handler marshals this straight to JSON; field tags live there.
type ReplayURLResponse struct {
	Available      bool      `json:"available"`
	ReplayURL      string    `json:"replay_url,omitempty"`
	Provider       string    `json:"provider,omitempty"`
	SessionID      string    `json:"session_id,omitempty"`
	ScopedStartAt  time.Time `json:"scoped_start_at"`
	ScopedEndAt    time.Time `json:"scoped_end_at"`
	ClientEventSeq int64     `json:"client_event_seq,omitempty"`
	EventAt        time.Time `json:"event_at"`
}

// auditRowForReplay carries the subset of audit_log columns the
// lookup needs. Kept private so callers go through SessionReplayLookup.
type auditRowForReplay struct {
	SessionID      string
	ClientEventSeq int64
	At             time.Time
}

// SessionReplayLookup resolves the replay URL for a single audit_log
// row. The caller is expected to have set the tenant GUC on the
// connection pool already (e.g. via db.WithTenant); we rely on the
// existing audit_log RLS policy to hide rows from cross-tenant peeks.
//
// Returns ErrNotAvailable when:
//   - the row does not exist or is hidden by RLS,
//   - the row carries no session_id (system / agent actors),
//   - no replay provider is configured.
func SessionReplayLookup(ctx context.Context, pool *pgxpool.Pool, tenantID string, auditID int64) (*ReplayURLResponse, error) {
	if pool == nil {
		return nil, ErrNotAvailable
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("session_link: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// SET LOCAL takes no bind parameters -- Postgres cannot even PREPARE
	// `SET LOCAL app.tenant_id = $1`, it is a syntax error at the $1 (42601).
	// set_config(name, value, is_local) is the function form, and its third
	// argument gives the same transaction-local scope.
	//
	// Every call through here failed, so this path has never once worked.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("session_link: set tenant: %w", err)
	}

	var row auditRowForReplay
	var sessionID *string
	var seq *int64
	if err := tx.QueryRow(ctx, `
SELECT session_id, client_event_seq, at
  FROM audit_log
 WHERE id = $1 AND tenant_id = $2::uuid
 LIMIT 1`, auditID, tenantID).Scan(&sessionID, &seq, &row.At); err != nil {
		// Either RLS hid it or the row truly doesn't exist; either
		// way the answer the operator should see is "not available"
		// rather than a 404 that reveals existence.
		return nil, ErrNotAvailable
	}
	if sessionID == nil || strings.TrimSpace(*sessionID) == "" {
		return nil, ErrNotAvailable
	}
	row.SessionID = *sessionID
	if seq != nil {
		row.ClientEventSeq = *seq
	}

	provider := strings.ToLower(strings.TrimSpace(os.Getenv("POSTWAVE_SESSION_REPLAY_PROVIDER")))
	base := strings.TrimSpace(os.Getenv("POSTWAVE_SESSION_REPLAY_BASE_URL"))
	if provider == "" || base == "" {
		return nil, ErrNotAvailable
	}

	start := row.At.Add(-ReplayScopeWindow).UTC()
	end := row.At.Add(ReplayScopeWindow).UTC()

	replayURL, err := buildReplayURL(provider, base, row.SessionID, start, end)
	if err != nil {
		return nil, err
	}

	return &ReplayURLResponse{
		Available:      true,
		ReplayURL:      replayURL,
		Provider:       provider,
		SessionID:      row.SessionID,
		ScopedStartAt:  start,
		ScopedEndAt:    end,
		ClientEventSeq: row.ClientEventSeq,
		EventAt:        row.At.UTC(),
	}, nil
}

// buildReplayURL assembles the provider-specific deep-link. Both
// PostHog and rrweb-on-S3 expose a deterministic URL shape we can
// construct without a round-trip to the provider, which keeps the
// audit-detail panel snappy.
func buildReplayURL(provider, base, sessionID string, start, end time.Time) (string, error) {
	switch provider {
	case "posthog":
		// PostHog's player honours ?timestamp= for an initial seek.
		// /replay/{session_id}?t={seconds_from_start} would also
		// work; the absolute timestamp form lines up better with our
		// ±2min window so the operator sees the surrounding context.
		u, err := url.Parse(base)
		if err != nil {
			return "", fmt.Errorf("session_link: parse posthog base: %w", err)
		}
		u.Path = strings.TrimRight(u.Path, "/") + "/replay/" + url.PathEscape(sessionID)
		q := u.Query()
		q.Set("t", start.UTC().Format(time.RFC3339))
		q.Set("end", end.UTC().Format(time.RFC3339))
		u.RawQuery = q.Encode()
		return u.String(), nil
	case "rrweb":
		// rrweb static hosting layout: <base>/<session_id>.json. The
		// player iframe reads start/end as query params and clips
		// frames outside the window.
		u, err := url.Parse(base)
		if err != nil {
			return "", fmt.Errorf("session_link: parse rrweb base: %w", err)
		}
		u.Path = strings.TrimRight(u.Path, "/") + "/" + url.PathEscape(sessionID) + ".json"
		q := u.Query()
		q.Set("start", start.UTC().Format(time.RFC3339))
		q.Set("end", end.UTC().Format(time.RFC3339))
		u.RawQuery = q.Encode()
		return u.String(), nil
	default:
		return "", ErrNotAvailable
	}
}
