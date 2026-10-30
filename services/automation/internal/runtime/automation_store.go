package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// AutomationStore is the read/write surface behind GET/POST /v1/automations
// and PATCH /v1/automations/{id}.
//
// Until this existed the service could execute automations and could not be
// asked for them: the SDK shipped list/create/update, the MCP tool called all
// three, and each 404'd at the upstream because no route -- and no store --
// answered. ValidateEveryNDays' own doc comment says "the automation create
// endpoint should call this before persisting"; the endpoint it was written
// for is this one.
type AutomationStore interface {
	// ListByTenant returns every automation the tenant owns, across BOTH
	// tables, newest first. status filters when non-empty. This is not the
	// runtime's ListActiveByTenant: an agent that creates a draft and then
	// cannot list it has been told its work vanished.
	ListByTenant(ctx context.Context, tenantID, status string) ([]*canonical.Automation, error)
	// Create validates the graph and persists it as a draft.
	Create(ctx context.Context, tenantID string, draft canonical.Automation) (*canonical.Automation, error)
	// Update applies a partial patch, validates the MERGED graph, and persists
	// it to whichever table holds the row. ErrAutomationNotFound when neither.
	Update(ctx context.Context, tenantID, automationID string, patch AutomationPatch) (*canonical.Automation, error)
}

// AutomationPatch is a partial update. nil means "leave it alone"; a pointer to
// an empty slice means "clear it", which validation will then reject for
// triggers and nodes because a graph needs both.
type AutomationPatch struct {
	Name     *string
	Status   *string
	Triggers *[]canonical.AutomationTrigger
	Nodes    *[]canonical.AutomationNode
	Edges    *[]canonical.AutomationEdge
}

// AutomationStatuses is the status vocabulary the public API accepts. The
// column has no CHECK constraint, so this is the only gate.
var AutomationStatuses = []string{"draft", "active", "paused"}

// ErrInvalidAutomation wraps every validation failure so a handler can map the
// whole class to 400 without matching on message text.
var ErrInvalidAutomation = errors.New("runtime: invalid automation")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidAutomation, fmt.Sprintf(format, args...))
}

// ValidateAutomationGraph rejects a graph the engine could not run.
//
// Every rule here corresponds to a failure that would otherwise surface LATER
// and WORSE: a missing entry node errors at trigger time ("automation has no
// entry node"), a dangling edge walks into nothing, a malformed lifecycle
// trigger makes the row unreadable (scanAutomation refuses it), and an
// every_n_days trigger without a time never fires. Failing at create is the
// only point where the caller is still around to hear about it.
func ValidateAutomationGraph(a *canonical.Automation) error {
	if a == nil {
		return invalid("nil automation")
	}
	if strings.TrimSpace(a.Name) == "" {
		return invalid("name is required")
	}
	if a.Status == "" {
		a.Status = "draft"
	}
	if !validStatus(a.Status) {
		return invalid("status must be one of %s, got %q", strings.Join(AutomationStatuses, "|"), a.Status)
	}
	if len(a.Triggers) == 0 {
		return invalid("at least one trigger is required")
	}
	for i, t := range a.Triggers {
		if strings.TrimSpace(t.Type) == "" {
			return invalid("triggers[%d]: type is required", i)
		}
		switch t.Type {
		case canonical.TriggerDateField:
			if err := canonical.ValidateDateField(t); err != nil {
				return invalid("triggers[%d]: %v", i, err)
			}
		case canonical.TriggerKindEveryNDays:
			if err := canonical.ValidateEveryNDays(t); err != nil {
				return invalid("triggers[%d]: %v", i, err)
			}
		case canonical.TriggerLifecycleStageChanged:
			if !canonical.ValidLifecycleTrigger(t) {
				return invalid("triggers[%d]: lifecycle trigger has a non-canonical stage", i)
			}
		}
	}
	if len(a.Nodes) == 0 {
		return invalid("at least one node is required")
	}
	ids := make(map[string]struct{}, len(a.Nodes))
	for i, n := range a.Nodes {
		if strings.TrimSpace(n.ID) == "" {
			return invalid("nodes[%d]: id is required", i)
		}
		if strings.TrimSpace(n.Type) == "" {
			return invalid("nodes[%d] (%s): type is required", i, n.ID)
		}
		if _, dup := ids[n.ID]; dup {
			return invalid("nodes[%d]: duplicate id %q", i, n.ID)
		}
		ids[n.ID] = struct{}{}
	}
	for i, n := range a.Nodes {
		for label, ref := range map[string]*string{"true_next": n.TrueNext, "false_next": n.FalseNext} {
			if ref != nil && *ref != "" {
				if _, ok := ids[*ref]; !ok {
					return invalid("nodes[%d] (%s): %s references unknown node %q", i, n.ID, label, *ref)
				}
			}
		}
	}
	for i, e := range a.Edges {
		if _, ok := ids[e.From]; !ok {
			return invalid("edges[%d]: from references unknown node %q", i, e.From)
		}
		if _, ok := ids[e.To]; !ok {
			return invalid("edges[%d]: to references unknown node %q", i, e.To)
		}
	}
	if firstExecutableNode(*a) == "" {
		return invalid("graph has no executable entry node (every node is a trigger with no successor)")
	}
	return nil
}

func validStatus(s string) bool {
	for _, v := range AutomationStatuses {
		if v == s {
			return true
		}
	}
	return false
}

func applyPatch(cur *canonical.Automation, p AutomationPatch) {
	if p.Name != nil {
		cur.Name = *p.Name
	}
	if p.Status != nil {
		cur.Status = *p.Status
	}
	if p.Triggers != nil {
		cur.Triggers = *p.Triggers
	}
	if p.Nodes != nil {
		cur.Nodes = *p.Nodes
	}
	if p.Edges != nil {
		cur.Edges = *p.Edges
	}
	// EntryID is derived from the graph on read; a patched graph must not keep
	// a stale one pointing at a node that no longer exists.
	cur.EntryID = ""
}

// reEnrollmentColumn maps canonical's zero value back to the column's 'once'.
func reEnrollmentColumn(r canonical.ReEnrollment) string {
	if r == "" {
		return "once"
	}
	return string(r)
}

func encodeGraph(a *canonical.Automation) (triggers, nodes, edges string, err error) {
	if a.Triggers == nil {
		a.Triggers = []canonical.AutomationTrigger{}
	}
	if a.Nodes == nil {
		a.Nodes = []canonical.AutomationNode{}
	}
	if a.Edges == nil {
		a.Edges = []canonical.AutomationEdge{}
	}
	t, err := json.Marshal(a.Triggers)
	if err != nil {
		return "", "", "", fmt.Errorf("encode triggers: %w", err)
	}
	n, err := json.Marshal(a.Nodes)
	if err != nil {
		return "", "", "", fmt.Errorf("encode nodes: %w", err)
	}
	e, err := json.Marshal(a.Edges)
	if err != nil {
		return "", "", "", fmt.Errorf("encode edges: %w", err)
	}
	return string(t), string(n), string(e), nil
}

// ── Postgres ────────────────────────────────────────────────────────────────

// ListByTenant reads both tables, so the flows the web builder writes to
// automation_journeys appear beside the ones created through this API.
func (r *PostgresResolver) ListByTenant(ctx context.Context, tenantID, status string) ([]*canonical.Automation, error) {
	if status != "" && !validStatus(status) {
		return nil, invalid("status must be one of %s, got %q", strings.Join(AutomationStatuses, "|"), status)
	}
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, name, status, triggers, nodes, edges,
		       re_enrollment, re_enrollment_cooldown_hours
		  FROM (
		    SELECT id, tenant_id, name, status, triggers, nodes, edges, updated_at,
		           re_enrollment, re_enrollment_cooldown_hours
		      FROM automations
		     WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
		    UNION ALL
		    SELECT id, tenant_id, name, status, triggers, nodes, edges, updated_at,
		           re_enrollment, re_enrollment_cooldown_hours
		      FROM automation_journeys
		     WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
		  ) all_automations
		 ORDER BY updated_at DESC
	`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*canonical.Automation{}
	for rows.Next() {
		a, err := scanAutomation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// Create persists a validated draft and reads it back through the same scan
// the runtime uses, so what the caller sees is what the engine will run.
func (r *PostgresResolver) Create(ctx context.Context, tenantID string, draft canonical.Automation) (*canonical.Automation, error) {
	draft.TenantID = tenantID
	if draft.Status == "" {
		draft.Status = "draft"
	}
	if err := ValidateAutomationGraph(&draft); err != nil {
		return nil, err
	}
	triggers, nodes, edges, err := encodeGraph(&draft)
	if err != nil {
		return nil, err
	}
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
		INSERT INTO automations
			(tenant_id, name, status, triggers, nodes, edges, re_enrollment, re_enrollment_cooldown_hours)
		VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
		RETURNING id::text
	`, tenantID, strings.TrimSpace(draft.Name), draft.Status, triggers, nodes, edges,
		reEnrollmentColumn(draft.ReEnrollment), draft.CooldownHours).Scan(&id); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.lookupAutomationForTenant(ctx, tenantID, id)
}

// Update merges the patch onto the stored row, validates the RESULT, and
// writes it back to whichever table owns the id -- automations first, then
// automation_journeys, mirroring AppendBehavioralTrigger's two-table rule.
func (r *PostgresResolver) Update(ctx context.Context, tenantID, automationID string, patch AutomationPatch) (*canonical.Automation, error) {
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const sel = `SELECT id::text, tenant_id::text, name, status, triggers, nodes, edges,
	                    re_enrollment, re_enrollment_cooldown_hours
	               FROM %s WHERE tenant_id = $1::uuid AND id::text = $2 FOR UPDATE`
	table := "automations"
	cur, err := scanAutomation(tx.QueryRow(ctx, fmt.Sprintf(sel, table), tenantID, automationID))
	if errors.Is(err, pgx.ErrNoRows) {
		table = "automation_journeys"
		cur, err = scanAutomation(tx.QueryRow(ctx, fmt.Sprintf(sel, table), tenantID, automationID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAutomationNotFound
		}
	}
	if err != nil {
		return nil, err
	}

	applyPatch(cur, patch)
	if err := ValidateAutomationGraph(cur); err != nil {
		return nil, err
	}
	triggers, nodes, edges, err := encodeGraph(cur)
	if err != nil {
		return nil, err
	}
	versionBump := ""
	if table == "automation_journeys" {
		versionBump = ", version = version + 1"
	}
	cmd, err := tx.Exec(ctx, fmt.Sprintf(`
		UPDATE %s
		   SET name = $3, status = $4, triggers = $5::jsonb, nodes = $6::jsonb, edges = $7::jsonb,
		       updated_at = now()%s
		 WHERE tenant_id = $1::uuid AND id::text = $2
	`, table, versionBump), tenantID, automationID, strings.TrimSpace(cur.Name), cur.Status, triggers, nodes, edges)
	if err != nil {
		return nil, err
	}
	if cmd.RowsAffected() == 0 {
		return nil, ErrAutomationNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.lookupAutomationForTenant(ctx, tenantID, automationID)
}

var _ AutomationStore = (*PostgresResolver)(nil)

// ── In-memory (tests + the local dev loop) ──────────────────────────────────

func (r *MemoryResolver) ListByTenant(_ context.Context, tenantID, status string) ([]*canonical.Automation, error) {
	if status != "" && !validStatus(status) {
		return nil, invalid("status must be one of %s, got %q", strings.Join(AutomationStatuses, "|"), status)
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := []*canonical.Automation{}
	for _, a := range r.automations {
		if a.TenantID == tenantID && (status == "" || a.Status == status) {
			out = append(out, a)
		}
	}
	return out, nil
}

func (r *MemoryResolver) Create(_ context.Context, tenantID string, draft canonical.Automation) (*canonical.Automation, error) {
	draft.TenantID = tenantID
	if draft.Status == "" {
		draft.Status = "draft"
	}
	if err := ValidateAutomationGraph(&draft); err != nil {
		return nil, err
	}
	draft.ID = uuid.NewString()
	draft.Name = strings.TrimSpace(draft.Name)
	a := draft
	r.mu.Lock()
	r.automations[a.ID] = &a
	r.mu.Unlock()
	return &a, nil
}

func (r *MemoryResolver) Update(_ context.Context, tenantID, automationID string, patch AutomationPatch) (*canonical.Automation, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur, ok := r.automations[automationID]
	if !ok || cur.TenantID != tenantID {
		return nil, ErrAutomationNotFound
	}
	next := *cur
	applyPatch(&next, patch)
	if err := ValidateAutomationGraph(&next); err != nil {
		return nil, err
	}
	next.Name = strings.TrimSpace(next.Name)
	r.automations[automationID] = &next
	return &next, nil
}

var _ AutomationStore = (*MemoryResolver)(nil)
