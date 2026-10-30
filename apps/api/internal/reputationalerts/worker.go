// SPDX-License-Identifier: AGPL-3.0-only
//
// Package reputationalerts turns the reputation trend (INBOX-031,
// reputation_snapshots) into operator alerts (INBOX-036). A background worker
// scans the series for un-alerted transitions — a new blocklist hit, a
// SenderScore fall, or a provider bucket dropping to 'low' — and fans a
// notification out to the tenant's owners/admins through the shared
// notifyfanout chokepoint, gated by the per-user email_on_deliverability_alert
// preference. Each snapshot is alerted at most once (alerted_at stamp), and the
// fanout's own dedup makes a crash between dispatch and stamp safe (a re-run
// re-dispatches but the identical DedupeKey suppresses it).
package reputationalerts

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// defaultDropThreshold is the SenderScore fall (in points) that triggers a
// reputation-drop alert. A small wobble shouldn't page anyone.
const defaultDropThreshold = 10

// defaultBatchSize bounds one scan pass.
const defaultBatchSize = 200

// Fanout is the subset of notifyfanout used here (an interface so tests can
// fake it).
type Fanout interface {
	Dispatch(ctx context.Context, tenantID string, userIDs []string, ev notifyfanout.Event) []notifyfanout.Delivery
}

// Worker scans reputation_snapshots and dispatches deliverability alerts.
type Worker struct {
	Pool          *pgxpool.Pool
	Fanout        Fanout
	Logger        *slog.Logger
	DropThreshold int // 0 → defaultDropThreshold
	BatchSize     int // 0 → defaultBatchSize
}

func (w *Worker) dropThreshold() int {
	if w.DropThreshold > 0 {
		return w.DropThreshold
	}
	return defaultDropThreshold
}

func (w *Worker) batchSize() int {
	if w.BatchSize > 0 {
		return w.BatchSize
	}
	return defaultBatchSize
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// scanRow is one pending snapshot joined to its immediate predecessor.
type scanRow struct {
	id            string
	tenantID      string
	domain        string
	curSender     int
	curGoogle     string
	curMicrosoft  string
	curBlacklist  int
	curAvail      bool
	hasPrev       bool
	prevSender    *int
	prevGoogle    *string
	prevMicrosoft *string
	prevBlacklist *int
}

// Start runs RunOnce on a ticker until ctx is cancelled.
func (w *Worker) Start(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Minute
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n, err := w.RunOnce(ctx); err != nil {
				w.log().Warn("reputationalerts: scan failed", "err", err.Error())
			} else if n > 0 {
				w.log().Info("reputationalerts: processed snapshots", "count", n)
			}
		}
	}
}

// RunOnce processes one batch of pending snapshots. Returns the number scanned.
func (w *Worker) RunOnce(ctx context.Context) (int, error) {
	if w.Pool == nil {
		return 0, nil
	}
	rows, err := w.fetchPending(ctx)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}

	// Dispatch BEFORE stamping so a crash in between re-runs safely (the
	// fanout's per-user dedup on DedupeKey suppresses the replay). A row is
	// added to toMark only once it is genuinely HANDLED — a transient
	// admin-lookup failure leaves it un-stamped so the next tick retries
	// instead of silently dropping a real alert.
	toMark := make([]string, 0, len(rows))
	for _, r := range rows {
		title, body, ok := w.detect(r)
		if !ok {
			toMark = append(toMark, r.id) // nothing to alert on — done.
			continue
		}
		if w.Fanout == nil {
			toMark = append(toMark, r.id) // no channel wired — don't spin.
			continue
		}
		admins, err := w.adminUserIDs(ctx, r.tenantID)
		if err != nil {
			w.log().Warn("reputationalerts: admin lookup failed; will retry next tick",
				"tenant_id", r.tenantID, "err", err.Error())
			continue // leave alerted_at NULL → retried.
		}
		if len(admins) > 0 {
			domainLabel := r.domain
			if domainLabel == "" {
				domainLabel = "your sending domain"
			}
			w.Fanout.Dispatch(ctx, r.tenantID, admins, notifyfanout.Event{
				Type:       "deliverability.alert",
				Kind:       "deliverability_alert",
				Title:      title,
				Body:       body,
				MobileBody: "A deliverability issue was detected for " + domainLabel + ".",
				URL:        "/app/inbox-reality",
				EntityID:   r.id,
				DedupeKey:  "deliverability.alert:" + r.id,
				Pref:       notifications.PrefDeliverabilityAlert,
				Payload:    map[string]any{"domain": r.domain},
			})
		}
		// Dispatched, or genuinely no owners/admins to notify → done either way.
		toMark = append(toMark, r.id)
	}

	if len(toMark) > 0 {
		if err := w.markAlerted(ctx, toMark); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

// fetchPending reads un-alerted snapshots joined to their predecessor. Runs
// under worker scope so the cross-tenant scan sees every tenant's series.
func (w *Worker) fetchPending(ctx context.Context) ([]scanRow, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.tenant_id::text, s.domain,
       s.sender_score, s.google_score, s.microsoft_score, s.blacklist_hit_count, s.data_available,
       (prev.id IS NOT NULL) AS has_prev,
       prev.sender_score, prev.google_score, prev.microsoft_score, prev.blacklist_hit_count
  FROM reputation_snapshots s
  LEFT JOIN LATERAL (
      SELECT p.id, p.sender_score, p.google_score, p.microsoft_score, p.blacklist_hit_count
        FROM reputation_snapshots p
       WHERE p.tenant_id = s.tenant_id AND p.domain = s.domain AND p.ip = s.ip
         AND p.checked_at < s.checked_at
       ORDER BY p.checked_at DESC
       LIMIT 1
  ) prev ON true
 WHERE s.alerted_at IS NULL
 ORDER BY s.checked_at ASC
 LIMIT $1`, w.batchSize())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []scanRow{}
	for rows.Next() {
		var r scanRow
		if err := rows.Scan(&r.id, &r.tenantID, &r.domain,
			&r.curSender, &r.curGoogle, &r.curMicrosoft, &r.curBlacklist, &r.curAvail,
			&r.hasPrev, &r.prevSender, &r.prevGoogle, &r.prevMicrosoft, &r.prevBlacklist); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (w *Worker) markAlerted(ctx context.Context, ids []string) error {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE reputation_snapshots SET alerted_at = now() WHERE id = ANY($1::uuid[])`, ids); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// adminUserIDs lists the tenant's owner/admin user ids. It MUST run under a
// tenant-scoped tx: the users table has FORCE row-level security with a
// tenant_id-only policy (no worker escape), so a bare pool query — with no
// app.tenant_id bound — matches zero rows for every tenant and the alert would
// silently never reach anyone. Mirrors dashboardnotify.operatorIDs. The error
// is returned (not swallowed) so the caller can distinguish a transient failure
// (retry) from a genuine empty roster (done).
func (w *Worker) adminUserIDs(ctx context.Context, tenantID string) ([]string, error) {
	if tenantID == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text FROM users
 WHERE tenant_id = $1::uuid AND role = ANY($2::text[])
 ORDER BY created_at ASC`, tenantID, []string{"owner", "admin"})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 4)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// detect decides whether a snapshot transition warrants an alert and renders
// the copy. Pure (exported-ish for testing via the package test).
func (w *Worker) detect(r scanRow) (title, body string, ok bool) {
	// Never alert on an unavailable reading (it's noise, not a real drop) or
	// on the very first snapshot (nothing to compare against).
	if !r.curAvail || !r.hasPrev {
		return "", "", false
	}
	var reasons []string
	if r.prevBlacklist != nil && r.curBlacklist > *r.prevBlacklist {
		added := r.curBlacklist - *r.prevBlacklist
		unit := "hits"
		if added == 1 {
			unit = "hit"
		}
		reasons = append(reasons, fmt.Sprintf("%d new blocklist %s", added, unit))
	}
	if r.prevSender != nil && *r.prevSender >= 0 && r.curSender >= 0 &&
		(*r.prevSender-r.curSender) >= w.dropThreshold() {
		reasons = append(reasons, fmt.Sprintf("SenderScore fell %d→%d", *r.prevSender, r.curSender))
	}
	if droppedToLow(r.prevGoogle, r.curGoogle) {
		reasons = append(reasons, "Google reputation dropped to low")
	}
	if droppedToLow(r.prevMicrosoft, r.curMicrosoft) {
		reasons = append(reasons, "Microsoft reputation dropped to low")
	}
	if len(reasons) == 0 {
		return "", "", false
	}
	domainLabel := r.domain
	if domainLabel == "" {
		domainLabel = "your sending domain"
	}
	return "Deliverability alert: " + domainLabel,
		strings.Join(reasons, "; ") + ".", true
}

// droppedToLow reports whether a provider bucket fell TO 'low' from a known
// non-low value. An unknown (”) previous is not a drop.
func droppedToLow(prev *string, cur string) bool {
	if cur != "low" || prev == nil {
		return false
	}
	return *prev != "" && *prev != "low"
}
