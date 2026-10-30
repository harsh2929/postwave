// SPDX-License-Identifier: AGPL-3.0-only

package sar

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// This is deliberately a real-Postgres contract test. The source-level tests
// lock the intended tables/columns, while this test makes PostgreSQL plan and
// execute every query against the fully migrated schema so a renamed or
// removed column cannot be merged as a silently empty disclosure section.
func TestAutomationSARQueriesMatchMigratedDatabase(t *testing.T) {
	pool := erasureTestPool(t)
	tenantID, email := seedSubject(t, pool)
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subscriberID, automationID, journeyID, campaignID, flowRunID, triggerID string
	if err := tx.QueryRow(ctx, `
SELECT id::text
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, tenantID, email).Scan(&subscriberID); err != nil {
		t.Fatalf("resolve seeded subscriber: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&automationID); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_journeys (tenant_id, name)
VALUES ($1::uuid, 'SAR contract journey')
RETURNING id::text`, tenantID).Scan(&journeyID); err != nil {
		t.Fatalf("seed journey: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject)
VALUES ($1::uuid, 'SAR contract campaign', 'SAR contract')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}

	seedStatements := []struct {
		name string
		sql  string
		args []any
	}{
		{
			name: "automation execution",
			sql: `INSERT INTO automation_executions
  (id, tenant_id, automation_id, subscriber_email, current_node, run_id, error)
VALUES ($1, $2::uuid, $3::uuid, $4::citext, 'node-1', 'sar-run', 'must-not-export')`,
			args: []any{"sar-contract-" + tenantID, tenantID, automationID, email},
		},
		{
			name: "second automation execution",
			sql: `INSERT INTO automation_executions
  (id, tenant_id, automation_id, subscriber_email, current_node, run_id, error)
VALUES ($1, $2::uuid, $3::uuid, $4::citext, 'node-2', 'sar-run-2', 'must-not-export')`,
			args: []any{"sar-contract-2-" + tenantID, tenantID, automationID, email},
		},
		{
			name: "journey execution",
			sql: `INSERT INTO automation_journey_executions
  (id, tenant_id, journey_id, subscriber_email, current_node_id, payload, error)
VALUES ($1, $2::uuid, $3::uuid, $4::citext, 'node-1',
        '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb,
        'must-not-export')`,
			args: []any{"sar-journey-" + tenantID, tenantID, journeyID, email},
		},
		{
			name: "journey event",
			sql: `INSERT INTO automation_journey_events
	  (tenant_id, automation_id, subscriber_email, event_type, node_id, message, payload)
	VALUES ($1::uuid, $2::uuid, $3::citext, 'entered', 'node-1',
	        'other.person@example.test',
	        '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb)`,
			args: []any{tenantID, automationID, email},
		},
		{
			name: "flow activity",
			sql: `INSERT INTO automation_flow_activity
  (tenant_id, automation_id, journey_id, node_id, subscriber_email, event_type, payload)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'node-1', $4::citext, 'entered',
        '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb)`,
			args: []any{tenantID, automationID, journeyID, email},
		},
		{
			name: "A/B assignment",
			sql: `INSERT INTO flow_ab_test_assignments
  (tenant_id, automation_id, node_id, subscriber_email, variant_id)
VALUES ($1::uuid, $2::uuid, 'node-1', $3::citext, 'variant-a')`,
			args: []any{tenantID, automationID, email},
		},
		{
			name: "trigger delay preference",
			sql: `INSERT INTO trigger_delay_preferences
  (tenant_id, subscriber_id, event_name, optimal_delay_seconds, reason)
VALUES ($1::uuid, $2::uuid, 'purchase.completed', 120, 'other.person@example.test')`,
			args: []any{tenantID, subscriberID},
		},
		{
			name: "activation exclusion receipt",
			sql: `INSERT INTO activation_exclusion_receipts
  (tenant_id, run_id, run_type, subscriber_email, rule_class, rule_reason,
   purpose, destination_type, signature)
VALUES ($1::uuid, 'sar-contract', 'zerocopy_trigger', $2, 'consent',
	        'other.person@example.test', 'email_marketing', 'zerocopy', 'must-not-export')`,
			args: []any{tenantID, email},
		},
		{
			name: "sequence enrollment",
			sql: `INSERT INTO sequence_enrollments
  (tenant_id, sequence_id, subscriber_email)
VALUES ($1::uuid, $2::uuid, $3::citext)`,
			args: []any{tenantID, journeyID, email},
		},
		{
			name: "sequence funnel event",
			sql: `INSERT INTO sequence_funnel_events
  (tenant_id, sequence_id, subscriber_email, position, step_id, variant_key)
VALUES ($1::uuid, $2::uuid, $3::citext, 0, 'p0', 'variant-a')`,
			args: []any{tenantID, journeyID, email},
		},
		{
			name: "subscriber send log",
			sql: `INSERT INTO subscriber_send_log
  (tenant_id, subscriber_email, campaign_id, channel)
VALUES ($1::uuid, $2::citext, $3::uuid, 'email')`,
			args: []any{tenantID, email, campaignID},
		},
		{
			name: "intelligent retry event",
			sql: `INSERT INTO intelligent_retry_events
  (tenant_id, campaign_id, subscriber_email, reason, breakdown)
VALUES ($1::uuid, $2::uuid, $3::citext, 'other.person@example.test',
       '[{"email":"other.person@example.test","secret":"sk_other_secret"}]'::jsonb)`,
			args: []any{tenantID, campaignID, email},
		},
	}
	for _, seed := range seedStatements {
		if _, err := tx.Exec(ctx, seed.sql, seed.args...); err != nil {
			t.Fatalf("seed %s: %v", seed.name, err)
		}
	}

	if err := tx.QueryRow(ctx, `
INSERT INTO flow_runs
  (tenant_id, flow_id, subscriber_id, trigger_event_name, trigger_payload, error)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'sar.contract',
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb,
       'must-not-export')
RETURNING id::text`, tenantID, journeyID, subscriberID).Scan(&flowRunID); err != nil {
		t.Fatalf("seed flow run: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO external_warehouse_triggers (tenant_id, journey_id, name, query, config)
VALUES ($1::uuid, $2::uuid, 'SAR contract trigger', 'SELECT secret_query', '{"secret":true}'::jsonb)
RETURNING id::text`, tenantID, journeyID).Scan(&triggerID); err != nil {
		t.Fatalf("seed external trigger: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO external_warehouse_trigger_fires
  (tenant_id, trigger_id, flow_run_id, cursor_value, profile_key, subscriber_id, payload, error)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'sk_other_secret', 'other.person@example.test', $4::uuid,
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb,
       'must-not-export')`,
		tenantID, triggerID, flowRunID, subscriberID); err != nil {
		t.Fatalf("seed trigger fire: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO external_warehouse_trigger_dlq
  (tenant_id, trigger_id, cursor_value, profile_key, payload, reason, last_error)
VALUES ($1::uuid, $2::uuid, 'sk_other_secret', $3,
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb,
       'enqueue_failed', 'must-not-export')`,
		tenantID, triggerID, email); err != nil {
		t.Fatalf("seed trigger DLQ: %v", err)
	}

	var omniCampaignID, omniRecipientID string
	if err := tx.QueryRow(ctx, `
INSERT INTO omni_campaigns (tenant_id, name)
VALUES ($1::uuid, 'SAR contract campaign')
RETURNING id::text`, tenantID).Scan(&omniCampaignID); err != nil {
		t.Fatalf("seed omni campaign: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO omni_recipients
  (tenant_id, campaign_id, subscriber_id, email, push_token, channel, suppressed_reason, metadata)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::citext, 'must-not-export', 'email',
       'other.person@example.test',
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb)
RETURNING id::text`, tenantID, omniCampaignID, subscriberID, email).Scan(&omniRecipientID); err != nil {
		t.Fatalf("seed omni recipient: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO channel_send_history
  (tenant_id, campaign_id, recipient_id, subscriber_id, email, push_token, channel, suppressed_reason, metadata)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::citext, 'must-not-export', 'email',
       'other.person@example.test',
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb)`,
		tenantID, omniCampaignID, omniRecipientID, subscriberID, email); err != nil {
		t.Fatalf("seed channel send history: %v", err)
	}

	runID := flowRunID
	if _, err := tx.Exec(ctx, `
INSERT INTO journey_attributes
  (tenant_id, run_id, flow_id, subscriber_id, name, output_type, value)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'intent', 'string',
       '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb)`,
		tenantID, runID, journeyID, subscriberID); err != nil {
		t.Fatalf("seed journey attribute: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO llm_action_invocations
  (tenant_id, run_id, flow_id, node_id, subscriber_id, model, output_type,
   output_attribute, rendered_prompt, raw_response, parsed_value, error)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'node-llm', $4::uuid, 'contract-model',
        'string', 'intent', 'must-not-export', 'must-not-export',
        '{"other_person":{"email":"other.person@example.test","secret":"sk_other_secret"}}'::jsonb,
        'must-not-export')`, tenantID, runID, journeyID, subscriberID); err != nil {
		t.Fatalf("seed LLM invocation: %v", err)
	}

	sourceEventID := "sar-contract:" + tenantID
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_lifecycle_event_inbox
  (tenant_id, source_event_id, subscriber_key, subscriber_id,
   transition_sequence, event_type, previous_stage, next_stage, score,
   transitioned_at, semantic_fingerprint)
VALUES ($1::uuid, $2, $3::uuid, $3::uuid, 1,
        'subscriber_lifecycle_stage_changed', 'lead', 'customer', 5, now(),
        repeat('a', 64))`, tenantID, sourceEventID, subscriberID); err != nil {
		t.Fatalf("seed lifecycle inbox: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_lifecycle_event_dispatches
	  (tenant_id, source_event_id, automation_id, trigger_type, state, result, accepted_at)
VALUES ($1::uuid, $2, $3::uuid, 'subscriber_lifecycle_stage_changed', 'accepted', 'queued', now())`,
		tenantID, sourceEventID, automationID); err != nil {
		t.Fatalf("seed lifecycle dispatch: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_lifecycle_subscriber_cursors
  (tenant_id, subscriber_id, last_accepted_sequence, last_source_event_id)
VALUES ($1::uuid, $2::uuid, 1, $3)
ON CONFLICT (tenant_id, subscriber_id) DO UPDATE
SET last_accepted_sequence = EXCLUDED.last_accepted_sequence,
    last_source_event_id = EXCLUDED.last_source_event_id`, tenantID, subscriberID, sourceEventID); err != nil {
		t.Fatalf("seed lifecycle cursor: %v", err)
	}

	// Bypass loadOptionalEmail here: missing-table compatibility is useful in
	// production rollouts, but this fully migrated schema contract must fail on
	// any absent table, invalid column, or malformed JSON projection.
	for _, section := range automationSARSections {
		rows, err := tx.Query(ctx, section.query, tenantID, email, section.rowLimit()+1)
		if err != nil {
			t.Fatalf("section %q query: %v", section.name, err)
		}
		for rows.Next() {
			var raw []byte
			if err := rows.Scan(&raw); err != nil {
				rows.Close()
				t.Fatalf("section %q scan: %v", section.name, err)
			}
			var projected map[string]any
			if err := json.Unmarshal(raw, &projected); err != nil {
				rows.Close()
				t.Fatalf("section %q JSON: %v", section.name, err)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			t.Fatalf("section %q deferred query error: %v", section.name, err)
		}
		rows.Close()
	}

	var executionSection sarSectionQuery
	for _, section := range automationSARSections {
		if section.name == "automation_executions" {
			executionSection = section
			break
		}
	}
	executionSection.limit = 1
	limitedRows, limitedMetadata, err := loadAutomationSARSection(ctx, tx, executionSection, tenantID, email)
	if err != nil {
		t.Fatalf("load limited automation executions: %v", err)
	}
	if len(limitedRows) != 1 || limitedMetadata.ReturnedCount != 1 ||
		!limitedMetadata.Truncated || limitedMetadata.Limit != 1 {
		t.Fatalf("limited automation execution result = %d rows / %#v", len(limitedRows), limitedMetadata)
	}

	bundle, _, err := buildBundle(ctx, tx, tenantID, email)
	if err != nil {
		t.Fatalf("build bundle against current schema: %v", err)
	}
	if _, leaked := bundle["tenant_id"]; leaked {
		t.Fatal("SAR bundle exposes internal tenant_id")
	}
	unavailable, ok := bundle["unavailable_sections"].([]string)
	if !ok || !sarTestContainsString(unavailable, "helpdesk_subject_access_complete") {
		t.Fatalf("Helpdesk incompleteness sentinel missing from unavailable_sections: %#v", bundle["unavailable_sections"])
	}
	helpdeskStatus, ok := bundle["helpdesk_subject_access_status"].(map[string]any)
	if !ok || helpdeskStatus["complete"] != false || helpdeskStatus["code"] != "helpdesk_subject_access_release_held" {
		t.Fatalf("Helpdesk subject-access status = %#v", bundle["helpdesk_subject_access_status"])
	}
	metadata, ok := bundle["automation_section_metadata"].(map[string]automationSARSectionMetadata)
	if !ok || len(metadata) != len(automationSARSections) {
		t.Fatalf("automation section metadata = %T %#v", bundle["automation_section_metadata"], bundle["automation_section_metadata"])
	}
	for _, section := range automationSARSections {
		rows, ok := bundle[section.name].([]map[string]any)
		if !ok || len(rows) == 0 {
			t.Errorf("seeded section %q is missing or empty: %T %#v", section.name, bundle[section.name], bundle[section.name])
			continue
		}
		sectionMetadata, present := metadata[section.name]
		if !present || sectionMetadata.ReturnedCount != len(rows) ||
			sectionMetadata.Truncated || sectionMetadata.Limit != section.rowLimit() {
			t.Errorf("section %q metadata = %#v for %d rows", section.name, sectionMetadata, len(rows))
		}
		for _, forbidden := range []string{
			"tenant_id", "push_token", "error", "last_error", "signature",
			"query", "config", "credentials_ref", "rendered_prompt", "raw_response",
			"payload", "metadata", "trigger_payload", "value", "parsed_value",
			"breakdown", "message", "cursor_value", "suppressed_reason",
			"rule_reason",
		} {
			for _, row := range rows {
				if containsMapKeyRecursively(row, forbidden) {
					t.Errorf("section %q leaked forbidden field %q", section.name, forbidden)
				}
			}
		}
	}
	serialized, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal disclosure for canary scan: %v", err)
	}
	for _, canary := range []string{"other.person@example.test", "sk_other_secret", "must-not-export"} {
		if strings.Contains(string(serialized), canary) {
			t.Errorf("automation disclosure leaked nested cross-person/secret canary %q", canary)
		}
	}

	// Make failures easier to diagnose when this fixture evolves: every seeded
	// subject row should be represented, not merely every section key.
	if t.Failed() {
		t.Logf("automation SAR section count: %d (%s)", len(automationSARSections), fmt.Sprint(email))
	}
}

func sarTestContainsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func containsMapKeyRecursively(value any, forbidden string) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if key == forbidden || containsMapKeyRecursively(child, forbidden) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if containsMapKeyRecursively(child, forbidden) {
				return true
			}
		}
	case []map[string]any:
		for _, child := range typed {
			if containsMapKeyRecursively(child, forbidden) {
				return true
			}
		}
	}
	return false
}
