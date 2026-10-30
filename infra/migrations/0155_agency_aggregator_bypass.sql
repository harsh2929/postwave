-- 0155_agency_aggregator_bypass.sql
--
-- Forward-fix for A3 (PRODUCTION_READINESS.md): agency/invoice.go
-- runs a LEFT JOIN tenants … subscriber_events that aggregates child-
-- tenant usage for an agency-parent invoice. subscriber_events has
-- FORCE RLS with a strict tenant_isolation policy keyed on
-- app.tenant_id; the agency-side bare-pool query has no GUC bound,
-- so RLS filtered every event row out and sends_last_30d came back
-- 0 for every child.
--
-- Fix: add a PERMISSIVE bypass policy gated on a new GUC
-- `app.agency_aggregator` whose value must match the parent tenant
-- id. Combined with tenants.parent_tenant_id, this lets a single
-- query enumerate all children's events WITHOUT a per-child tx.
--
-- Safety: the bypass requires (a) the caller knows the parent
-- tenant id (already authenticated via WithTenant before the
-- aggregator call) AND (b) the events being read belong to a child
-- whose tenants.parent_tenant_id matches. Both are checked in the
-- USING clause via a sub-SELECT against tenants.

BEGIN;

CREATE POLICY subscriber_events_agency_aggregator
    ON subscriber_events
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (
        NULLIF(current_setting('app.agency_aggregator', true), '') IS NOT NULL
        AND tenant_id IN (
            SELECT id FROM tenants
             WHERE parent_tenant_id = NULLIF(current_setting('app.agency_aggregator', true), '')::uuid
        )
    );

COMMIT;
