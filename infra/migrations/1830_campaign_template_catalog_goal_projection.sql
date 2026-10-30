-- 1830_campaign_template_catalog_goal_projection.sql
--
-- Preserve the source reference's goal when a reviewed tenant import is
-- published into the shared catalog. Migration 1825 intentionally copied the
-- rest of the discovery taxonomy, but omitted goal from its platform-row
-- projection. That made the default goal=newsletter gallery hide every shared
-- newsletter even though category and the source row were correct.
--
-- The projection trigger covers both new publications and refresh upserts.
-- Existing shared rows are repaired from the exact source-template lineage
-- stamped by campaign_template_publish_reference.
--
-- rollback-strategy: no-op
-- rollback-details: the backfilled goal is canonical catalog metadata.
-- Removing it would make default goal filters hide valid shared references.

BEGIN;

CREATE FUNCTION campaign_template_project_catalog_goal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    source_id_text text;
    source_goal text;
BEGIN
    IF NEW.tenant_id IS NOT NULL OR NEW.template_kind <> 'reference' THEN
        RETURN NEW;
    END IF;

    source_id_text :=
        NULLIF(btrim(NEW.source_metadata->>'published_from_tenant_template_id'), '');
    IF source_id_text IS NULL
       OR source_id_text !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NEW;
    END IF;

    SELECT source.goal
      INTO source_goal
      FROM public.campaign_templates AS source
     WHERE source.id = source_id_text::uuid
       AND source.tenant_id IS NOT NULL
       AND source.template_kind = 'reference'
       AND source.source_provider = NEW.source_provider
       AND source.source_external_id = NEW.source_external_id;

    IF FOUND THEN
        NEW.goal := source_goal;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION campaign_template_project_catalog_goal() FROM PUBLIC;

CREATE TRIGGER campaign_templates_project_catalog_goal
    BEFORE INSERT OR UPDATE OF
        source_metadata, source_provider, source_external_id
    ON campaign_templates
    FOR EACH ROW
    WHEN (NEW.tenant_id IS NULL AND NEW.template_kind = 'reference')
    EXECUTE FUNCTION campaign_template_project_catalog_goal();

-- Repair already-published rows from their exact source lineage. The explicit
-- provider/external-id match prevents malformed or stale lineage metadata from
-- projecting taxonomy from an unrelated source row.
UPDATE campaign_templates AS platform
   SET goal = source.goal
  FROM campaign_templates AS source
 WHERE platform.tenant_id IS NULL
   AND platform.template_kind = 'reference'
   AND source.tenant_id IS NOT NULL
   AND source.id::text =
       platform.source_metadata->>'published_from_tenant_template_id'
   AND source.template_kind = 'reference'
   AND source.source_provider = platform.source_provider
   AND source.source_external_id = platform.source_external_id
   AND platform.goal IS DISTINCT FROM source.goal;

COMMENT ON FUNCTION campaign_template_project_catalog_goal() IS
    'Projects canonical goal metadata from the exact tenant reference lineage into shared catalog publication rows.';

COMMIT;
