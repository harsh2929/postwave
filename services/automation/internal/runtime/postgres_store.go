package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStateStore writes execution state into automation_executions and
// automation_paused (see infra/migrations/0011_automation_state.sql). It
// implements the StateStore interface so it is a drop-in replacement for
// MemoryStore.
//
// The exec id is derived deterministically from
// (automationID, subscriberEmail, runID) so duplicate delivery within one run
// UPSERTs the same row while an allowed re-enrollment gets independent state.
// Migration 1779 backs the invariant with a run-aware logical unique index.
type PostgresStateStore struct {
	Pool *pgxpool.Pool
	// TenantOf resolves automation_id → tenant_id. The automation runtime is
	// invoked from the API gateway with the tenant in scope, but this store
	// also needs to scope its own writes; the resolver lets callers wire up
	// either a cache or a Postgres lookup as needed.
	TenantOf func(ctx context.Context, automationID string) (string, error)
}

// NewPostgresStateStore is a tiny constructor.
func NewPostgresStateStore(p *pgxpool.Pool, tenantOf func(context.Context, string) (string, error)) (*PostgresStateStore, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	if tenantOf == nil {
		// Default: lookup the tenant from any existing execution row.
		tenantOf = func(ctx context.Context, aid string) (string, error) {
			var t string
			err := p.QueryRow(ctx,
				`SELECT tenant_id::text FROM automation_executions WHERE automation_id = $1::uuid LIMIT 1`,
				aid).Scan(&t)
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil
			}
			return t, err
		}
	}
	return &PostgresStateStore{Pool: p, TenantOf: tenantOf}, nil
}

// execID is the deterministic primary key used in the table.
//
// The run is part of the key: that is what makes re-enrollment possible at
// all. Before it, the key was sha256(automation|email), so one row existed per
// (flow, subscriber) FOREVER and its completed_nodes set — union-merged and
// never cleared — short-circuited every subsequent traversal.
//
// LegacyRunID deliberately reproduces the OLD id. Rows written before
// re-enrollment are backfilled with run_id='legacy' (migration 1705), so a
// journey that is mid-flight when this deploys keeps the same primary key and
// resumes normally instead of being orphaned.
func execID(automationID, email, runID string) string {
	if runID == "" || runID == LegacyRunID {
		h := sha256.Sum256([]byte(automationID + "|" + email))
		return hex.EncodeToString(h[:16])
	}
	h := sha256.Sum256([]byte(automationID + "|" + email + "|" + runID))
	return hex.EncodeToString(h[:16])
}

// Get implements StateStore.
func (s *PostgresStateStore) Get(ctx context.Context, automationID, email, runID string) (*ExecutionState, error) {
	tenantID, err := s.TenantOf(ctx, automationID)
	if err != nil {
		return nil, err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := execID(automationID, email, runID)
	var (
		current   *string
		completed []string
		startedAt time.Time
		lastAt    time.Time
		paused    bool
	)
	err = tx.QueryRow(ctx, `
		SELECT current_node, completed_nodes, started_at, last_at, paused
		  FROM automation_executions WHERE tenant_id = $1::uuid AND id = $2
	`, tenantID, id).Scan(&current, &completed, &startedAt, &lastAt, &paused)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st := &ExecutionState{
		TenantID:        tenantID,
		AutomationID:    automationID,
		SubscriberEmail: email,
		StartedAt:       startedAt,
		LastAt:          lastAt,
		Paused:          paused,
		CompletedNodes:  map[string]time.Time{},
	}
	if current != nil {
		st.CurrentNodeID = *current
	}
	for _, n := range completed {
		st.CompletedNodes[n] = lastAt
	}
	return st, tx.Commit(ctx)
}

// Upsert implements StateStore.
func (s *PostgresStateStore) Upsert(ctx context.Context, st *ExecutionState) error {
	tenantID := st.TenantID
	if tenantID == "" {
		var err error
		tenantID, err = s.TenantOf(ctx, st.AutomationID)
		if err != nil {
			return err
		}
		if tenantID == "" {
			return fmt.Errorf("no tenant for automation %s", st.AutomationID)
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	completed := make([]string, 0, len(st.CompletedNodes))
	for k := range st.CompletedNodes {
		completed = append(completed, k)
	}
	id := execID(st.AutomationID, st.SubscriberEmail, st.RunID)
	_, err = tx.Exec(ctx, `
		INSERT INTO automation_executions
			(id, tenant_id, automation_id, subscriber_email,
			 current_node, completed_nodes, started_at, last_at, paused, run_id)
		VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (id) DO UPDATE SET
				current_node = EXCLUDED.current_node,
				completed_nodes = ARRAY(
					SELECT DISTINCT node
					FROM unnest(
						COALESCE(automation_executions.completed_nodes, ARRAY[]::text[]) ||
						COALESCE(EXCLUDED.completed_nodes, ARRAY[]::text[])
					) AS node
				),
				last_at = now(),
				paused = EXCLUDED.paused
	`, id, tenantID, st.AutomationID, st.SubscriberEmail,
		nullable(st.CurrentNodeID), completed, st.StartedAt, time.Now().UTC(), st.Paused,
		runIDOrLegacy(st.RunID))
	if err != nil {
		return fmt.Errorf("upsert execution: %w", err)
	}
	return tx.Commit(ctx)
}

// MarkCompleted implements StateStore.
func (s *PostgresStateStore) MarkCompleted(ctx context.Context, automationID, email, nodeID, runID string) error {
	tenantID, err := s.TenantOf(ctx, automationID)
	if err != nil {
		return err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := execID(automationID, email, runID)
	// array_append is idempotent with a uniqueness check via array_position.
	_, err = tx.Exec(ctx, `
		INSERT INTO automation_executions
			(id, tenant_id, automation_id, subscriber_email, completed_nodes, started_at, last_at, run_id)
		VALUES ($1, $2::uuid, $3::uuid, $4, ARRAY[$5]::text[], now(), now(), $6)
		ON CONFLICT (id) DO UPDATE SET
			completed_nodes = CASE
				WHEN $5 = ANY (automation_executions.completed_nodes)
					THEN automation_executions.completed_nodes
				ELSE array_append(automation_executions.completed_nodes, $5)
			END,
			last_at = now()
	`, id, tenantID, automationID, email, nodeID, runIDOrLegacy(runID))
	if err != nil {
		return fmt.Errorf("mark completed: %w", err)
	}
	return tx.Commit(ctx)
}

// SetPaused implements StateStore.
func (s *PostgresStateStore) SetPaused(ctx context.Context, automationID string, paused bool) error {
	tenantID, err := s.TenantOf(ctx, automationID)
	if err != nil {
		return err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO automation_paused (automation_id, tenant_id, paused)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (automation_id) DO UPDATE SET paused = EXCLUDED.paused, updated_at = now()
	`, automationID, tenantID, paused)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// IsPaused implements StateStore.
func (s *PostgresStateStore) IsPaused(ctx context.Context, automationID string) (bool, error) {
	tenantID, err := s.TenantOf(ctx, automationID)
	if err != nil {
		return false, err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var paused bool
	err = tx.QueryRow(ctx,
		`SELECT paused FROM automation_paused WHERE tenant_id = $1::uuid AND automation_id = $2::uuid`,
		tenantID, automationID,
	).Scan(&paused)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return paused, tx.Commit(ctx)
}

// ListActive implements StateStore.
func (s *PostgresStateStore) ListActive(ctx context.Context, tenantID string) ([]ExecutionState, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// run_id is load-bearing here, not decorative: EventDispatcher resumes
	// parked wait_until_trigger executions from these rows. If RunID came back
	// empty the resume would be written against the legacy run instead of the
	// run the subscriber is actually in, and the parked node would re-execute.
	rows, err := tx.Query(ctx, `
		SELECT automation_id::text, subscriber_email, current_node, completed_nodes,
		       started_at, last_at, paused, COALESCE(run_id, $2)
		  FROM automation_executions
		 WHERE tenant_id = $1::uuid
		 ORDER BY last_at DESC
	`, tenantID, LegacyRunID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ExecutionState
	for rows.Next() {
		var st ExecutionState
		var current *string
		var completed []string
		if err := rows.Scan(&st.AutomationID, &st.SubscriberEmail, &current, &completed,
			&st.StartedAt, &st.LastAt, &st.Paused, &st.RunID); err != nil {
			return nil, err
		}
		st.TenantID = tenantID
		if current != nil {
			st.CurrentNodeID = *current
		}
		st.CompletedNodes = make(map[string]time.Time, len(completed))
		for _, n := range completed {
			st.CompletedNodes[n] = st.LastAt
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecordEvent appends an automation runtime event. The backing table is added
// by 0030_mailchimp_productization.sql and is shared by legacy automations
// and visual automation_journeys so their timelines have one API shape.
func (s *PostgresStateStore) RecordEvent(ctx context.Context, ev JourneyEvent) error {
	tenantID := ev.TenantID
	if tenantID == "" {
		var err error
		tenantID, err = s.TenantOf(ctx, ev.AutomationID)
		if err != nil {
			return err
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	payload, err := json.Marshal(nonNilMap(ev.Payload))
	if err != nil {
		return fmt.Errorf("marshal event payload: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO automation_journey_events
			(tenant_id, automation_id, subscriber_email, event_type, node_id,
			 status, message, payload, at)
		VALUES ($1::uuid, $2::uuid, NULLIF($3, ''), $4, NULLIF($5, ''),
		        NULLIF($6, ''), NULLIF($7, ''), $8::jsonb, $9)
	`, tenantID, ev.AutomationID, ev.SubscriberEmail, ev.EventType, ev.NodeID,
		ev.Status, ev.Message, string(payload), ev.At)
	if err != nil {
		return fmt.Errorf("record automation event: %w", err)
	}
	return tx.Commit(ctx)
}

// ListEvents returns newest-first events for one automation/journey.
func (s *PostgresStateStore) ListEvents(ctx context.Context, tenantID, automationID string, limit int) ([]JourneyEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT tenant_id::text, automation_id::text, COALESCE(subscriber_email::text, ''),
		       event_type, COALESCE(node_id, ''), COALESCE(status, ''),
		       COALESCE(message, ''), payload, at
		  FROM automation_journey_events
		 WHERE tenant_id = $1::uuid AND automation_id = $2::uuid
		 ORDER BY at DESC, id DESC
		 LIMIT $3
	`, tenantID, automationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []JourneyEvent{}
	for rows.Next() {
		var ev JourneyEvent
		var raw []byte
		if err := rows.Scan(&ev.TenantID, &ev.AutomationID, &ev.SubscriberEmail,
			&ev.EventType, &ev.NodeID, &ev.Status, &ev.Message, &raw, &ev.At); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &ev.Payload)
		}
		if ev.Payload == nil {
			ev.Payload = map[string]interface{}{}
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RecordStepMetric rolls one node-execution outcome up into the per-node
// counter row (tenant, flow, node, action_kind) via ON CONFLICT … DO UPDATE.
// The engine is per-subscriber streaming, so a plain append would bloat the
// table 1 row per subscriber per step; the rollup keeps it bounded by
// flow × node × action_kind. See 1627_flow_step_metrics_rollup_unique.sql.
func (s *PostgresStateStore) RecordStepMetric(ctx context.Context, m StepMetric) error {
	if m.AutomationID == "" || m.NodeID == "" || m.ActionKind == "" {
		return fmt.Errorf("step metric missing automation/node/action_kind")
	}
	var applied, skipped, failed int
	switch m.Outcome {
	case "applied":
		applied = 1
	case "skipped":
		skipped = 1
	case "failed":
		failed = 1
	default:
		return fmt.Errorf("unknown step metric outcome %q", m.Outcome)
	}
	tenantID := m.TenantID
	if tenantID == "" {
		var err error
		tenantID, err = s.TenantOf(ctx, m.AutomationID)
		if err != nil {
			return err
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO flow_step_metrics
			(tenant_id, flow_id, node_id, action_kind, applied, skipped, failed, error, occurred_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, NULLIF($8, ''), now())
		ON CONFLICT (tenant_id, flow_id, node_id, action_kind) WHERE run_id IS NULL
		DO UPDATE SET
			applied     = flow_step_metrics.applied + EXCLUDED.applied,
			skipped     = flow_step_metrics.skipped + EXCLUDED.skipped,
			failed      = flow_step_metrics.failed  + EXCLUDED.failed,
			error       = COALESCE(EXCLUDED.error, flow_step_metrics.error),
			occurred_at = now()
	`, tenantID, m.AutomationID, m.NodeID, m.ActionKind, applied, skipped, failed, m.Error)
	if err != nil {
		return fmt.Errorf("record flow step metric: %w", err)
	}

	// The per-RUN row, appended alongside the rollup.
	//
	// The rollup answers "how does this node behave"; it cannot answer "what
	// happened on the run I am looking at", which is the question a per-node
	// inspector exists for. Both are kept because the existing reader consumes
	// the rollup directly, and deriving it from per-run rows would be a second
	// change to a path that already works.
	//
	// APPENDED, not upserted, and that is the shape migration 1627 planned for:
	// its unique index is partial on `run_id IS NULL` precisely "so a future
	// batch path that wants per-run rows can still append without colliding with
	// the rollup". The matching read index — `(tenant_id, run_id, occurred_at)
	// WHERE run_id IS NOT NULL` — has existed since then and until now matched
	// zero rows.
	//
	// Skipped when there is no RunID, so callers without a run in hand keep
	// exactly their previous behaviour rather than being given a fabricated one.
	if strings.TrimSpace(m.RunID) != "" {
		if _, err := tx.Exec(ctx, `
		INSERT INTO flow_step_metrics
			(tenant_id, run_id, flow_id, node_id, action_kind, applied, skipped, failed, error, occurred_at)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, NULLIF($9, ''), now())
	`, tenantID, m.RunID, m.AutomationID, m.NodeID, m.ActionKind, applied, skipped, failed, m.Error); err != nil {
			return fmt.Errorf("record per-run flow step metric: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// RecordABAssignment records a subscriber→variant bucketing (earliest-wins) and
// bumps the per-variant assigned counter only when the assignment is new.
func (s *PostgresStateStore) RecordABAssignment(ctx context.Context, a ABAssignment) error {
	tenantID := a.TenantID
	if tenantID == "" {
		var err error
		if tenantID, err = s.TenantOf(ctx, a.AutomationID); err != nil {
			return err
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var newID int64
	err = tx.QueryRow(ctx, `
		INSERT INTO flow_ab_test_assignments
			(tenant_id, automation_id, node_id, subscriber_email, variant_id)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5)
		ON CONFLICT (tenant_id, automation_id, node_id, subscriber_email) DO NOTHING
		RETURNING id`,
		tenantID, a.AutomationID, a.NodeID, a.SubscriberEmail, a.VariantID).Scan(&newID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Already assigned (earliest-wins) — do not double-count.
		return tx.Commit(ctx)
	}
	if err != nil {
		return fmt.Errorf("record ab assignment: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO flow_ab_test_results (tenant_id, automation_id, node_id, variant_id, assigned)
		VALUES ($1::uuid, $2::uuid, $3, $4, 1)
		ON CONFLICT (tenant_id, automation_id, node_id, variant_id)
		DO UPDATE SET assigned = flow_ab_test_results.assigned + 1, occurred_at = now()`,
		tenantID, a.AutomationID, a.NodeID, a.VariantID); err != nil {
		return fmt.Errorf("bump ab assigned: %w", err)
	}
	return tx.Commit(ctx)
}

// RecordABConversion stamps converted_at on the subscriber's un-converted A/B
// assignments for an automation and bumps each variant's converted counter.
func (s *PostgresStateStore) RecordABConversion(ctx context.Context, tenantID, automationID, subscriberEmail string) (int, error) {
	if tenantID == "" {
		var err error
		if tenantID, err = s.TenantOf(ctx, automationID); err != nil {
			return 0, err
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		UPDATE flow_ab_test_assignments
		   SET converted_at = now()
		 WHERE tenant_id = $1::uuid AND automation_id = $2::uuid
		   AND subscriber_email = $3 AND converted_at IS NULL
		RETURNING node_id, variant_id`,
		tenantID, automationID, subscriberEmail)
	if err != nil {
		return 0, err
	}
	type nv struct{ node, variant string }
	var converted []nv
	for rows.Next() {
		var v nv
		if err := rows.Scan(&v.node, &v.variant); err != nil {
			rows.Close()
			return 0, err
		}
		converted = append(converted, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, v := range converted {
		if _, err := tx.Exec(ctx, `
			UPDATE flow_ab_test_results SET converted = converted + 1, occurred_at = now()
			 WHERE tenant_id = $1::uuid AND automation_id = $2::uuid AND node_id = $3 AND variant_id = $4`,
			tenantID, automationID, v.node, v.variant); err != nil {
			return 0, err
		}
	}
	return len(converted), tx.Commit(ctx)
}

// ListStepMetrics returns the rolled-up per-node counters for one flow, oldest
// node id first. Only the engine's rolling rows (run_id IS NULL) are returned.
func (s *PostgresStateStore) ListStepMetrics(ctx context.Context, tenantID, automationID string) ([]StepMetricRow, error) {
	if tenantID == "" {
		var err error
		tenantID, err = s.TenantOf(ctx, automationID)
		if err != nil {
			return nil, err
		}
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT node_id, action_kind, applied, skipped, failed,
		       COALESCE(error, ''), occurred_at
		FROM flow_step_metrics
		WHERE tenant_id = $1::uuid AND flow_id = $2::uuid AND run_id IS NULL
		ORDER BY node_id, action_kind
	`, tenantID, automationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StepMetricRow{}
	for rows.Next() {
		var r StepMetricRow
		if err := rows.Scan(&r.NodeID, &r.ActionKind, &r.Applied, &r.Skipped, &r.Failed, &r.Error, &r.OccurredAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *PostgresStateStore) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nonNilMap(in map[string]interface{}) map[string]interface{} {
	if in == nil {
		return map[string]interface{}{}
	}
	return in
}

// runIDOrLegacy maps the empty run (pre-re-enrollment callers, and any code
// path that has not yet been threaded) onto the legacy run, so the row keeps
// the historical primary key that execID() also produces for it.
func runIDOrLegacy(runID string) string {
	if runID == "" {
		return LegacyRunID
	}
	return runID
}

// LatestRun returns the most recently started run for (automation, subscriber),
// or nil when the subscriber has never entered this flow. Engine.Trigger uses
// it to decide whether the re-enrollment policy permits a new run.
func (s *PostgresStateStore) LatestRun(ctx context.Context, automationID, email string) (*ExecutionState, error) {
	tenantID, err := s.TenantOf(ctx, automationID)
	if err != nil {
		return nil, err
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		runID     string
		current   *string
		completed []string
		startedAt time.Time
		lastAt    time.Time
		paused    bool
	)
	// The subscriber filter is load-bearing: without it this would return the
	// latest run of ANY subscriber in the flow, and one person's enrollment
	// would gate everybody else's.
	err = tx.QueryRow(ctx, `
		SELECT COALESCE(run_id, $4), current_node, completed_nodes, started_at, last_at, paused
		  FROM automation_executions
		 WHERE tenant_id = $1::uuid
		   AND automation_id = $2::uuid
		   AND subscriber_email = $3
		 ORDER BY started_at DESC
		 LIMIT 1
	`, tenantID, automationID, email, LegacyRunID).Scan(
		&runID, &current, &completed, &startedAt, &lastAt, &paused)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	st := &ExecutionState{
		TenantID:        tenantID,
		AutomationID:    automationID,
		SubscriberEmail: email,
		RunID:           runID,
		CompletedNodes:  map[string]time.Time{},
		StartedAt:       startedAt,
		LastAt:          lastAt,
		Paused:          paused,
	}
	if current != nil {
		st.CurrentNodeID = *current
	}
	for _, n := range completed {
		st.CompletedNodes[n] = lastAt
	}
	return st, tx.Commit(ctx)
}
