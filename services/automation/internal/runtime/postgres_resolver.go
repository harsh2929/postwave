package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// PostgresResolver resolves subscribers and automation graphs from the
// tenant-scoped Moosewave tables.
type PostgresResolver struct {
	Pool *pgxpool.Pool
}

func NewPostgresResolver(pool *pgxpool.Pool) (*PostgresResolver, error) {
	if pool == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &PostgresResolver{Pool: pool}, nil
}

func (r *PostgresResolver) Resolve(ctx context.Context, tenantID, email string) (canonical.Subscriber, error) {
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return canonical.Subscriber{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sub canonical.Subscriber
	var customRaw []byte
	var status, consent string
	err = tx.QueryRow(ctx, `
		SELECT email::text, COALESCE(phone_e164, ''), status, consent_timestamp, consent_source,
		       custom_fields, tags, COALESCE(source_id, ''), COALESCE(source_platform, '')
		  FROM subscribers
		 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
	`, tenantID, email).Scan(&sub.Email, &sub.Phone, &status, &sub.ConsentTimestamp,
		&consent, &customRaw, &sub.Tags, &sub.SourceID, &sub.SourcePlatform)
	if errors.Is(err, pgx.ErrNoRows) {
		return canonical.Subscriber{}, ErrSubscriberNotFound
	}
	if err != nil {
		return canonical.Subscriber{}, err
	}
	sub.Status = canonical.SubscriberStatus(status)
	sub.ConsentSource = canonical.ConsentSource(consent)
	sub.CustomFields = map[string]interface{}{}
	if len(customRaw) > 0 {
		_ = json.Unmarshal(customRaw, &sub.CustomFields)
	}
	if sub.Tags == nil {
		sub.Tags = []string{}
	}
	// Overlay Klaviyo-style predicted analytics onto custom fields so flow branch
	// conditions can trigger on them (custom.predicted_churn_risk gt 0.8). Best
	// effort — see hydratePredictionFields.
	hydratePredictionFields(ctx, tx, tenantID, sub.Email, sub.CustomFields)
	return sub, tx.Commit(ctx)
}

// hydratePredictionFields overlays predicted analytics (profile_predictions +
// profile_rfm_scores, keyed by tenant+email — the same scores segments use) onto
// the subscriber's custom fields, so automations branch / trigger on them via the
// existing custom.<name> condition machinery (no engine change needed).
//
// Best-effort by design: any error (a missing prediction row, table, or grant in
// this service's DB context) is swallowed and the fields are left absent — a
// predictive condition then evaluates false (the documented "unknown -> false
// leg"). It must NEVER break subscriber resolution, which every flow depends on.
func hydratePredictionFields(ctx context.Context, tx pgx.Tx, tenantID, email string, fields map[string]interface{}) {
	if email == "" || fields == nil {
		return
	}
	var (
		clv               *int
		churn, orderCount *float64
		nextOrderAt       *time.Time
		gender            *string
	)
	if err := tx.QueryRow(ctx, `
		SELECT predicted_clv_cents, churn_risk::float8, predicted_order_count::float8,
		       expected_next_order_at, predicted_gender::text
		  FROM profile_predictions
		 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
		 LIMIT 1`, tenantID, email).Scan(&clv, &churn, &orderCount, &nextOrderAt, &gender); err == nil {
		if clv != nil {
			fields["predicted_clv_cents"] = *clv
		}
		if churn != nil {
			fields["predicted_churn_risk"] = *churn
		}
		if orderCount != nil {
			fields["predicted_order_count"] = *orderCount
		}
		if nextOrderAt != nil {
			fields["predicted_next_order_at"] = nextOrderAt.UTC().Format(time.RFC3339)
		}
		if gender != nil && *gender != "" {
			fields["predicted_gender"] = *gender
		}
	}

	var (
		rfmSeg, rfmScore                  *string
		recency, frequency, monetaryScore *int
	)
	if err := tx.QueryRow(ctx, `
		SELECT segment_key::text, rfm_score::text, recency_score::int, frequency_score::int, monetary_score::int
		  FROM profile_rfm_scores
		 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
		 LIMIT 1`, tenantID, email).Scan(&rfmSeg, &rfmScore, &recency, &frequency, &monetaryScore); err == nil {
		if rfmSeg != nil && *rfmSeg != "" {
			fields["rfm_segment"] = *rfmSeg
		}
		if rfmScore != nil && *rfmScore != "" {
			fields["rfm_score"] = *rfmScore
		}
		if recency != nil {
			fields["rfm_recency"] = *recency
		}
		if frequency != nil {
			fields["rfm_frequency"] = *frequency
		}
		if monetaryScore != nil {
			fields["rfm_monetary"] = *monetaryScore
		}
	}
}

func (r *PostgresResolver) LookupAutomation(ctx context.Context, automationID string) (*canonical.Automation, error) {
	tenantID, ok := TenantFromContext(ctx)
	if !ok {
		return nil, errors.New("tenant id required")
	}
	return r.lookupAutomationForTenant(ctx, tenantID, automationID)
}

func (r *PostgresResolver) ListActiveByTenant(ctx context.Context, tenantID string) ([]*canonical.Automation, error) {
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
		     WHERE tenant_id = $1::uuid AND status = 'active'
		    UNION ALL
		    SELECT id, tenant_id, name, status, triggers, nodes, edges, updated_at,
		           re_enrollment, re_enrollment_cooldown_hours
		      FROM automation_journeys
		     WHERE tenant_id = $1::uuid AND status = 'active'
		  ) active_automations
		 ORDER BY updated_at DESC
	`, tenantID)
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
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *PostgresResolver) TenantOfAutomation(ctx context.Context, automationID string) (string, error) {
	tenantID, ok := TenantFromContext(ctx)
	if !ok {
		return "", errors.New("tenant id required")
	}
	if _, err := r.lookupAutomationForTenant(ctx, tenantID, automationID); err != nil {
		return "", err
	}
	return tenantID, nil
}

func (r *PostgresResolver) AppendBehavioralTrigger(ctx context.Context, automationID string, trigger canonical.AutomationTrigger) (canonical.AutomationTrigger, error) {
	tenantID, ok := TenantFromContext(ctx)
	if !ok {
		return canonical.AutomationTrigger{}, errors.New("tenant id required")
	}
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return canonical.AutomationTrigger{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	triggerJSON, err := json.Marshal([]canonical.AutomationTrigger{trigger})
	if err != nil {
		return canonical.AutomationTrigger{}, fmt.Errorf("encode trigger: %w", err)
	}
	cmd, err := tx.Exec(ctx, `
		UPDATE automations
		   SET triggers = triggers || $3::jsonb
		 WHERE tenant_id = $1::uuid AND id::text = $2
	`, tenantID, automationID, string(triggerJSON))
	if err != nil {
		return canonical.AutomationTrigger{}, err
	}
	if cmd.RowsAffected() == 0 {
		cmd, err = tx.Exec(ctx, `
			UPDATE automation_journeys
			   SET triggers = triggers || $3::jsonb,
			       version = version + 1
			 WHERE tenant_id = $1::uuid AND id::text = $2
		`, tenantID, automationID, string(triggerJSON))
		if err != nil {
			return canonical.AutomationTrigger{}, err
		}
		if cmd.RowsAffected() == 0 {
			return canonical.AutomationTrigger{}, ErrAutomationNotFound
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.AutomationTrigger{}, err
	}
	return trigger, nil
}

func (r *PostgresResolver) lookupAutomationForTenant(ctx context.Context, tenantID, automationID string) (*canonical.Automation, error) {
	tx, err := r.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, name, status, triggers, nodes, edges,
		       re_enrollment, re_enrollment_cooldown_hours
		  FROM automations
		 WHERE tenant_id = $1::uuid AND id::text = $2
	`, tenantID, automationID)
	a, err := scanAutomation(row)
	if errors.Is(err, pgx.ErrNoRows) {
		row = tx.QueryRow(ctx, `
			SELECT id::text, tenant_id::text, name, status, triggers, nodes, edges,
			       re_enrollment, re_enrollment_cooldown_hours
			  FROM automation_journeys
			 WHERE tenant_id = $1::uuid AND id::text = $2
		`, tenantID, automationID)
		a, err = scanAutomation(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAutomationNotFound
		}
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

type automationScanner interface {
	Scan(dest ...any) error
}

func scanAutomation(row automationScanner) (*canonical.Automation, error) {
	var a canonical.Automation
	var triggersRaw, nodesRaw, edgesRaw []byte
	// reEnrollment is load-bearing: without it every flow would resolve to the
	// zero-value policy and re-enrollment would be permanently unreachable —
	// a configurable surface wired to nothing.
	var reEnrollment string
	var cooldownHours int
	if err := row.Scan(&a.ID, &a.TenantID, &a.Name, &a.Status,
		&triggersRaw, &nodesRaw, &edgesRaw, &reEnrollment, &cooldownHours); err != nil {
		return nil, err
	}
	// 'once' is the DB default and canonical's zero value; map it to the zero
	// value so the engine's switch has a single representation to reason about.
	if reEnrollment != "once" {
		a.ReEnrollment = canonical.ReEnrollment(reEnrollment)
	}
	a.CooldownHours = cooldownHours
	if len(triggersRaw) > 0 {
		if err := json.Unmarshal(triggersRaw, &a.Triggers); err != nil {
			return nil, fmt.Errorf("decode triggers: %w", err)
		}
		for i, trigger := range a.Triggers {
			if trigger.Type == canonical.TriggerLifecycleStageChanged &&
				!canonical.ValidLifecycleTrigger(trigger) {
				return nil, fmt.Errorf("decode triggers: lifecycle trigger %d has a non-canonical stage", i)
			}
		}
	}
	if len(nodesRaw) > 0 {
		if err := json.Unmarshal(nodesRaw, &a.Nodes); err != nil {
			return nil, fmt.Errorf("decode nodes: %w", err)
		}
	}
	if len(edgesRaw) > 0 {
		if err := json.Unmarshal(edgesRaw, &a.Edges); err != nil {
			return nil, fmt.Errorf("decode edges: %w", err)
		}
	}
	if a.EntryID == "" && len(a.Nodes) > 0 {
		a.EntryID = a.Nodes[0].ID
	}
	if entry := firstExecutableNode(a); entry != "" {
		a.EntryID = entry
	}
	return &a, nil
}

func firstExecutableNode(a canonical.Automation) string {
	if a.EntryID != "" {
		if n := a.FindNode(a.EntryID); n != nil && n.Type != "trigger" {
			return a.EntryID
		}
		if next := a.NextNode(a.EntryID); next != "" {
			return next
		}
	}
	for _, n := range a.Nodes {
		if n.Type == "trigger" {
			if next := a.NextNode(n.ID); next != "" {
				return next
			}
			continue
		}
		return n.ID
	}
	return ""
}

func (r *PostgresResolver) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

var _ SubscriberResolver = (*PostgresResolver)(nil)
var _ AutomationLister = (*PostgresResolver)(nil)
