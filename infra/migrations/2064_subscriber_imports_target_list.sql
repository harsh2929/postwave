-- 2064_subscriber_imports_target_list.sql
--
-- Let a CSV import name the list its contacts join.
--
-- The wizard could upload, map, review and commit a file, but it could not say
-- where the contacts should land: the import wrote `subscribers` rows and
-- nothing else. "Import into a new list" therefore took two passes — import,
-- then find the new contacts in the directory and bulk add-to-list — and the
-- second pass is exactly the one an operator forgets, so imported audiences sat
-- outside every list and every campaign that targets one.
--
-- target_list_id is the list chosen in the wizard, stored as the canonical
-- Postwave list uuid (the same identity list_subscribers.list_id carries). NULL
-- — the default, and what every existing row keeps — means "no list", i.e.
-- today's behaviour.
--
-- WHY THE FK POINTS AT list_id_map. Lists live in the Listmonk engine; the
-- gateway's list identity is list_id_map (migration 0222), which is what
-- outbound_webhooks already carries a composite (tenant_id, list_id) FK to
-- (migration 1800). The same shape here means an import can never name another
-- tenant's list, or an id nobody minted, even if a handler forgot to resolve
-- it. Deleting a list RETIRES its identity row rather than deleting it
-- (migration 2051), so the FK can never block a delete or orphan this column;
-- the worker still re-resolves the list inside its writing transaction, where a
-- retired identity resolves to nothing.
--
-- No index is added: the column is only ever read back on the import row that
-- owns it (by primary key), never searched by list.
--
-- migration-execution: transactional. ADD COLUMN with a NULL default and ADD
-- CONSTRAINT take a brief ACCESS EXCLUSIVE lock on subscriber_imports (a small,
-- operator-paced table); lock_timeout bounds the wait. The FK validation scans
-- the table, where every existing row has target_list_id IS NULL and is
-- therefore satisfied without touching list_id_map.
-- rollback-strategy: no-op
-- rollback-details: An earlier binary never writes or reads target_list_id, so
-- the column and its constraint are inert after a rollback. Leave them.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE subscriber_imports
    ADD COLUMN IF NOT EXISTS target_list_id uuid;

COMMENT ON COLUMN subscriber_imports.target_list_id IS
    'Optional list (canonical Postwave list uuid) every imported contact is added to; NULL = no list.';

ALTER TABLE subscriber_imports
    DROP CONSTRAINT IF EXISTS subscriber_imports_tenant_target_list_fkey;

-- MATCH SIMPLE (the default): a NULL target_list_id is exempt, which is what
-- "no list" must be.
ALTER TABLE subscriber_imports
    ADD CONSTRAINT subscriber_imports_tenant_target_list_fkey
        FOREIGN KEY (tenant_id, target_list_id)
        REFERENCES list_id_map (tenant_id, postwave_uuid);

COMMIT;
