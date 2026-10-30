// SPDX-License-Identifier: AGPL-3.0-only
//
// decay_worker.go — Segment Decay Radar (feature #5) background worker.
//
// The DecayWorker runs after each snapshot cycle: for every segment it
// reads the prior membership (segment_subscribers, the materialised join
// table from migration 0279) and the prior count (segment_size_history),
// re-evaluates the live membership via CompileAST, diffs the two sets in
// Go memory (bounded by the per-tick segment cap), classifies the
// transition with the PURE detectAnomalyKind, and — only when an anomaly
// is detected and there are leavers — runs per-clause attribution. On an
// anomaly it: writes the bounded membership-log batch, inserts a
// segment_decay_events row, emits a segment.decay audit_log row (which
// the audit_alerts pipeline can fan out — D4), and fires a direct
// notification email gated by notification_preferences (D4 Option C).
//
// SAFETY: every per-tenant operation re-enters db.WithTenant so RLS
// fires; tenant enumeration runs under db.WithWorkerScope. Memory is
// bounded: the before/after sets are UUID maps and the per-direction log
// batch is capped at MembershipLogCapPerDirection (D1). Attribution is
// capped to the first decayAttributionMaxClauses top-level clauses to
// bound DB round-trips.
//
// Definition-integrity (D5): when a size anomaly is detected, the worker
// checks audit_log for a recent segment.update; if found, the event is
// annotated anomaly_kind='definition_changed' instead of the raw size
// kind so the operator sees "the definition changed" rather than a
// mysterious cliff.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// decayMaxSegmentsPerTenantPerTick bounds one tenant's work per tick so a
// tenant with thousands of segments drains gradually. Mirrors the
// snapshot worker's constant.
const decayMaxSegmentsPerTenantPerTick = 200

// decayAttributionMaxClauses caps how many top-level AST clauses get a
// per-clause attribution query, bounding DB round-trips per decayed
// segment (risk: N queries per segment per tick).
const decayAttributionMaxClauses = 8

// decayDefinitionChangeWindow is how far back the worker looks for a
// recent segment.update when annotating definition_changed (D5).
const decayDefinitionChangeWindow = 48 * time.Hour

// PrefSegmentDecay is the notification_preferences pref controlling the
// DecayWorker's direct-email path (column email_on_segment_decay,
// migration 0412). Defined here so the segments package owns it; the
// integrator adds the matching case to notifications.column() via the
// manifest. Until that case lands, an unknown pref fails open (sends),
// which is the desired default-on behaviour anyway.
const PrefSegmentDecay notifications.Pref = "segment_decay"

// DecayWorker detects segment anomalies after each snapshot cycle.
type DecayWorker struct {
	Pool   *db.Pool
	Store  DecayStore
	Repo   *Repo
	Logger *slog.Logger

	// AIProvider is intentionally NOT used by the worker tick: narration
	// is on-demand (D3). Kept off the worker entirely so the tick stays
	// deterministic.

	// Mailer + Dispatcher drive the direct-email path (D4 Option C). Both
	// optional: nil Mailer disables direct email; nil Dispatcher fails
	// open (sends to opted-in default).
	Mailer     mailer.Mailer
	Dispatcher notifications.Dispatcher
	// FromAddress is the From header for direct decay emails.
	FromAddress string

	// Interval defaults to 1 hour (runs after the snapshot worker).
	Interval time.Duration

	// Thresholds (D2). Zero values fall back to the package defaults.
	CliffPctThreshold float64
	CliffAbsThreshold int
}

// Run drives the worker until ctx is canceled.
func (w *DecayWorker) Run(ctx context.Context) error {
	if w == nil || w.Pool == nil || w.Store == nil || w.Repo == nil {
		return errors.New("segments decay worker: nil deps")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = time.Hour
	}
	if w.Logger != nil {
		w.Logger.Info("segment-decay-worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if err := w.tick(ctx); err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("segment decay tick failed", "err", err.Error())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *DecayWorker) pctThreshold() float64 {
	if w.CliffPctThreshold > 0 {
		return w.CliffPctThreshold
	}
	return DefaultCliffPctThreshold
}

func (w *DecayWorker) absThreshold() int {
	if w.CliffAbsThreshold > 0 {
		return w.CliffAbsThreshold
	}
	return DefaultCliffAbsThreshold
}

// tick enumerates tenants (worker scope) and analyses each tenant's
// segments. Per-tenant failures are isolated.
func (w *DecayWorker) tick(ctx context.Context) error {
	tenants, err := w.listTenants(ctx)
	if err != nil {
		return err
	}
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.analyzeTenant(ctx, tenantID); err != nil && w.Logger != nil {
			w.Logger.Warn("segment decay: tenant failed",
				"tenant_id", tenantID, "err", err.Error())
		}
	}
	return nil
}

func (w *DecayWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// analyzeTenant loads each segment of a tenant (bounded) and analyses it.
func (w *DecayWorker) analyzeTenant(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.query_ast, COALESCE(s.last_count, 0)
  FROM segments s
 WHERE s.tenant_id = $1::uuid
 ORDER BY s.created_at ASC
 LIMIT $2`, tenantID, decayMaxSegmentsPerTenantPerTick)
	if err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	type pending struct {
		id        string
		ast       []byte
		lastCount int
	}
	todo := []pending{}
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.ast, &p.lastCount); err != nil {
			rows.Close()
			_ = tx.Rollback(ctx)
			return err
		}
		todo = append(todo, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	_ = tx.Rollback(ctx) // read-only scan

	for _, p := range todo {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.analyzeSegment(ctx, tenantID, p.id, p.lastCount, p.ast); err != nil && w.Logger != nil {
			w.Logger.Warn("segment decay: segment failed",
				"tenant_id", tenantID, "segment_id", p.id, "err", err.Error())
		}
	}
	return nil
}

// analyzeSegment is the per-segment core. It diffs prior membership
// (segment_subscribers) against the live re-evaluation, classifies the
// transition, and — on an anomaly — persists the membership log, the
// decay event, the audit row, and the direct email.
//
// priorCount is segments.last_count (the prior snapshot's count). The
// live count is computed from the canonical definition population. This keeps the function
// testable: the DB reads are isolated to readPriorMembers / liveMembers
// helpers, and the classification + attribution are pure.
func (w *DecayWorker) analyzeSegment(ctx context.Context, tenantID, segmentID string, priorCount int, ast []byte) error {
	predicate, err := CompilePopulation(ctx, ast, tenantID, w.Repo, DefinitionPopulation(false))
	if err != nil {
		return err
	}
	frag, args := predicate.SQL, predicate.Args
	total, err := w.totalSubscribers(ctx, tenantID)
	if err != nil {
		return err
	}
	newCount, err := w.Repo.Count(ctx, tenantID, frag, args)
	if err != nil {
		return err
	}

	kind := detectAnomalyKind(priorCount, newCount, total, w.pctThreshold(), w.absThreshold())
	if kind == AnomalyNone {
		return nil // stable — no false positive.
	}

	// Diff the membership sets to identify leavers/entrants for the log +
	// attribution. Bounded by the per-direction cap (D1).
	prior, err := w.readPriorMembers(ctx, tenantID, segmentID)
	if err != nil {
		return err
	}
	live, err := w.liveMembers(ctx, tenantID, frag, args)
	if err != nil {
		return err
	}
	leavers, entrants := diffMembership(prior, live)

	snapshotDate := time.Now().UTC().Format("2006-01-02")

	// Per-clause attribution (only for leavers, only when detected).
	clauseAttrPerLeaver, leaverClauseBlobs, err := w.attributeLeavers(ctx, tenantID, ast, leavers)
	if err != nil {
		return fmt.Errorf("segment decay: attribute leavers: %w", err)
	}
	aggregated := attributionFromClauseAttrs(clauseAttrPerLeaver)
	var clauseAttrsJSON json.RawMessage
	if aggregated != nil {
		if b, mErr := json.Marshal(aggregated); mErr == nil {
			clauseAttrsJSON = b
		}
	}

	// Definition-integrity (D5): if the segment changed definition
	// recently, relabel the anomaly so the operator sees the real cause.
	if changed, _ := w.recentDefinitionChange(ctx, tenantID, segmentID); changed {
		kind = AnomalyDefinitionChange
	}

	// Persist the bounded membership-log batch.
	entries := buildLogEntries(leavers, entrants, leaverClauseBlobs)
	if err := w.Store.InsertMembershipLogBatch(ctx, tenantID, segmentID, snapshotDate, entries); err != nil && w.Logger != nil {
		w.Logger.Warn("segment decay: membership log insert failed",
			"tenant_id", tenantID, "segment_id", segmentID, "err", err.Error())
	}

	ev := DecayEvent{
		SegmentID:    segmentID,
		SnapshotDate: snapshotDate,
		AnomalyKind:  kind,
		PriorCount:   priorCount,
		NewCount:     newCount,
		LeaverCount:  len(leavers),
		EntrantCount: len(entrants),
		ClauseAttrs:  clauseAttrsJSON,
	}
	eventID, err := w.Store.InsertDecayEvent(ctx, tenantID, ev)
	if err != nil {
		return err
	}
	ev.ID = eventID

	// Emit the canonical audit row (joins the audit_alerts pipeline — D4).
	w.emitDecayAudit(ctx, tenantID, ev)

	// Direct email (D4 Option C), gated by the pref. Best-effort.
	w.deliverEmail(ctx, tenantID, ev)

	return nil
}

// totalSubscribers counts the tenant's subscribers (for everyone_match).
func (w *DecayWorker) totalSubscribers(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND archived_at IS NULL`, tenantID).Scan(&n); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return n, nil
}

// readPriorMembers loads the prior membership set from the materialised
// segment_subscribers join table (migration 0279). Returns a set of
// subscriber_id → email.
func (w *DecayWorker) readPriorMembers(ctx context.Context, tenantID, segmentID string) (map[string]string, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT ss.subscriber_id::text, COALESCE(sub.email::text, '')
  FROM segment_subscribers ss
  LEFT JOIN subscribers sub ON sub.id = ss.subscriber_id
 WHERE ss.tenant_id = $1::uuid AND ss.segment_id = $2::uuid
   AND sub.archived_at IS NULL`, tenantID, segmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		out[id] = email
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	_ = tx.Commit(ctx)
	return out, nil
}

// liveMembers re-evaluates the predicate to the current membership set.
func (w *DecayWorker) liveMembers(ctx context.Context, tenantID, frag string, args []interface{}) (map[string]string, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := "SELECT id::text, COALESCE(email::text, '') FROM subscribers WHERE " + frag
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var id, email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		out[id] = email
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	_ = tx.Commit(ctx)
	return out, nil
}

// attributeLeavers runs per-clause attribution against the leaver set.
// For each top-level AST clause (capped at decayAttributionMaxClauses),
// it asks: of the leavers, which still satisfy this clause? A leaver that
// still satisfies clause i but no longer satisfies the whole predicate
// left "because of" some OTHER clause — but recording which clauses they
// still match lets the UI surface where the predicate boundary moved.
//
// Returns (per-leaver clause map for aggregation, per-leaver JSON blob
// for the membership log). Empty inputs produce no attribution; evaluator or
// query failures are returned so an incomplete attribution is never persisted
// as if it were a trustworthy zero-match result.
func (w *DecayWorker) attributeLeavers(ctx context.Context, tenantID string, ast []byte, leavers map[string]string) ([]map[int]bool, map[string]json.RawMessage, error) {
	if len(leavers) == 0 {
		return nil, nil, nil
	}
	clauses := topLevelClauses(ast)
	if len(clauses) == 0 {
		return nil, nil, nil
	}
	if len(clauses) > decayAttributionMaxClauses {
		clauses = clauses[:decayAttributionMaxClauses]
	}
	leaverIDs := make([]string, 0, len(leavers))
	for id := range leavers {
		leaverIDs = append(leaverIDs, id)
	}

	// per-leaver clause membership: id -> {clauseIdx -> matched}.
	perLeaver := map[string]map[int]bool{}
	for _, id := range leaverIDs {
		perLeaver[id] = map[int]bool{}
	}

	for idx, clause := range clauses {
		predicate, err := CompilePopulation(ctx, clause, tenantID, w.Repo, DefinitionPopulation(false))
		if err != nil {
			return nil, nil, fmt.Errorf("compile clause %d: %w", idx, err)
		}
		matched, err := w.leaversMatchingClause(ctx, tenantID, predicate.SQL, predicate.Args, leaverIDs)
		if err != nil {
			return nil, nil, fmt.Errorf("evaluate clause %d: %w", idx, err)
		}
		for _, id := range matched {
			if m, ok := perLeaver[id]; ok {
				m[idx] = true
			}
		}
	}

	// Flatten to the slice form for aggregation + the JSON blob form for
	// the log.
	aggInput := make([]map[int]bool, 0, len(leaverIDs))
	blobs := map[string]json.RawMessage{}
	for _, id := range leaverIDs {
		m := perLeaver[id]
		aggInput = append(aggInput, m)
		if len(m) > 0 {
			if b, err := json.Marshal(m); err == nil {
				blobs[id] = b
			}
		}
	}
	return aggInput, blobs, nil
}

// leaversMatchingClause returns which of leaverIDs satisfy the clause
// fragment. Runs one query with the id set bound as an array.
func (w *DecayWorker) leaversMatchingClause(ctx context.Context, tenantID, frag string, args []interface{}, leaverIDs []string) ([]string, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Append the id-array as the next placeholder after the clause args.
	idArgPos := len(args) + 1
	q := fmt.Sprintf(
		"SELECT id::text FROM subscribers WHERE (%s) AND id::text = ANY($%d)",
		frag, idArgPos)
	allArgs := append(append([]interface{}{}, args...), leaverIDs)
	rows, err := tx.Query(ctx, q, allArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
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
	_ = tx.Commit(ctx)
	return out, nil
}

// recentDefinitionChange checks audit_log for a segment.update against
// this segment in the definition-change window (D5).
func (w *DecayWorker) recentDefinitionChange(ctx context.Context, tenantID, segmentID string) (bool, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_type = 'segment'
   AND resource_id = $2
   AND action = 'segment.update'
   AND at >= now() - $3::interval`,
		tenantID, segmentID, fmt.Sprintf("%d hours", int(decayDefinitionChangeWindow.Hours()))).Scan(&n); err != nil {
		return false, err
	}
	_ = tx.Commit(ctx)
	return n > 0, nil
}

// emitDecayAudit writes the canonical segment.decay audit row. Sets up a
// worker audit context (tenant + system actor) so EmitOrLog resolves the
// tenant from ctx, then short-circuits via the test hook when installed.
func (w *DecayWorker) emitDecayAudit(ctx context.Context, tenantID string, ev DecayEvent) {
	actx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: tenantID})
	actx = middleware.WithActor(actx, "system", "segment-decay-worker")
	audit.EmitOrLog(actx, w.Pool, "segment.decay", "segment", ev.SegmentID, nil, nil, map[string]any{
		"event_id":      ev.ID,
		"anomaly_kind":  ev.AnomalyKind,
		"prior_count":   ev.PriorCount,
		"new_count":     ev.NewCount,
		"leaver_count":  ev.LeaverCount,
		"entrant_count": ev.EntrantCount,
		"snapshot_date": ev.SnapshotDate,
	})
}

// deliverEmail sends the direct decay-alert email (D4 Option C), gated by
// the PrefSegmentDecay notification pref. Best-effort: a nil Mailer
// disables the path; a Dispatcher error fails open (sends). The email is
// sent to each tenant owner/admin recipient resolved from the DB.
func (w *DecayWorker) deliverEmail(ctx context.Context, tenantID string, ev DecayEvent) {
	if w.Mailer == nil {
		return
	}
	recipients, err := w.alertRecipients(ctx, tenantID)
	if err != nil || len(recipients) == 0 {
		return
	}
	from := w.FromAddress
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	subject := decayEmailSubject(ev)
	body := decayEmailBody(ev)
	for _, rcpt := range recipients {
		if w.Dispatcher != nil {
			allowed, _ := w.Dispatcher.Gate(ctx, tenantID, rcpt.userID, PrefSegmentDecay)
			if !allowed {
				continue
			}
		}
		msg := mailer.Message{
			From:    from,
			To:      rcpt.email,
			Subject: subject,
			Body:    body,
			Tags:    map[string]string{"purpose": "segment_decay"},
		}
		if err := w.Mailer.Send(ctx, msg); err != nil && w.Logger != nil {
			w.Logger.Warn("segment decay: email send failed",
				"tenant_id", tenantID, "to", rcpt.email, "err", err.Error())
		}
	}
}

type decayRecipient struct {
	userID string
	email  string
}

// alertRecipients resolves the tenant's owner/admin users for direct
// decay emails. Tenant-scoped (RLS).
func (w *DecayWorker) alertRecipients(ctx context.Context, tenantID string) ([]decayRecipient, error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, email
  FROM users
 WHERE tenant_id = $1::uuid
   AND COALESCE(role, '') IN ('owner', 'admin')
   AND email IS NOT NULL AND email <> ''`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []decayRecipient{}
	for rows.Next() {
		var r decayRecipient
		if err := rows.Scan(&r.userID, &r.email); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	_ = tx.Commit(ctx)
	return out, nil
}

// narrateDecay is the on-demand LLM "who left and why" path (D3). With a
// nil provider it returns ("", "", nil) — never panics — so the handler
// degrades to 503 ai_unavailable. The returned model string is
// best-effort metadata for the segment_decay_events.narration_model
// column.
func narrateDecay(ctx context.Context, provider NLProvider, ev DecayEvent, leaverSample []string) (string, string, error) {
	if provider == nil {
		return "", "", nil
	}
	var b strings.Builder
	b.WriteString("Segment anomaly: ")
	b.WriteString(ev.AnomalyKind)
	b.WriteString(fmt.Sprintf(". Prior members: %d, now: %d (%d left, %d entered).",
		ev.PriorCount, ev.NewCount, ev.LeaverCount, ev.EntrantCount))
	if len(ev.ClauseAttrs) > 0 {
		b.WriteString(" Clause attribution (clause_index: leavers still matching): ")
		b.Write(ev.ClauseAttrs)
		b.WriteString(".")
	}
	if len(leaverSample) > 0 {
		b.WriteString(" Sample of departed members: ")
		b.WriteString(strings.Join(leaverSample, ", "))
		b.WriteString(".")
	}
	system := "You are a marketing-ops analyst. In 2-3 plain-English sentences, " +
		"explain who likely left this audience segment and why, based ONLY on the " +
		"data provided. Do not invent causes not supported by the data. Be honest " +
		"about uncertainty."
	text, err := provider.Complete(ctx, system, b.String())
	if err != nil {
		return "", "", err
	}
	return strings.TrimSpace(text), "ai-narration", nil
}

// ----------------------------------------------------------------------
// Pure helpers (DB-free) — diff, log building, clause extraction, copy.
// ----------------------------------------------------------------------

// diffMembership computes leavers (in prior, not in live) and entrants
// (in live, not in prior). Each is a subscriber_id → email map. Pure.
func diffMembership(prior, live map[string]string) (leavers, entrants map[string]string) {
	leavers = map[string]string{}
	entrants = map[string]string{}
	for id, email := range prior {
		if _, ok := live[id]; !ok {
			leavers[id] = email
		}
	}
	for id, email := range live {
		if _, ok := prior[id]; !ok {
			entrants[id] = email
		}
	}
	return leavers, entrants
}

// buildLogEntries assembles the membership-log batch, applying the
// per-direction cap (D1). Leavers carry their clause blob when available.
// Pure (cap enforced here, before any INSERT).
func buildLogEntries(leavers, entrants map[string]string, leaverBlobs map[string]json.RawMessage) []MembershipDiffEntry {
	out := make([]MembershipDiffEntry, 0, len(leavers)+len(entrants))
	n := 0
	for id, email := range leavers {
		if n >= MembershipLogCapPerDirection {
			break
		}
		e := MembershipDiffEntry{SubscriberID: id, Email: email, Direction: "left"}
		if blob, ok := leaverBlobs[id]; ok {
			e.ClauseAttrs = blob
		}
		out = append(out, e)
		n++
	}
	n = 0
	for id, email := range entrants {
		if n >= MembershipLogCapPerDirection {
			break
		}
		out = append(out, MembershipDiffEntry{SubscriberID: id, Email: email, Direction: "entered"})
		n++
	}
	return out
}

// topLevelClauses returns the children of the root AND/OR node as
// individual AST blobs for per-clause attribution. A non-boolean root
// (a single condition) yields one clause: the whole AST. An empty/invalid
// AST yields nil. Pure.
func topLevelClauses(ast []byte) []json.RawMessage {
	if len(ast) == 0 {
		return nil
	}
	var node astNode
	if err := json.Unmarshal(ast, &node); err != nil {
		return nil
	}
	switch strings.ToLower(node.Op) {
	case "and", "or":
		out := make([]json.RawMessage, 0, len(node.Children))
		for _, ch := range node.Children {
			if b, err := json.Marshal(ch); err == nil {
				out = append(out, b)
			}
		}
		return out
	case "condition", "not":
		// A single top-level condition / negation is its own clause.
		return []json.RawMessage{json.RawMessage(ast)}
	default:
		return nil
	}
}

func decayEmailSubject(ev DecayEvent) string {
	switch ev.AnomalyKind {
	case AnomalyZeroMatch:
		return "Heads up: a segment now matches nobody"
	case AnomalyEveryoneMatch:
		return "Heads up: a segment now matches everyone"
	case AnomalyDefinitionChange:
		return "Heads up: a segment changed definition and its size shifted"
	default:
		return "Heads up: a segment's membership dropped sharply"
	}
}

func decayEmailBody(ev DecayEvent) string {
	return fmt.Sprintf(
		"A segment in your Moosewave workspace just changed unexpectedly.\n\n"+
			"  Anomaly: %s\n"+
			"  Members before: %d\n"+
			"  Members now: %d\n"+
			"  Departed: %d   New: %d\n"+
			"  Detected: %s\n\n"+
			"This is an advisory heads-up — nothing was paused or changed. "+
			"Open the segment in Moosewave to review the exit set and per-clause "+
			"attribution.\n",
		ev.AnomalyKind, ev.PriorCount, ev.NewCount, ev.LeaverCount, ev.EntrantCount, ev.SnapshotDate)
}
