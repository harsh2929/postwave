-- 1881_editor_checkpoints_entity_id_len.sql
--
-- Align editor_checkpoints' entity_id bound with activity_cursor's.
--
-- Migration 1778 lets `activity_cursor.entity_id` be up to 256 characters;
-- migration 1878 capped `editor_checkpoints.entity_id` at 128. The two are two
-- halves of one feature — the cursor says WHICH entity, the checkpoint holds
-- what was typed into it — so an entity the cursor could point at was one the
-- checkpoint refused, and the refusal arrived as a CHECK violation the handler
-- surfaced as a 500.
--
-- Found by a test rather than by a user: widening only the Go-side validator
-- would have converted the same inputs from one opaque failure into another,
-- because the schema is what actually rejects them.

BEGIN;

ALTER TABLE editor_checkpoints
    DROP CONSTRAINT IF EXISTS editor_checkpoints_entity_id_len;

ALTER TABLE editor_checkpoints
    ADD CONSTRAINT editor_checkpoints_entity_id_len
    CHECK (char_length(entity_id) BETWEEN 1 AND 256);

COMMIT;
