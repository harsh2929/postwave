-- 1699_enable_partition_rotator.sql
-- Migration 0339 pre-created only current-month + 2 partitions on the five
-- high-volume event tables, seeded every partition_rotator_config row with
-- enabled=false, and created NO default partition. The rotator worker
-- (apps/api/main.go:7561) runs on a 24h tick but skips every disabled row,
-- so no new partition is ever pre-created and no old one is ever dropped.
--
-- When the pre-created ranges run out, INSERTs into audit_log,
-- subscriber_events, campaign_report_events, event_log and web_vitals_events
-- all fail at once with "no partition of relation ... found for row".
--
-- This turns the rotator on. Retention windows are unchanged from 0339.
--
-- rollback-strategy: no-op - set enabled=false to disable the rotator again;
-- partitions it already created are harmless and are not dropped by a rollback.

BEGIN;

UPDATE partition_rotator_config
   SET enabled = true
 WHERE table_name IN (
        'audit_log',
        'subscriber_events',
        'campaign_report_events',
        'event_log',
        'web_vitals_events'
       );

COMMIT;
