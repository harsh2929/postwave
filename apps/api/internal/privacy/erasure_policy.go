// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"fmt"
	"sort"
	"strings"
)

// erasurePolicyDisposition is deliberately not a legal conclusion. It records
// what the product may do to a store today. In particular,
// policyApprovalRequired means no delete/anonymize/retain choice has been made;
// the runtime must stay closed until counsel/product supply that choice.
type erasurePolicyDisposition string

const (
	erasurePolicyImplemented       erasurePolicyDisposition = "implemented"
	erasurePolicyDerivedView       erasurePolicyDisposition = "derived_view"
	erasurePolicyApprovalRequired  erasurePolicyDisposition = "approval_required"
	erasurePolicyApprovedRetention erasurePolicyDisposition = "approved_retention"
)

type erasureRetentionPolicy struct {
	Table          string
	RetentionRule  string
	LegalBasis     string
	ApprovalRecord string
}

type erasurePolicyReadiness struct {
	DispositionByTable map[string]erasurePolicyDisposition
	ApprovalRequired   []string
}

// erasureApprovalRequiredTables is intentionally explicit. A newly discovered
// store cannot quietly inherit a generic DELETE or a generic "retain" default.
// Moving one of these entries to implemented coverage requires the mutation,
// its least-privilege grant, and a PostgreSQL absence proof in the same change.
// Moving one to approved retention requires a bounded rule, legal basis, and
// private approval-record identifier; there are no approved-retention entries
// in source today.
var erasureApprovalRequiredTables = []string{
	"activation_exclusion_receipts",
	"affiliates",
	"archive_tips",
	"audit_access_requests",
	"audit_export_jobs",
	"audit_export_schedules",
	"auth_idp_links",
	"automation_executions",
	"automation_flow_activity",
	"automation_journey_events",
	"automation_journey_executions",
	"back_in_stock_subscriptions",
	"bounce_events",
	"campaign_recipient_send_at",
	"campaign_recipients",
	"campaign_recipients_partitioned",
	"campaign_variants",
	"channel_send_history",
	"cli_auth_grants",
	"cli_device_grants",
	"commerce_cart_recovery_links",
	"commerce_customers",
	"commerce_events",
	"commerce_orders",
	"complaint_events",
	"compliance_program_events",
	"compliance_programs",
	"consent_events",
	"consent_records",
	"contact_activity",
	"content_reports",
	"coupon_assignments",
	"coupon_codes",
	"coupon_entitlement_events",
	"coupon_render_reservations",
	"crm_contact_profile_bindings",
	"developer_apps",
	"dmarc_reports",
	"double_optin_pending",
	"email_compliance_profiles",
	"email_health_snapshots",
	"email_optimizer_assignments",
	"firewall_signup_events",
	"flow_ab_test_assignments",
	"form_submissions",
	"gift_attribution_events",
	"gift_subscriptions",
	"growth_surface_events",
	"hipaa_baa_events",
	"impersonation_sessions",
	"inbound_emails",
	"inbound_route_matches",
	"inbound_webhook_action_intents",
	"incident_state_transitions",
	"list_subscriber_sources",
	"list_subscribers",
	"lookalike_members",
	"migration_paid_subscriptions",
	"migration_verifier_subscriber_observations",
	"omni_recipients",
	"onsite_experiment_events",
	"ops_action_runs",
	"paid_members",
	"paid_subs",
	"partner_program_profiles",
	"platform_operators",
	"preference_tokens",
	"price_drop_watchers",
	"privacy_requests",
	"product_review_questions",
	"product_reviews",
	"profile_object_links",
	"retention_offer_events",
	"retention_winback_sends",
	"review_requests",
	"sandbox_events",
	"sar_bundles",
	"seedlist_outcomes",
	"segment_membership_log",
	"segment_static_freeze_members",
	"sms_broadcasts",
	"sms_campaign_recipients",
	"sms_campaigns",
	"sms_consent_events",
	"sms_conversation_state",
	"sms_conversation_tags",
	"sms_link_clicks",
	"sms_link_tokens",
	"sms_message_read_receipts",
	"sms_messages",
	"sms_quick_replies",
	"sms_sender_profiles",
	"sms_subscriptions",
	"sms_suppressions",
	"social_lead_captures",
	"subscriber_email_consent_address_state",
	"subscriber_import_errors",
	"subscriber_imports",
	"subscriber_lookalike_members",
	"subscriber_note_attachments",
	"subscriber_podcast_tokens",
	"subscriber_topics",
	"subscriber_tracking_prefs",
	"suppression_audit",
	"tap_to_text_events",
	"team_invitations",
	"tenant_exports",
	"tenants",
	"users",
	"verification_cache",
	"verification_job_items",
	"voice_sequences",
	"voice_templates",
}

var erasureDerivedViewTables = []string{"v_suppressions_unified"}

// Empty by design. Retaining identifiable data is never inferred from a table
// name or from the fact that a table is append-only. Counsel/product must add a
// bounded rule and approval reference here; code must still anonymize direct
// identity unless the approved record explicitly says otherwise.
var erasureApprovedRetentionPolicies []erasureRetentionPolicy

func currentErasurePolicyReadiness() (erasurePolicyReadiness, error) {
	pending := append([]string(nil), erasureApprovalRequiredTables...)
	pending = append(pending, declaredHelpdeskRelationalSubjectTables...)
	return evaluateErasurePolicy(
		append(append([]string(nil), declaredSubjectDataTables...), declaredHelpdeskRelationalSubjectTables...),
		erasureCoveredTables,
		pending,
		erasureDerivedViewTables,
		erasureApprovedRetentionPolicies,
	)
}

func evaluateErasurePolicy(
	inventory, implemented, approvalRequired, derived []string,
	retained []erasureRetentionPolicy,
) (erasurePolicyReadiness, error) {
	result := erasurePolicyReadiness{DispositionByTable: map[string]erasurePolicyDisposition{}}
	inventorySet := map[string]bool{}
	for _, table := range inventory {
		table = strings.TrimSpace(table)
		if table == "" {
			return result, fmt.Errorf("erasure policy inventory contains an empty table")
		}
		if inventorySet[table] {
			// support_conversations is intentionally present in both the broad
			// column inventory and the Helpdesk relational graph. It remains one
			// policy store, not two independent mutations.
			continue
		}
		inventorySet[table] = true
	}

	assign := func(table string, disposition erasurePolicyDisposition) error {
		table = strings.TrimSpace(table)
		if table == "" {
			return fmt.Errorf("erasure policy contains an empty %s table", disposition)
		}
		if previous, exists := result.DispositionByTable[table]; exists {
			return fmt.Errorf("erasure policy table %q has both %s and %s dispositions", table, previous, disposition)
		}
		result.DispositionByTable[table] = disposition
		return nil
	}
	for _, table := range implemented {
		if err := assign(table, erasurePolicyImplemented); err != nil {
			return result, err
		}
	}
	for _, table := range approvalRequired {
		if err := assign(table, erasurePolicyApprovalRequired); err != nil {
			return result, err
		}
		result.ApprovalRequired = append(result.ApprovalRequired, table)
	}
	for _, table := range derived {
		if err := assign(table, erasurePolicyDerivedView); err != nil {
			return result, err
		}
	}
	for _, policy := range retained {
		if strings.TrimSpace(policy.RetentionRule) == "" ||
			strings.TrimSpace(policy.LegalBasis) == "" ||
			strings.TrimSpace(policy.ApprovalRecord) == "" {
			return result, fmt.Errorf("retention policy for %q lacks a rule, legal basis, or approval record", policy.Table)
		}
		if err := assign(policy.Table, erasurePolicyApprovedRetention); err != nil {
			return result, err
		}
	}

	var unclassified []string
	for table := range inventorySet {
		if _, ok := result.DispositionByTable[table]; !ok {
			unclassified = append(unclassified, table)
		}
	}
	var unknown []string
	for table := range result.DispositionByTable {
		// Implemented subscriber-id satellites need not carry an address column,
		// so implemented entries may extend the discovered address inventory.
		if !inventorySet[table] && result.DispositionByTable[table] != erasurePolicyImplemented {
			unknown = append(unknown, table)
		}
	}
	sort.Strings(unclassified)
	sort.Strings(unknown)
	sort.Strings(result.ApprovalRequired)
	if len(unclassified) != 0 || len(unknown) != 0 {
		return result, fmt.Errorf("erasure policy is incomplete: unclassified=%v unknown=%v", unclassified, unknown)
	}
	return result, nil
}
