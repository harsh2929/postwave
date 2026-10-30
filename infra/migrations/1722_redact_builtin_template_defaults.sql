-- 1722_redact_builtin_template_defaults.sql
--
-- Forward-only cleanup for global example templates seeded by migrations 0240
-- and 0241. Those applied migrations are checksum-immutable; this migration
-- removes personal contact defaults and unsubstantiated sample customer/result
-- data without rewriting their recorded bytes.
--
-- rollback-strategy: no-op - do not restore personal or unsupported defaults.

BEGIN;

WITH rewritten AS (
    SELECT
        template.id,
        jsonb_agg(
            CASE
                WHEN item.value ->> 'default' = 'Harsh' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('Alex'::text), false)
                WHEN item.value ->> 'default' = 'harsh@postwave.com' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('creator@example.invalid'::text), false)
                WHEN template.slug = 'announcement-milestone-typographic'
                     AND item.value ->> 'name' = 'milestone_label' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('READERS'::text), false)
                WHEN template.slug = 'announcement-milestone-typographic'
                     AND item.value ->> 'name' = 'customer_quote' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('A milestone worth sharing.'::text), false)
                WHEN template.slug = 'announcement-milestone-typographic'
                     AND item.value ->> 'name' = 'customer_name' THEN
                    jsonb_set(
                        jsonb_set(item.value, '{label}', to_jsonb('Community'::text), false),
                        '{default}',
                        to_jsonb('Your community'::text),
                        false
                    )
                WHEN template.slug = 'announcement-milestone-typographic'
                     AND item.value ->> 'name' = 'cta_url' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('https://example.invalid/thanks'::text), false)
                WHEN template.slug = 'newsletter-margin-notes'
                     AND item.value ->> 'name' = 'margin_one' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('Many B2B sends cluster on weekday mornings'::text), false)
                WHEN template.slug = 'newsletter-margin-notes'
                     AND item.value ->> 'name' = 'margin_two' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('Measure delivery and engagement before changing schedule'::text), false)
                WHEN template.slug = 'newsletter-margin-notes'
                     AND item.value ->> 'name' = 'margin_three' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('Compare a controlled alternate send window'::text), false)
                WHEN template.slug = 'newsletter-margin-notes'
                     AND item.value ->> 'name' = 'pull_quote' THEN
                    jsonb_set(item.value, '{default}', to_jsonb('The day everyone sends may not be your best send time.'::text), false)
                WHEN template.slug = 'newsletter-margin-notes'
                     AND item.value ->> 'name' IN ('archive_url', 'unsubscribe_url') THEN
                    jsonb_set(
                        item.value,
                        '{default}',
                        to_jsonb(
                            CASE item.value ->> 'name'
                                WHEN 'archive_url' THEN 'https://example.invalid/archive'
                                ELSE 'https://example.invalid/unsubscribe'
                            END
                        ),
                        false
                    )
                WHEN template.slug = 'announcement-sunset-with-runway'
                     AND item.value ->> 'name' = 'why_paragraph' THEN
                    jsonb_set(
                        item.value,
                        '{default}',
                        to_jsonb('The legacy API is being replaced by a version with an explicit compatibility and migration contract.'::text),
                        false
                    )
                WHEN template.slug = 'announcement-sunset-with-runway'
                     AND item.value ->> 'name' IN ('export_url', 'unsubscribe_url') THEN
                    jsonb_set(
                        item.value,
                        '{default}',
                        to_jsonb(
                            CASE item.value ->> 'name'
                                WHEN 'export_url' THEN 'https://example.invalid/export/legacy'
                                ELSE 'https://example.invalid/unsubscribe'
                            END
                        ),
                        false
                    )
                ELSE item.value
            END
            ORDER BY item.ordinality
        ) AS variables
    FROM campaign_templates AS template
    CROSS JOIN LATERAL jsonb_array_elements(template.variables)
        WITH ORDINALITY AS item(value, ordinality)
    WHERE template.tenant_id IS NULL
      AND jsonb_typeof(template.variables) = 'array'
    GROUP BY template.id
)
UPDATE campaign_templates AS template
   SET variables = rewritten.variables,
       updated_at = now()
  FROM rewritten
 WHERE template.id = rewritten.id
   AND template.variables IS DISTINCT FROM rewritten.variables;

COMMIT;
