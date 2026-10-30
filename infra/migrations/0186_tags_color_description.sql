-- 0186_tags_color_description.sql
--
-- Refined Tags PR 1: persist the colour the admin UI was already
-- sending in PATCH bodies, and add a free-text description so each
-- tag can carry an explanation. Both additive + default-safe.
--
-- The colour palette is enforced client-side (8 named colours);
-- server stores any short text so future palette expansion doesn't
-- need a schema change.

BEGIN;

ALTER TABLE tags
    ADD COLUMN color       text,
    ADD COLUMN description text NOT NULL DEFAULT '';

COMMIT;
