-- SPDX-License-Identifier: AGPL-3.0-only
-- Custom-object schema and record writes were last-writer-wins.  Explicit row
-- versions make every dashboard mutation compare the representation the actor
-- actually inspected, while version zero remains the create-only record intent.

ALTER TABLE custom_object_types
    ADD COLUMN version bigint NOT NULL DEFAULT 1
        CHECK (version > 0);

ALTER TABLE custom_object_records
    ADD COLUMN version bigint NOT NULL DEFAULT 1
        CHECK (version > 0);

COMMENT ON COLUMN custom_object_types.version IS
    'Monotonic optimistic-concurrency version; incremented by every API update.';

COMMENT ON COLUMN custom_object_records.version IS
    'Monotonic optimistic-concurrency version; incremented by every API update.';
