-- 0036_forms_multistep.sql
--
-- Sprint X3 / Forms+Web slice. Two additive changes to the existing forms
-- domain:
--
--   1. forms.steps jsonb — a list of step descriptors for the multi-step
--      form builder. Existing single-step forms migrate to a one-element
--      list whose fields mirror whatever currently lives in
--      `structure->'fields'`. Old code that reads only `structure` keeps
--      working unchanged; the new admin surface prefers `steps`.
--
--   2. form_submissions.metadata jsonb — bag for ambient context the public
--      submit endpoint captures (UTM tags from query string, referral code
--      from cookie, anything future ingest needs to carry without a schema
--      migration). Defaults to {} so existing inserts keep working.

BEGIN;

ALTER TABLE forms
    ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE form_submissions
    ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill: for any form whose `steps` is still the empty default and which
-- already has a non-empty `structure->'fields'`, wrap that fields array in a
-- single step so the new reader sees one consistent shape.
UPDATE forms
   SET steps = jsonb_build_array(
        jsonb_build_object(
            'title',  '',
            'fields', COALESCE(structure->'fields', '[]'::jsonb)
        )
   )
 WHERE steps = '[]'::jsonb
   AND jsonb_typeof(structure->'fields') = 'array';

COMMIT;
