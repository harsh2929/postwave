-- 1914_tags_group_fk_set_null_on_group_delete.sql
--
-- A tag group containing any tag could not be deleted.
--
-- `GroupRepo.Delete` issues exactly one statement — `DELETE FROM tag_groups` —
-- and relies on the database to deal with the tags that reference the group.
-- Migration 1774's composite foreign key
--
--     tags_tenant_group_fk_1774
--       FOREIGN KEY (tenant_id, group_id) REFERENCES tag_groups(tenant_id, id)
--
-- carries no ON DELETE action, so it defaults to NO ACTION and refuses the
-- delete: `update or delete on table "tag_groups" violates foreign key
-- constraint "tags_tenant_group_fk_1774" on table "tags"`. Deleting an empty
-- group works; deleting a group anybody has actually used does not.
--
-- The intended contract is documented by the test that catches this: create a
-- tag in a group, delete the group, and the TAG SURVIVES with its grouping
-- cleared. Tags are user data; a group is an organisational convenience, and
-- removing the folder must not remove what was filed in it.
--
-- COLUMN-SCOPED SET NULL, which is the only correct form here. A bare
-- `ON DELETE SET NULL` on a composite key nulls EVERY referencing column — it
-- would set `tenant_id` to NULL, and that column is NOT NULL, so the delete
-- would still fail (and if it succeeded it would strip the row's tenancy, which
-- is far worse than the bug). Naming `(group_id)` clears only the grouping.
--
-- This repository already uses that idiom twice: `campaigns` in 0027 with
-- `ON DELETE SET NULL (segment_id)`, and `agent_routines` in 1759. This makes
-- tags consistent with both.

BEGIN;

ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_tenant_group_fk_1774;

ALTER TABLE tags
    ADD CONSTRAINT tags_tenant_group_fk_1774
    FOREIGN KEY (tenant_id, group_id) REFERENCES tag_groups(tenant_id, id)
    ON DELETE SET NULL (group_id);

COMMIT;
