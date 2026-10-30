// SPDX-License-Identifier: AGPL-3.0-only

// erasure_inventory.go — which tables hold subject identity, and which of them
// the Art. 17 path actually reaches.
//
// erasureHistoryCoverageComplete stays false "until that inventory/migration
// and its PostgreSQL absence proof" land. This file is the inventory half. It
// does NOT claim coverage — it makes the scope visible and prevents it from
// growing silently, which is the precondition for ever flipping that constant
// honestly.
//
// The distinction that keeps this useful: a RATCHET, not an assertion of
// completeness. Partition children are represented by their logical root, so
// adding a monthly partition does not masquerade as a new data class. Every
// logical store is also present in erasure_policy.go: its mutation is already
// implemented, it is a derived view, or it remains fail-closed pending an
// explicit store-specific decision. A new store may not inherit a default.

package privacy

// subjectIdentityColumnPredicate defines what counts as carrying subject
// identity, in SQL, so the discovery query and this list cannot drift.
//
// Deliberately broad: it is better to declare a table that turns out to hold a
// SENDER address than to miss one holding a recipient's. A false entry costs a
// line here; a missed one is an unerased identity.
const subjectIdentityColumnPredicate = `
    column_name ~ '(^|_)email$' OR column_name ~ '(^|_)emails$'
    OR column_name IN ('recipient_email','subscriber_email','from_email','to_email',
                       'phone','phone_number','phone_e164','msisdn')
    OR table_name IN (
      'conversion_attribution_touches',
      'conversion_email_hmac_bindings','conversion_email_hmac_projection_tasks',
      'outbound_webhook_playground_fires',
      'sms_broadcasts','sms_campaign_recipients','sms_campaigns',
      'sms_conversation_state','sms_conversation_tags','sms_link_clicks',
      'sms_link_tokens','sms_message_read_receipts','sms_messages',
      'sms_quick_replies'
    )`

// erasureCoveredTables are the tables eraseSubscriberDataWithEntropy writes.
//
// Kept here rather than inferred from the source so the DB test can cross-check
// it against the real schema: a typo in a table name inside a SQL string is
// otherwise invisible until an erasure silently misses a table.
var erasureCoveredTables = []string{
	"campaign_replies",
	"campaign_report_events",
	"consent_receipts",
	"conversion_attribution_touches",
	"conversion_email_hmac_bindings",
	"conversion_email_hmac_projection_tasks",
	"conversions",
	"email_suppressions",
	// Discovered by the F03 fresh-chain privacy inventory gate: this send-time
	// ledger stores subscriber_email plaintext and has no legal-retention role.
	"frequency_cap_events",
	"intelligent_retry_events",
	"outbound_webhook_playground_fires",
	"profile_aliases",
	"profile_predictions",
	"profile_rfm_scores",
	"sequence_enrollments",
	"sequence_funnel_events",
	"subscriber_attribute_history",
	"subscriber_channel_consents",
	"subscriber_computed_traits",
	"subscriber_emails",
	"subscriber_events",
	"subscriber_notes",
	"subscriber_pii_findings",
	"subscriber_prediction_metadata",
	"subscriber_suppressions",
	"subscriber_send_log",
	"subscribers",
	"suppressions",
}

// declaredHelpdeskRelationalSubjectTables records the Helpdesk/Customer Hub
// relational graph that can retain subject content or lifecycle evidence even
// when a table has no column whose name matches subjectIdentityColumnPredicate.
// None is covered by the active erasure path. Keeping this separate from
// declaredSubjectDataTables preserves the schema-column ratchet while making
// the release-held relational gap explicit and mechanically testable.
var declaredHelpdeskRelationalSubjectTables = []string{
	"customer_hub_configs",
	"support_agent_runs",
	"support_assignments",
	"support_channels",
	"support_conversations",
	"support_ingest_conflicts",
	"support_integrations",
	"support_internal_note_intents",
	"support_macros",
	"support_messages",
	"support_spam_assessments",
	"support_sync_runs",
	"support_tickets",
	"support_views",
	"support_webhook_events",
}

// declaredSubjectDataTables is the recorded baseline of tables carrying subject
// identity. A NEW table appearing here fails the inventory test until someone
// adds it deliberately — which is the moment to decide whether Art. 17 must
// reach it.
var declaredSubjectDataTables = []string{
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
	"campaign_replies",
	"campaign_report_events",
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
	"consent_receipts",
	"consent_records",
	"contact_activity",
	// DSA notice evidence deliberately remains outside the active Art. 17
	// erasure worker until its notifier-identity retention/redaction policy is
	// approved; declaring it here keeps the global completion gate fail-closed.
	"content_reports",
	"conversion_attribution_touches",
	"conversion_email_hmac_bindings",
	"conversion_email_hmac_projection_tasks",
	"conversions",
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
	"email_suppressions",
	"firewall_signup_events",
	"flow_ab_test_assignments",
	"form_submissions",
	"frequency_cap_events",
	"gift_attribution_events",
	"gift_subscriptions",
	"growth_surface_events",
	"hipaa_baa_events",
	"impersonation_sessions",
	"inbound_emails",
	"inbound_route_matches",
	"inbound_webhook_action_intents",
	"incident_state_transitions",
	"intelligent_retry_events",
	"list_subscriber_sources",
	"list_subscribers",
	"lookalike_members",
	"migration_paid_subscriptions",
	"migration_verifier_subscriber_observations",
	"omni_recipients",
	"onsite_experiment_events",
	"ops_action_runs",
	"outbound_webhook_playground_fires",
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
	"profile_predictions",
	"profile_rfm_scores",
	"retention_offer_events",
	"retention_winback_sends",
	"review_requests",
	"sandbox_events",
	"sar_bundles",
	"seedlist_outcomes",
	"segment_membership_log",
	"segment_static_freeze_members",
	"sequence_enrollments",
	"sequence_funnel_events",
	"sms_consent_events",
	"sms_broadcasts",
	"sms_campaign_recipients",
	"sms_campaigns",
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
	"subscriber_channel_consents",
	"subscriber_email_consent_address_state",
	"subscriber_emails",
	"subscriber_events",
	"subscriber_import_errors",
	"subscriber_imports",
	"subscriber_lookalike_members",
	"subscriber_note_attachments",
	"subscriber_notes",
	"subscriber_podcast_tokens",
	"subscriber_send_log",
	"subscriber_suppressions",
	"subscriber_topics",
	"subscriber_tracking_prefs",
	"subscribers",
	"support_conversations",
	"suppression_audit",
	"suppressions",
	"tap_to_text_events",
	"team_invitations",
	"tenant_exports",
	"tenants",
	"users",
	"v_suppressions_unified",
	"verification_cache",
	"verification_job_items",
	"voice_sequences",
	"voice_templates",
}
