-- 1835_campaign_template_revision_actor.sql
--
-- TMPL-040 — record WHO made each edit in the template revision trail. The
-- append trigger (migration 1824) captured version/transition/when but not the
-- actor. The application sets a per-transaction GUC `app.actor_user_id` before
-- an authoring write; this trigger reads it into changed_by_user_id so the
-- history answers "who/when", not just "when".
-- migration-execution: phased
-- rollback-strategy: expand-contract
-- rollback-details: The column is additive (NULL for pre-existing rows and any
-- write that did not set the GUC). Reverting the trigger to the 1824 body is
-- safe; the column can remain.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE campaign_template_revisions
    ADD COLUMN IF NOT EXISTS changed_by_user_id uuid;

CREATE OR REPLACE FUNCTION campaign_template_append_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    lifecycle_transition text;
    actor uuid;
BEGIN
    IF NEW.tenant_id IS NULL OR NEW.template_kind <> 'editable' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        lifecycle_transition := 'create';
    ELSIF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
        lifecycle_transition := 'archive';
    ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
        lifecycle_transition := 'restore';
    ELSE
        lifecycle_transition := 'update';
    END IF;

    -- Best-effort actor: the app sets app.actor_user_id before authoring
    -- writes. A malformed/absent value simply yields NULL (history still
    -- records when + what), never an error.
    BEGIN
        actor := NULLIF(current_setting('app.actor_user_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
        actor := NULL;
    END;

    INSERT INTO public.campaign_template_revisions
        (tenant_id, template_id, version, transition, snapshot, archived_at,
         changed_by_user_id)
    VALUES
        (NEW.tenant_id, NEW.id, NEW.version, lifecycle_transition,
         to_jsonb(NEW), NEW.archived_at, actor);
    RETURN NEW;
END;
$function$;

COMMIT;
