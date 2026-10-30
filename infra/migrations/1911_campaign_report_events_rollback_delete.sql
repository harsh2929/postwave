-- 1911_campaign_report_events_rollback_delete.sql
--
-- Listmonk migration rollback could not undo one of the five things it creates.
--
-- `services/migration`'s import rollback deletes each row it created, keyed by
-- destination id, across five tables:
--
--     commerce_integrations, campaigns, campaign_report_events,
--     campaign_archive, migration_paid_subscriptions
--
-- It connects as `postwave_app` (the service's own config default) and sets
-- `app.tenant_id`. Four of those tables grant DELETE to that role. The fifth
-- does not, so a rollback that reached a campaign_report_events row raised
-- `permission denied` — leaving a partially-undone import, which is the one
-- state a rollback exists to prevent.
--
-- Verified by attempting exactly that delete as the app role.
--
-- NO CAPABILITY GATE, matching its four siblings. The counter-argument was
-- considered: campaign_report_events holds opens, clicks, bounces and
-- conversions, and analytics evidence is the kind of thing worth making
-- undeletable. But nothing in this schema treats it that way — no immutability
-- trigger, no retention sweep, and `campaigns` and `campaign_archive` are
-- themselves plainly deletable in the same statement list. Gating only this one
-- would be inconsistent without making anything safer, and would leave the
-- rollback broken unless the capability were threaded through too. If the
-- append-only reading is the intended one, it should be applied to the whole
-- group deliberately rather than surviving as one missing grant.

BEGIN;

GRANT DELETE ON campaign_report_events TO postwave_app;

COMMIT;
