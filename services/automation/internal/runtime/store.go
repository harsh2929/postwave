package runtime

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ExecutionState tracks per-(automation,subscriber) progress through a graph.
type ExecutionState struct {
	TenantID        string `json:"tenant_id,omitempty"`
	AutomationID    string `json:"automation_id"`
	SubscriberEmail string `json:"subscriber_email"`
	// RunID scopes this state to ONE traversal of the flow. Without it the
	// execution row was keyed on (automation, subscriber) alone, so a
	// subscriber could enter any flow exactly once, ever, and CompletedNodes
	// accumulated forever. Each run carries its own row and therefore its own
	// clean CompletedNodes set.
	RunID          string               `json:"run_id,omitempty"`
	CurrentNodeID  string               `json:"current_node_id,omitempty"`
	CompletedNodes map[string]time.Time `json:"completed_nodes"`
	StartedAt      time.Time            `json:"started_at"`
	LastAt         time.Time            `json:"last_at"`
	Paused         bool                 `json:"paused"`
}

// LegacyRunID is the run assigned to execution rows that predate
// re-enrollment. execID() preserves the historical id for this run so
// journeys already in flight at deploy time are not orphaned.
const LegacyRunID = "legacy"

// JourneyEvent is an append-only audit/event record for automation execution
// state. It is intentionally compact: detailed node payloads stay in Payload,
// while top-level fields make the common timeline queries cheap.
type JourneyEvent struct {
	TenantID        string                 `json:"tenant_id"`
	AutomationID    string                 `json:"automation_id"`
	SubscriberEmail string                 `json:"subscriber_email,omitempty"`
	EventType       string                 `json:"event_type"`
	NodeID          string                 `json:"node_id,omitempty"`
	Status          string                 `json:"status,omitempty"`
	Message         string                 `json:"message,omitempty"`
	Payload         map[string]interface{} `json:"payload,omitempty"`
	At              time.Time              `json:"at"`
}

// StepMetric is one node-execution outcome the engine reports to the flow
// inspector. The store rolls these up per (tenant, flow, node, action_kind) so
// the table stays thin regardless of subscriber volume — see
// infra/migrations/0277_flow_step_metrics.sql + 1627_flow_step_metrics_rollup_unique.sql.
type StepMetric struct {
	TenantID     string
	AutomationID string // flow_id
	NodeID       string
	// ActionKind is the granular kind: action nodes report their
	// Action.Kind (add_tag / remove_tag / …); every other node type reports
	// its node Type (wait / branch / send_email / webhook / …).
	ActionKind string
	// Outcome is "applied" (ran to completion), "skipped" (declined), or
	// "failed" (errored).
	Outcome string
	// RunID scopes this metric to ONE traversal of the flow, and is what makes a
	// per-node inspector possible: without it the table can only say how a node
	// has behaved in aggregate, never what happened on the run somebody is
	// looking at.
	//
	// Optional. Empty writes the rollup alone, exactly as before — the paths that
	// have no run in hand keep their old behaviour rather than being forced to
	// invent an identifier.
	RunID string
	// Error is the failure message; populated only when Outcome == "failed".
	Error string
}

// StepMetricRow is the rolled-up per-node counter the flow inspector reads back.
type StepMetricRow struct {
	NodeID     string    `json:"node_id"`
	ActionKind string    `json:"action_kind"`
	Applied    int       `json:"applied"`
	Skipped    int       `json:"skipped"`
	Failed     int       `json:"failed"`
	Error      string    `json:"error,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// StateStore persists execution state for idempotency + resume after restart.
type StateStore interface {
	Get(ctx context.Context, automationID, subscriberEmail, runID string) (*ExecutionState, error)
	Upsert(ctx context.Context, st *ExecutionState) error
	// LatestRun returns the most recently started run for (automation,
	// subscriber), or nil when the subscriber has never entered the flow.
	// Engine.Trigger consults it to apply the flow's re-enrollment policy.
	LatestRun(ctx context.Context, automationID, subscriberEmail string) (*ExecutionState, error)
	// MarkCompleted records that nodeID finished for (automation, subscriber,
	// run). Used by Engine.Execute to make replays no-ops WITHIN a run —
	// crucially not across runs, or re-enrollment would short-circuit exactly
	// as the original fire-once bug did.
	MarkCompleted(ctx context.Context, automationID, subscriberEmail, nodeID, runID string) error
	// SetPaused toggles the paused flag for an entire automation. The engine
	// checks this before executing each node.
	SetPaused(ctx context.Context, automationID string, paused bool) error
	IsPaused(ctx context.Context, automationID string) (bool, error)
	// ListActive returns active executions for a tenant (handler endpoint).
	ListActive(ctx context.Context, tenantID string) ([]ExecutionState, error)
	RecordEvent(ctx context.Context, ev JourneyEvent) error
	ListEvents(ctx context.Context, tenantID, automationID string, limit int) ([]JourneyEvent, error)
	// RecordStepMetric rolls one node-execution outcome into the per-node
	// counter for the flow inspector. Best-effort from the engine's
	// perspective: a failure here must never affect flow execution.
	RecordStepMetric(ctx context.Context, m StepMetric) error
	// ListStepMetrics returns the rolled-up per-node counters for one flow.
	ListStepMetrics(ctx context.Context, tenantID, automationID string) ([]StepMetricRow, error)
	// RecordABAssignment records that a subscriber was bucketed into one A/B
	// variant at an ab_test node (idempotent, earliest-wins) and bumps the
	// per-variant `assigned` counter when the assignment is new. Best-effort.
	RecordABAssignment(ctx context.Context, a ABAssignment) error
	// RecordABConversion stamps converted_at on the subscriber's un-converted
	// A/B assignments for an automation and bumps each variant's `converted`
	// counter. Called when a goal is met. Best-effort; returns count stamped.
	RecordABConversion(ctx context.Context, tenantID, automationID, subscriberEmail string) (int, error)
}

// ABAssignment is one subscriber→variant bucketing at an ab_test node.
type ABAssignment struct {
	TenantID        string
	AutomationID    string
	NodeID          string
	SubscriberEmail string
	VariantID       string
}

// MemoryStore is an in-memory StateStore, used by tests + before the
// PostgresStore lands.
type MemoryStore struct {
	mu     sync.RWMutex
	states map[string]*ExecutionState // key = automationID + "|" + subscriberEmail
	paused map[string]bool            // key = automationID
	tenant map[string]string          // automationID -> tenantID for ListActive
	events map[string][]JourneyEvent  // key = tenantID + "|" + automationID
	// stepMetrics rolls per-node counters up exactly like the Postgres store,
	// keyed by tenantID|automationID|nodeID|actionKind.
	stepMetrics map[string]*memStepMetric
	// A/B test state, mirroring flow_ab_test_assignments + flow_ab_test_results.
	abAssign  map[string]*memABAssign // tenant|automation|node|subscriber -> assignment
	abResults map[string]*memABResult // tenant|automation|node|variant -> counters
}

type memABAssign struct {
	variantID string
	converted bool
}
type memABResult struct {
	tenantID, automationID, nodeID, variantID string
	assigned, converted                       int
}

// memStepMetric is one rolled-up node counter plus the tenant/flow keys needed
// to filter it back out in ListStepMetrics.
type memStepMetric struct {
	tenantID     string
	automationID string
	row          StepMetricRow
}

// NewMemoryStore constructs an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		states:      map[string]*ExecutionState{},
		paused:      map[string]bool{},
		tenant:      map[string]string{},
		events:      map[string][]JourneyEvent{},
		stepMetrics: map[string]*memStepMetric{},
		abAssign:    map[string]*memABAssign{},
		abResults:   map[string]*memABResult{},
	}
}

// memKey is run-scoped: one entry per (automation, subscriber, RUN), so a
// new run starts with an empty CompletedNodes set.
func memKey(a, e, run string) string { return a + "|" + e + "|" + run }

// RegisterTenant binds an automation id to a tenant id (used by ListActive).
// In production this comes from the Postgres automations table.
func (m *MemoryStore) RegisterTenant(automationID, tenantID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tenant[automationID] = tenantID
}

func (m *MemoryStore) Get(ctx context.Context, automationID, email, runID string) (*ExecutionState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	st, ok := m.states[memKey(automationID, email, runID)]
	if !ok {
		return nil, nil
	}
	cp := *st
	cp.CompletedNodes = copyMap(st.CompletedNodes)
	return &cp, nil
}

func (m *MemoryStore) Upsert(ctx context.Context, st *ExecutionState) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := memKey(st.AutomationID, st.SubscriberEmail, st.RunID)
	existing := m.states[key]
	cp := *st
	if existing != nil {
		if cp.CompletedNodes == nil {
			cp.CompletedNodes = copyMap(existing.CompletedNodes)
		} else {
			for nodeID, at := range existing.CompletedNodes {
				if _, ok := cp.CompletedNodes[nodeID]; !ok {
					cp.CompletedNodes[nodeID] = at
				}
			}
		}
	}
	if cp.CompletedNodes == nil {
		cp.CompletedNodes = map[string]time.Time{}
	}
	cp.LastAt = time.Now().UTC()
	if cp.StartedAt.IsZero() {
		if existing != nil && !existing.StartedAt.IsZero() {
			cp.StartedAt = existing.StartedAt
		} else {
			cp.StartedAt = cp.LastAt
		}
	}
	if cp.TenantID == "" && existing != nil {
		cp.TenantID = existing.TenantID
	}
	if cp.TenantID != "" {
		m.tenant[cp.AutomationID] = cp.TenantID
	}
	m.states[key] = &cp
	return nil
}

// LatestRun returns the most recently started run for (automation, subscriber).
func (m *MemoryStore) LatestRun(ctx context.Context, automationID, email string) (*ExecutionState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var latest *ExecutionState
	for _, st := range m.states {
		if st.AutomationID != automationID || st.SubscriberEmail != email {
			continue
		}
		if latest == nil || st.StartedAt.After(latest.StartedAt) {
			latest = st
		}
	}
	if latest == nil {
		return nil, nil
	}
	cp := *latest
	cp.CompletedNodes = copyMap(latest.CompletedNodes)
	return &cp, nil
}

func (m *MemoryStore) MarkCompleted(ctx context.Context, automationID, email, nodeID, runID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.states[memKey(automationID, email, runID)]
	if !ok {
		st = &ExecutionState{
			AutomationID:    automationID,
			SubscriberEmail: email,
			RunID:           runID,
			StartedAt:       time.Now().UTC(),
			CompletedNodes:  map[string]time.Time{},
		}
		m.states[memKey(automationID, email, runID)] = st
	}
	if st.CompletedNodes == nil {
		st.CompletedNodes = map[string]time.Time{}
	}
	st.CompletedNodes[nodeID] = time.Now().UTC()
	st.LastAt = time.Now().UTC()
	return nil
}

func (m *MemoryStore) SetPaused(ctx context.Context, automationID string, paused bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.paused[automationID] = paused
	return nil
}

func (m *MemoryStore) IsPaused(ctx context.Context, automationID string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.paused[automationID], nil
}

func (m *MemoryStore) ListActive(ctx context.Context, tenantID string) ([]ExecutionState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []ExecutionState
	for _, st := range m.states {
		if st.TenantID == tenantID || m.tenant[st.AutomationID] == tenantID {
			cp := *st
			cp.CompletedNodes = copyMap(st.CompletedNodes)
			out = append(out, cp)
		}
	}
	return out, nil
}

func (m *MemoryStore) RecordEvent(ctx context.Context, ev JourneyEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	if ev.TenantID != "" {
		m.tenant[ev.AutomationID] = ev.TenantID
	}
	key := ev.TenantID + "|" + ev.AutomationID
	cp := ev
	if ev.Payload != nil {
		cp.Payload = make(map[string]interface{}, len(ev.Payload))
		for k, v := range ev.Payload {
			cp.Payload[k] = v
		}
	}
	m.events[key] = append(m.events[key], cp)
	return nil
}

func (m *MemoryStore) ListEvents(ctx context.Context, tenantID, automationID string, limit int) ([]JourneyEvent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	rows := m.events[tenantID+"|"+automationID]
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	start := 0
	if len(rows) > limit {
		start = len(rows) - limit
	}
	out := make([]JourneyEvent, 0, len(rows)-start)
	for i := len(rows) - 1; i >= start; i-- {
		cp := rows[i]
		if cp.Payload != nil {
			payload := make(map[string]interface{}, len(cp.Payload))
			for k, v := range cp.Payload {
				payload[k] = v
			}
			cp.Payload = payload
		}
		out = append(out, cp)
	}
	return out, nil
}

func (m *MemoryStore) RecordStepMetric(ctx context.Context, sm StepMetric) error {
	if sm.AutomationID == "" || sm.NodeID == "" || sm.ActionKind == "" {
		return fmt.Errorf("step metric missing automation/node/action_kind")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := sm.TenantID + "|" + sm.AutomationID + "|" + sm.NodeID + "|" + sm.ActionKind
	entry := m.stepMetrics[key]
	if entry == nil {
		entry = &memStepMetric{
			tenantID:     sm.TenantID,
			automationID: sm.AutomationID,
			row:          StepMetricRow{NodeID: sm.NodeID, ActionKind: sm.ActionKind},
		}
		m.stepMetrics[key] = entry
	}
	switch sm.Outcome {
	case "applied":
		entry.row.Applied++
	case "skipped":
		entry.row.Skipped++
	case "failed":
		entry.row.Failed++
		if sm.Error != "" {
			entry.row.Error = sm.Error
		}
	default:
		return fmt.Errorf("unknown step metric outcome %q", sm.Outcome)
	}
	entry.row.OccurredAt = time.Now().UTC()
	return nil
}

func (m *MemoryStore) ListStepMetrics(ctx context.Context, tenantID, automationID string) ([]StepMetricRow, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []StepMetricRow{}
	for _, entry := range m.stepMetrics {
		if entry.tenantID == tenantID && entry.automationID == automationID {
			out = append(out, entry.row)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].NodeID != out[j].NodeID {
			return out[i].NodeID < out[j].NodeID
		}
		return out[i].ActionKind < out[j].ActionKind
	})
	return out, nil
}

func (m *MemoryStore) RecordABAssignment(ctx context.Context, a ABAssignment) error {
	if a.AutomationID == "" || a.NodeID == "" || a.SubscriberEmail == "" || a.VariantID == "" {
		return fmt.Errorf("ab assignment missing keys")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	aKey := a.TenantID + "|" + a.AutomationID + "|" + a.NodeID + "|" + a.SubscriberEmail
	if _, exists := m.abAssign[aKey]; exists {
		return nil // earliest-wins: already assigned
	}
	m.abAssign[aKey] = &memABAssign{variantID: a.VariantID}
	rKey := a.TenantID + "|" + a.AutomationID + "|" + a.NodeID + "|" + a.VariantID
	res := m.abResults[rKey]
	if res == nil {
		res = &memABResult{tenantID: a.TenantID, automationID: a.AutomationID, nodeID: a.NodeID, variantID: a.VariantID}
		m.abResults[rKey] = res
	}
	res.assigned++
	return nil
}

func (m *MemoryStore) RecordABConversion(ctx context.Context, tenantID, automationID, subscriberEmail string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prefix := tenantID + "|" + automationID + "|"
	suffix := "|" + subscriberEmail
	n := 0
	for k, asn := range m.abAssign {
		if asn.converted || !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, suffix) {
			continue
		}
		// k = tenant|automation|node|subscriber → recover node.
		nodeID := strings.TrimSuffix(strings.TrimPrefix(k, prefix), suffix)
		asn.converted = true
		if res := m.abResults[tenantID+"|"+automationID+"|"+nodeID+"|"+asn.variantID]; res != nil {
			res.converted++
			n++
		}
	}
	return n, nil
}

func copyMap(m map[string]time.Time) map[string]time.Time {
	if m == nil {
		return nil
	}
	out := make(map[string]time.Time, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
