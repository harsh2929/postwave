-- 1730_effective_tenant_schema_hardening.sql
--
-- Close tenant-isolation gaps found by inspecting the complete effective
-- PostgreSQL schema, rather than only newly-added migration text.
--
-- Every non-null tenant_id is a real ownership edge. Add the FK as NOT VALID
-- first so PostgreSQL does not scan existing rows while holding the stronger
-- constraint-install lock, then validate it explicitly. Validation is
-- intentionally fail-closed: an installation with orphan tenant rows must be
-- repaired before this migration can complete.
--
-- Nullable tenant_id columns are reviewed separately below. They model
-- platform/global rows or durable audit/accounting records and therefore do
-- not use ON DELETE CASCADE.
--
-- rollback-strategy: no-op - tenant isolation and referential integrity must
-- remain in place when an older application image is restored.

BEGIN;

-- RLS without FORCE RLS can be bypassed by a table owner. The runtime role is
-- not expected to own tables, but FORCE makes that deployment assumption
-- explicit and keeps owner mistakes from becoming isolation bypasses.
ALTER TABLE api_key_calls FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_delegations FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_escalation_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_investigations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_pii_unmask_history FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_redaction_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_sink_signing_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE blocklist_suppressions FORCE ROW LEVEL SECURITY;
ALTER TABLE bot_open_signatures FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_holdouts FORCE ROW LEVEL SECURITY;
ALTER TABLE campaign_tz_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE dedicated_ip_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE dmarc_aggregate_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_warmup_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE eq_score_history FORCE ROW LEVEL SECURITY;
ALTER TABLE event_log FORCE ROW LEVEL SECURITY;
ALTER TABLE hipaa_baa_events FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_route_matches FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE ip_reputation_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE maintenance_windows FORCE ROW LEVEL SECURITY;
ALTER TABLE mcp_tool_quotas FORCE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE outbound_webhooks FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE sar_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE scim_group_members FORCE ROW LEVEL SECURITY;
ALTER TABLE scim_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE scim_users FORCE ROW LEVEL SECURITY;
ALTER TABLE scoring_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE sms_conversation_state FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_import_errors FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriber_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_billing_mode_history FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_exports FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_send_window_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE utm_templates FORCE ROW LEVEL SECURITY;

-- These five tenant-owned surfaces already execute every access through
-- db.WithTenant (including the SMS taxonomy cascade), so enabling their
-- tenant predicate does not change the repository contract. The remaining
-- disabled tenant tables are intentionally left fail-closed in the effective
-- schema verifier until their direct/pre-auth access paths are refactored.
ALTER TABLE audit_saved_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_saved_views FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_saved_views_tenant_isolation ON audit_saved_views;
CREATE POLICY audit_saved_views_tenant_isolation ON audit_saved_views
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE export_retention_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_retention_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_retention_policy_tenant_isolation ON export_retention_policy;
CREATE POLICY export_retention_policy_tenant_isolation ON export_retention_policy
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE saved_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_blocks_tenant_isolation ON saved_blocks;
CREATE POLICY saved_blocks_tenant_isolation ON saved_blocks
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sms_conversation_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_conversation_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_conversation_tags_tenant_isolation ON sms_conversation_tags;
CREATE POLICY sms_conversation_tags_tenant_isolation ON sms_conversation_tags
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sms_quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_quick_replies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_quick_replies_tenant_isolation ON sms_quick_replies;
CREATE POLICY sms_quick_replies_tenant_isolation ON sms_quick_replies
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Install every missing non-null tenant ownership edge without an immediate
-- historical-row scan.
ALTER TABLE audit_anomaly_scores
    ADD CONSTRAINT audit_anomaly_scores_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_investigations
    ADD CONSTRAINT audit_investigations_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_pii_unmask_history
    ADD CONSTRAINT audit_pii_unmask_history_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_portal_sessions
    ADD CONSTRAINT audit_portal_sessions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_redaction_policies
    ADD CONSTRAINT audit_redaction_policies_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_saved_views
    ADD CONSTRAINT audit_saved_views_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_sink_dlq
    ADD CONSTRAINT audit_sink_dlq_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_sink_signing_keys
    ADD CONSTRAINT audit_sink_signing_keys_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE audit_user_baselines
    ADD CONSTRAINT audit_user_baselines_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE blocklist_suppressions
    ADD CONSTRAINT blocklist_suppressions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE campaign_ab_settings
    ADD CONSTRAINT campaign_ab_settings_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE campaign_variant_results
    ADD CONSTRAINT campaign_variant_results_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE consent_receipts
    ADD CONSTRAINT consent_receipts_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE dedicated_ip_assignments
    ADD CONSTRAINT dedicated_ip_assignments_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE dmarc_aggregate_reports
    ADD CONSTRAINT dmarc_aggregate_reports_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE eq_score_history
    ADD CONSTRAINT eq_score_history_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE external_warehouse_trigger_fires
    ADD CONSTRAINT external_warehouse_trigger_fires_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE hipaa_baa_events
    ADD CONSTRAINT hipaa_baa_events_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE inbound_route_matches
    ADD CONSTRAINT inbound_route_matches_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE inbound_routes
    ADD CONSTRAINT inbound_routes_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE inbox_reality_tests
    ADD CONSTRAINT inbox_reality_tests_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE outbound_webhook_deliveries
    ADD CONSTRAINT outbound_webhook_deliveries_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE outbound_webhooks
    ADD CONSTRAINT outbound_webhooks_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE roles
    ADD CONSTRAINT roles_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scheduled_reports
    ADD CONSTRAINT scheduled_reports_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scim_group_members
    ADD CONSTRAINT scim_group_members_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scim_groups
    ADD CONSTRAINT scim_groups_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scim_tokens
    ADD CONSTRAINT scim_tokens_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scim_users
    ADD CONSTRAINT scim_users_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE scoring_rules
    ADD CONSTRAINT scoring_rules_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sending_deprovision_jobs
    ADD CONSTRAINT sending_deprovision_jobs_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sending_identities
    ADD CONSTRAINT sending_identities_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sms_conversation_tags
    ADD CONSTRAINT sms_conversation_tags_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sms_quick_replies
    ADD CONSTRAINT sms_quick_replies_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE subscriber_import_errors
    ADD CONSTRAINT subscriber_import_errors_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE subscriber_imports
    ADD CONSTRAINT subscriber_imports_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sunset_executions
    ADD CONSTRAINT sunset_executions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE sunset_policies
    ADD CONSTRAINT sunset_policies_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE tenant_ai_usage
    ADD CONSTRAINT tenant_ai_usage_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE tenant_exports
    ADD CONSTRAINT tenant_exports_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE tenant_keys
    ADD CONSTRAINT tenant_keys_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE voice_profile_labels
    ADD CONSTRAINT voice_profile_labels_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE voice_semantic_signatures
    ADD CONSTRAINT voice_semantic_signatures_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE winback_candidate_queue
    ADD CONSTRAINT winback_candidate_queue_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE NOT VALID;

-- Validate every new edge before committing. These scans use PostgreSQL's
-- lower-impact validation lock and fail if an orphan exists.
ALTER TABLE audit_anomaly_scores VALIDATE CONSTRAINT audit_anomaly_scores_tenant_id_fkey;
ALTER TABLE audit_investigations VALIDATE CONSTRAINT audit_investigations_tenant_id_fkey;
ALTER TABLE audit_pii_unmask_history VALIDATE CONSTRAINT audit_pii_unmask_history_tenant_id_fkey;
ALTER TABLE audit_portal_sessions VALIDATE CONSTRAINT audit_portal_sessions_tenant_id_fkey;
ALTER TABLE audit_redaction_policies VALIDATE CONSTRAINT audit_redaction_policies_tenant_id_fkey;
ALTER TABLE audit_saved_views VALIDATE CONSTRAINT audit_saved_views_tenant_id_fkey;
ALTER TABLE audit_sink_dlq VALIDATE CONSTRAINT audit_sink_dlq_tenant_id_fkey;
ALTER TABLE audit_sink_signing_keys VALIDATE CONSTRAINT audit_sink_signing_keys_tenant_id_fkey;
ALTER TABLE audit_user_baselines VALIDATE CONSTRAINT audit_user_baselines_tenant_id_fkey;
ALTER TABLE blocklist_suppressions VALIDATE CONSTRAINT blocklist_suppressions_tenant_id_fkey;
ALTER TABLE campaign_ab_settings VALIDATE CONSTRAINT campaign_ab_settings_tenant_id_fkey;
ALTER TABLE campaign_variant_results VALIDATE CONSTRAINT campaign_variant_results_tenant_id_fkey;
ALTER TABLE consent_receipts VALIDATE CONSTRAINT consent_receipts_tenant_id_fkey;
ALTER TABLE dedicated_ip_assignments VALIDATE CONSTRAINT dedicated_ip_assignments_tenant_id_fkey;
ALTER TABLE dmarc_aggregate_reports VALIDATE CONSTRAINT dmarc_aggregate_reports_tenant_id_fkey;
ALTER TABLE eq_score_history VALIDATE CONSTRAINT eq_score_history_tenant_id_fkey;
ALTER TABLE external_warehouse_trigger_fires VALIDATE CONSTRAINT external_warehouse_trigger_fires_tenant_id_fkey;
ALTER TABLE hipaa_baa_events VALIDATE CONSTRAINT hipaa_baa_events_tenant_id_fkey;
ALTER TABLE inbound_route_matches VALIDATE CONSTRAINT inbound_route_matches_tenant_id_fkey;
ALTER TABLE inbound_routes VALIDATE CONSTRAINT inbound_routes_tenant_id_fkey;
ALTER TABLE inbox_reality_tests VALIDATE CONSTRAINT inbox_reality_tests_tenant_id_fkey;
ALTER TABLE outbound_webhook_deliveries VALIDATE CONSTRAINT outbound_webhook_deliveries_tenant_id_fkey;
ALTER TABLE outbound_webhooks VALIDATE CONSTRAINT outbound_webhooks_tenant_id_fkey;
ALTER TABLE roles VALIDATE CONSTRAINT roles_tenant_id_fkey;
ALTER TABLE scheduled_reports VALIDATE CONSTRAINT scheduled_reports_tenant_id_fkey;
ALTER TABLE scim_group_members VALIDATE CONSTRAINT scim_group_members_tenant_id_fkey;
ALTER TABLE scim_groups VALIDATE CONSTRAINT scim_groups_tenant_id_fkey;
ALTER TABLE scim_tokens VALIDATE CONSTRAINT scim_tokens_tenant_id_fkey;
ALTER TABLE scim_users VALIDATE CONSTRAINT scim_users_tenant_id_fkey;
ALTER TABLE scoring_rules VALIDATE CONSTRAINT scoring_rules_tenant_id_fkey;
ALTER TABLE sending_deprovision_jobs VALIDATE CONSTRAINT sending_deprovision_jobs_tenant_id_fkey;
ALTER TABLE sending_identities VALIDATE CONSTRAINT sending_identities_tenant_id_fkey;
ALTER TABLE sms_conversation_tags VALIDATE CONSTRAINT sms_conversation_tags_tenant_id_fkey;
ALTER TABLE sms_quick_replies VALIDATE CONSTRAINT sms_quick_replies_tenant_id_fkey;
ALTER TABLE subscriber_import_errors VALIDATE CONSTRAINT subscriber_import_errors_tenant_id_fkey;
ALTER TABLE subscriber_imports VALIDATE CONSTRAINT subscriber_imports_tenant_id_fkey;
ALTER TABLE sunset_executions VALIDATE CONSTRAINT sunset_executions_tenant_id_fkey;
ALTER TABLE sunset_policies VALIDATE CONSTRAINT sunset_policies_tenant_id_fkey;
ALTER TABLE tenant_ai_usage VALIDATE CONSTRAINT tenant_ai_usage_tenant_id_fkey;
ALTER TABLE tenant_exports VALIDATE CONSTRAINT tenant_exports_tenant_id_fkey;
ALTER TABLE tenant_keys VALIDATE CONSTRAINT tenant_keys_tenant_id_fkey;
ALTER TABLE voice_profile_labels VALIDATE CONSTRAINT voice_profile_labels_tenant_id_fkey;
ALTER TABLE voice_semantic_signatures VALIDATE CONSTRAINT voice_semantic_signatures_tenant_id_fkey;
ALTER TABLE winback_candidate_queue VALIDATE CONSTRAINT winback_candidate_queue_tenant_id_fkey;

-- Machine-readable classifications for the complete-schema verifier. These
-- are intentionally comments on the effective objects, not assumptions held
-- only in a linter allow-list.
COMMENT ON COLUMN affiliate_conversions.tenant_id IS
    'postwave:tenant-scope-exception=global-accounting; nullable and deliberately not a tenant FK so accounting rows survive tenant deletion';
COMMENT ON COLUMN audit_log.tenant_id IS
    'postwave:tenant-scope-exception=platform-operator-audit; NULL identifies a fleet-level operator action while tenant rows retain ON DELETE CASCADE';
COMMENT ON COLUMN billing_events.tenant_id IS
    'postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL so webhook evidence survives tenant deletion';
COMMENT ON COLUMN blocklist_observations.tenant_id IS
    'postwave:tenant-scope-exception=shared-infrastructure; NULL identifies operator-owned free-pool infrastructure';
COMMENT ON COLUMN bot_open_signatures.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide bot signature';
COMMENT ON COLUMN campaign_templates.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL identifies a platform-shared campaign template';
COMMENT ON COLUMN cli_device_grants.tenant_id IS
    'postwave:tenant-scope-exception=preauth-secret; NULL identifies an unapproved device grant that must be selected only by a transaction-bound secret';
COMMENT ON COLUMN ip_reputation_snapshots.tenant_id IS
    'postwave:tenant-scope-exception=shared-infrastructure; NULL identifies operator-owned free-pool infrastructure';
COMMENT ON COLUMN maintenance_windows.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide maintenance window';
COMMENT ON COLUMN privacy_incidents.tenant_id IS
    'postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL so compliance evidence survives tenant deletion';
COMMENT ON COLUMN recommendation_network_peers.tenant_id IS
    'postwave:tenant-scope-exception=durable-audit-set-null; nullable FK uses ON DELETE SET NULL so archived network evidence survives tenant deletion';
COMMENT ON COLUMN tenant_feature_flags.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL identifies a platform-wide feature default';
COMMENT ON COLUMN template_thumbnails.tenant_id IS
    'postwave:tenant-scope-exception=platform-default; NULL mirrors a platform-shared campaign template';
COMMENT ON COLUMN web_vitals_events.tenant_id IS
    'postwave:tenant-scope-exception=global-telemetry; nullable and deliberately not a tenant FK because anonymous telemetry is not tenant-owned';
COMMENT ON COLUMN webmentions_inbox.tenant_id IS
    'postwave:tenant-scope-exception=unresolved-public-ingest; NULL identifies a Webmention that could not yet be bound to a tenant';

-- The pre-partition web-vitals table retained UPDATE/DELETE grants when it was
-- attached as the legacy partition. Queries should enter through the parent,
-- whose reviewed global-telemetry surface is SELECT + INSERT only.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON web_vitals_events_legacy FROM postwave_app;

COMMIT;
