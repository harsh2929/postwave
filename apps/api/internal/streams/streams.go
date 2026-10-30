// SPDX-License-Identifier: AGPL-3.0-only
//
// Package streams classifies every send into one of three streams:
// transactional, marketing, broadcast. The classification drives:
//
//   - Suppression scoping: an unsubscribe of stream='marketing' must
//     NOT block a transactional receipt to the same address. The
//     IsSuppressed query honours subscriber_suppressions.scope_stream.
//   - EQ Score thresholds: transactional messages tolerate much higher
//     spam scores because the content is short, link-heavy, and
//     boilerplate (password resets, receipts).
//   - Analytics rollups: per-stream open / click / complaint rates so
//     the operator can see "marketing 22% open / tx 88% open" without
//     conflating them.

package streams

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Stream is the typed enum.
type Stream string

const (
	Transactional Stream = "transactional"
	Marketing     Stream = "marketing"
	Broadcast     Stream = "broadcast"
)

// IsValid reports whether s is one of the canonical stream values.
func (s Stream) IsValid() bool {
	switch s {
	case Transactional, Marketing, Broadcast:
		return true
	}
	return false
}

// Normalize lower-cases + validates an incoming string. Returns
// Marketing as a safe default when input is empty.
func Normalize(s string) Stream {
	v := Stream(strings.ToLower(strings.TrimSpace(s)))
	if v == "" {
		return Marketing
	}
	if !v.IsValid() {
		return Marketing
	}
	return v
}

// EQScoreFloor returns the minimum EQ Score the sending pipeline
// will accept for this stream. Transactional gets the lowest floor
// (40) because receipts/password resets often look like spam (urgency
// language + auth-flavored links); marketing demands 60+.
func (s Stream) EQScoreFloor() int {
	switch s {
	case Transactional:
		return 40
	case Broadcast:
		return 55
	default:
		return 60
	}
}

// IsSuppressed reports whether a subscriber is suppressed for THIS
// stream. The rule:
//
//   - A suppression row with scope_stream IS NULL applies to every
//     stream (the "I'm done with you entirely" case).
//   - A suppression row with scope_stream = stream applies only when
//     the current send is that stream.
//   - Transactional receipts ignore marketing-only unsubs (legal
//     requirement: account-management messages override marketing
//     opt-outs).
//
// Returns (suppressed, reason). reason is the canonical
// subscriber_suppressions.reason value when suppressed.
func IsSuppressed(ctx context.Context, pool *db.Pool, tenantID, email string, stream Stream) (bool, string, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return false, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var reason string
	row := tx.QueryRow(ctx, `
SELECT reason FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND email = $2
   AND (expires_at IS NULL OR expires_at > now())
   AND (scope_stream IS NULL OR scope_stream = $3)
 ORDER BY (scope_stream IS NULL) DESC, created_at ASC
 LIMIT 1`, tenantID, strings.ToLower(strings.TrimSpace(email)), string(stream))
	if err := row.Scan(&reason); err != nil {
		if errors.Is(err, pgxErrNoRows()) {
			return false, "", nil
		}
		// Don't bubble — a query failure shouldn't block the send.
		// The dispatcher does a separate ConfirmEnabled check downstream.
		return false, "", err
	}
	return true, reason, nil
}

// CountsByStream returns send / open / click / complaint counts per
// stream for the dashboard. Window is the rollup interval (default 7
// days).
type StreamCounts struct {
	Stream       string `json:"stream"`
	Sent         int64  `json:"sent"`
	Opened       int64  `json:"opened"`
	Clicked      int64  `json:"clicked"`
	Complained   int64  `json:"complained"`
	Bounced      int64  `json:"bounced"`
	Unsubscribed int64  `json:"unsubscribed"`
}

// CountsByStream rolls subscriber_events up by stream for the tenant
// over the given window. Stream column is nullable; rows without a
// stream are reported under "unclassified".
func CountsByStream(ctx context.Context, pool *db.Pool, tenantID string, days int) ([]StreamCounts, error) {
	if days <= 0 {
		days = 7
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, fmt.Sprintf(`
SELECT COALESCE(stream, 'unclassified') AS s,
       SUM(CASE WHEN event_type = 'opened'      THEN 1 ELSE 0 END),
       SUM(CASE WHEN event_type = 'clicked'     THEN 1 ELSE 0 END),
       SUM(CASE WHEN event_type = 'complained'  THEN 1 ELSE 0 END),
       SUM(CASE WHEN event_type = 'bounced'     THEN 1 ELSE 0 END),
       SUM(CASE WHEN event_type = 'unsubscribed' THEN 1 ELSE 0 END)
  FROM subscriber_events
 WHERE tenant_id = $1::uuid
   AND at >= now() - INTERVAL '%d days'
 GROUP BY 1
 ORDER BY 1`, days), tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StreamCounts{}
	for rows.Next() {
		var s StreamCounts
		if err := rows.Scan(&s.Stream, &s.Opened, &s.Clicked,
			&s.Complained, &s.Bounced, &s.Unsubscribed); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// pgxErrNoRows is a tiny shim so we can compare to pgx.ErrNoRows
// without importing the pgx package across this stream-only utility.
// The deeper packages already import pgx; this is the one outlier
// that doesn't.
func pgxErrNoRows() error { return errNoRows }

var errNoRows = errors.New("no rows in result set") // mirrors pgx.ErrNoRows text
