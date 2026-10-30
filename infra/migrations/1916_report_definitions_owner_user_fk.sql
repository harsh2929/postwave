-- 1916_report_definitions_owner_user_fk.sql
--
-- A deleted user's id survived in `report_definitions.owner_user_id`.
--
-- The self-deletion worker states its own contract in a comment above its
-- scrub list (`internal/accountdeletion/worker.go`):
--
--     These tables intentionally lack user FKs or retain human-readable author
--     labels. Delete personal state and scrub direct attribution before the
--     users-row cascade removes credentials, sessions, IdP links, TOTP, push
--     devices, dashboard layouts, delegations, and other FK-owned state.
--
-- So a column holding a user id is covered one of exactly two ways: a foreign
-- key to `users(id)` that CASCADEs or SET NULLs, or an explicit statement in
-- that list. `owner_user_id` had neither. It was added by 0204 with no foreign
-- key of any kind — the table's only FK is to `tenants` — and no statement in
-- the worker names it.
--
-- That cost nothing while the column was dead. It is not free now: the column
-- is written from the request's user on every save, so a user who exercises
-- their right to erasure keeps an identifier in `report_definitions` forever
-- while the worker writes `account.self_deletion_fulfilled` to the audit log
-- and issues a completion certificate. The claim outran the deletion.
--
-- SET NULL, not CASCADE. A saved report is workspace content — the team keeps
-- what was built for it. Erasure removes the person, not the team's work, and
-- NULL is the same "ownerless" state the insert already writes for API-key and
-- automation callers.
--
-- This is the schema's own convention for user attribution, not a new idea:
-- `campaign_ai_summaries.generated_by_user_id` (0320),
-- `saved_segments.created_by_user_id` (1236) and
-- `approval_escalation_policies.updated_by_user_id` (0179) are all
-- `REFERENCES users(id) ON DELETE SET NULL`. None of them appear in the
-- worker's list either, because the foreign key is what covers them.
--
-- Declaring it in the schema rather than adding a line to the worker also
-- covers the other paths that remove a user row (SCIM deprovisioning,
-- workspace member removal), which a worker-only fix would not.
--
-- The UPDATE first: any id already pointing at a user who is gone cannot
-- satisfy the constraint, and those rows are precisely the residue this
-- migration exists to remove.

BEGIN;

UPDATE report_definitions d
   SET owner_user_id = NULL
 WHERE d.owner_user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = d.owner_user_id);

ALTER TABLE report_definitions
    DROP CONSTRAINT IF EXISTS report_definitions_owner_user_id_fkey;

ALTER TABLE report_definitions
    ADD CONSTRAINT report_definitions_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
