-- Route42: preserve operator SMS holds beneath carrier/system STOP authority.
--
-- Historical non-manual rows cannot prove whether an older one-row upsert
-- replaced a manual hold. They therefore start as legacy_unknown and remain
-- fail-closed on provider START until a reviewed reconciliation. Manual rows
-- are provable and start with no overlay. A new binary writes `none` for a
-- fresh STOP and `preserved` when overlaying an operator hold. Manual metadata
-- is deliberately not copied because it is not gate authority and may contain
-- arbitrary legacy PII. Any collision between independent active authorities is
-- promoted to legacy_unknown and review-held; one row cannot safely encode a
-- stack of provider/operator authorities. The trigger supplies the same
-- protection to an old binary.
--
-- Deployment order: schema first, then the new binary. Old binaries remain
-- compatible: old manual/fresh-STOP INSERTs are normalized to `none`; old STOP
-- upserts preserve manual state or promote authority collisions; and old
-- START DELETEs cannot remove preserved/ambiguous rows. A new binary against an old schema
-- fails its overlay-column statement transactionally and must
-- not be deployed before this migration.
--
-- rollback-strategy: expand-contract
-- rollback-details: Leave the additive columns/triggers in place and roll the application back; old writers are protected by the trigger and delete guard. Do not remove provenance until every legacy_unknown row has a reviewed disposition.

-- Add nullable with no default so the migration can distinguish historical
-- rows from writes that occur after the contract. The ALTER lock and the
-- runner's transaction prevent an old-binary INSERT from slipping between the
-- backfill and DEFAULT/NOT NULL adoption.
ALTER TABLE sms_suppressions
  ADD COLUMN manual_overlay_state text;

-- A manual/manual row is itself the hold, so its provenance is known. Do not
-- guess for any non-manual historical row: old code may have overwritten a
-- manual row without leaving an immutable audit event.
UPDATE sms_suppressions
   SET manual_overlay_state = CASE
         WHEN reason = 'manual' AND source = 'manual' THEN 'none'
         ELSE 'legacy_unknown'
       END,
       -- An expired historical system row may already have overwritten a
       -- permanent manual hold. Ambiguity must remain an active gate, never an
       -- expired marker that list/send readers ignore.
       expires_at = CASE
         WHEN reason = 'manual' AND source = 'manual' THEN expires_at
         ELSE NULL
       END;

ALTER TABLE sms_suppressions
  ALTER COLUMN manual_overlay_state SET DEFAULT 'none',
  ALTER COLUMN manual_overlay_state SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sms_suppression_preserve_manual_overlay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Omitted by an old writer means the post-backfill default `none`. Preserve
    -- an explicit valid legacy_unknown marker used by a reviewed historical
    -- import/reconciliation; never silently downgrade it.
    IF NEW.manual_overlay_state = 'legacy_unknown' THEN
      NEW.expires_at := NULL;
    END IF;
    IF NEW.reason = 'manual' AND NEW.source = 'manual' THEN
      NEW.manual_overlay_state := 'none';
      NEW.source_event_id := NULL;
      NEW.expires_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.reason = 'manual' AND NEW.source = 'manual' THEN
    -- The only runtime transition into manual/manual is restoration of a
    -- preserved operator hold (or a reviewed legacy reconciliation). Never
    -- leave a hidden second underlay beneath a manual row.
    IF OLD.manual_overlay_state = 'preserved' THEN
      -- Metadata is not part of suppression gate authority and may contain
      -- arbitrary legacy PII. Restore only the manual safety state, never a
      -- copied metadata blob.
      NEW.metadata := '{}'::jsonb;
    END IF;
    NEW.manual_overlay_state := 'none';
    NEW.source_event_id := NULL;
    NEW.expires_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.reason = 'manual' AND OLD.source = 'manual' THEN
    -- Covers both the new upsert and a mixed-version old writer that knows
    -- nothing about the overlay columns.
    NEW.manual_overlay_state := 'preserved';
    NEW.expires_at := NULL;
    RETURN NEW;
  END IF;

  IF OLD.manual_overlay_state = 'legacy_unknown' OR NEW.manual_overlay_state = 'legacy_unknown' THEN
    -- Historical/collision ambiguity is sticky and active. It wins even when
    -- an old outer row carried an expiry; otherwise expiry replacement would
    -- silently reopen a possibly preserved manual hold.
    NEW.manual_overlay_state := 'legacy_unknown';
    NEW.expires_at := NULL;
  ELSIF OLD.expires_at IS NOT NULL AND OLD.expires_at <= clock_timestamp() THEN
    -- An expired authority is inactive and can be replaced by one fresh outer
    -- authority without retaining an ambiguity hold.
    NEW.manual_overlay_state := 'none';
    RETURN NEW;
  ELSIF OLD.reason <> NEW.reason OR OLD.source <> NEW.source THEN
    -- One row cannot represent two independent active authorities. Fail closed
    -- instead of letting the later STOP erase the earlier one. In particular,
    -- a preserved manual hold cannot survive a different outer authority as
    -- merely `preserved`: START would restore a reversible manual row while
    -- discarding that newer independent authority.
    NEW.manual_overlay_state := 'legacy_unknown';
    NEW.expires_at := NULL;
  ELSE
    -- Same-authority replay may refresh outer evidence but cannot downgrade a
    -- preserved marker supplied by an earlier manual -> system transition.
    NEW.manual_overlay_state := OLD.manual_overlay_state;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sms_suppression_preserve_manual_overlay() FROM PUBLIC;

DROP TRIGGER IF EXISTS sms_suppression_preserve_manual_overlay_trg ON sms_suppressions;
CREATE TRIGGER sms_suppression_preserve_manual_overlay_trg
BEFORE INSERT OR UPDATE ON sms_suppressions
FOR EACH ROW EXECUTE FUNCTION public.sms_suppression_preserve_manual_overlay();

CREATE OR REPLACE FUNCTION public.sms_suppression_guard_ambiguous_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  -- A tenant deletion reaches this trigger from an FK cascade after the parent
  -- row is gone. Do not turn a compliance preservation rule into a
  -- tenant-erasure blocker, but do not treat arbitrary nested triggers as FK
  -- authority: the referenced parent must actually be absent in this
  -- transaction. Parent absence also supports reviewed admin/control-plane
  -- cascades which deliberately do not carry an app.tenant_id GUC.
  IF pg_trigger_depth() > 1
     AND NOT EXISTS (
       SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
     ) THEN
    RETURN OLD;
  END IF;
  IF OLD.manual_overlay_state IN ('preserved', 'legacy_unknown') THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION public.sms_suppression_guard_ambiguous_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS sms_suppression_guard_ambiguous_delete_trg ON sms_suppressions;
CREATE TRIGGER sms_suppression_guard_ambiguous_delete_trg
BEFORE DELETE ON sms_suppressions
FOR EACH ROW EXECUTE FUNCTION public.sms_suppression_guard_ambiguous_delete();

-- Policy PATCH/DELETE use updated_at as a client-observed compare-and-swap
-- token. The shared legacy set_updated_at() trigger assigns transaction-start
-- now(), which is not guaranteed to advance beyond a row written in the same
-- clock tick. Give these two Route42 policy tables a monotonic microsecond
-- version so every successful write invalidates every older client token,
-- including writes from a mixed-version old binary.
CREATE OR REPLACE FUNCTION public.sms_policy_set_updated_at_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sms_policy_set_updated_at_monotonic() FROM PUBLIC;

DROP TRIGGER IF EXISTS sms_quiet_hours_set_updated_at ON sms_quiet_hours;
CREATE TRIGGER sms_quiet_hours_set_updated_at
BEFORE UPDATE ON sms_quiet_hours
FOR EACH ROW EXECUTE FUNCTION public.sms_policy_set_updated_at_monotonic();

DROP TRIGGER IF EXISTS sms_keyword_responses_set_updated_at ON sms_keyword_responses;
CREATE TRIGGER sms_keyword_responses_set_updated_at
BEFORE UPDATE ON sms_keyword_responses
FOR EACH ROW EXECUTE FUNCTION public.sms_policy_set_updated_at_monotonic();

-- Historical country-scoped quiet-hours rows are preserved for operator
-- reconciliation, but NANP identity cannot prove US-versus-CA jurisdiction.
-- Every post-migration writer rejects new scoped state, and no historical
-- scoped row may transition into an enabled tenant-global hold. The Route42
-- handler/Store boundary additionally requires explicit disable-and-clear
-- intent for both enabled and disabled historical rows; SQL cannot distinguish
-- an omitted enabled column from explicitly assigning its existing false value.
CREATE OR REPLACE FUNCTION public.sms_quiet_hours_country_scope_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.country_code <> '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'country-scoped quiet-hours writes are release-held',
      CONSTRAINT = 'sms_quiet_hours_country_scope_write_guard';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.country_code <> '' AND NEW.enabled THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'enabled historical country-scoped quiet-hours rules must be atomically disabled and cleared',
      CONSTRAINT = 'sms_quiet_hours_country_scope_write_guard';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sms_quiet_hours_country_scope_write_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS sms_quiet_hours_country_scope_write_guard_trg ON sms_quiet_hours;
CREATE TRIGGER sms_quiet_hours_country_scope_write_guard_trg
BEFORE INSERT OR UPDATE ON sms_quiet_hours
FOR EACH ROW EXECUTE FUNCTION public.sms_quiet_hours_country_scope_write_guard();

ALTER TABLE sms_suppressions
  ADD CONSTRAINT sms_suppressions_manual_overlay_check CHECK (
    CASE manual_overlay_state
      WHEN 'none' THEN true
      WHEN 'preserved' THEN
        NOT (reason = 'manual' AND source = 'manual') AND
        expires_at IS NULL
      WHEN 'legacy_unknown' THEN
        NOT (reason = 'manual' AND source = 'manual') AND
        expires_at IS NULL
      ELSE false
    END
  ) NOT VALID;

-- Route40 accidentally tied a tenant's availability to the UUIDv4 convention
-- used for new row IDs. tenant_id is already a non-null PostgreSQL uuid with a
-- validated FK to tenants(id), which is the correct canonical/ownership
-- contract for legacy UUID versions. Row IDs remain strict RFC4122 UUIDv4.
-- Replace the validated check atomically: NOT VALID still constrains every new
-- write, and the count-only preflight/validation below rolls the whole file
-- back on historical poison.
ALTER TABLE sms_suppressions
  DROP CONSTRAINT sms_suppressions_private_projection_check;
ALTER TABLE sms_suppressions
  ADD CONSTRAINT sms_suppressions_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND tenant_id IS NOT NULL AND
    phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
    (phone IS NULL OR phone = phone_e164) AND
    (source_event_id IS NULL OR (length(source_event_id) BETWEEN 1 AND 256 AND source_event_id ~ '^[A-Za-z0-9_.:-]+$')) AND
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192 AND
    public.sms_timestamp_valid(created_at) AND
    (expires_at IS NULL OR public.sms_timestamp_valid(expires_at))
  ) NOT VALID;

-- The same exact-admin Route42 surface reads and mutates the adjacent policy
-- tables. Keep their tenant availability contract consistent with
-- sms_suppressions: PostgreSQL uuid + non-null validated tenant FK, while the
-- policy row IDs stay UUIDv4.
ALTER TABLE sms_quiet_hours
  DROP CONSTRAINT sms_quiet_hours_private_projection_check;
ALTER TABLE sms_quiet_hours
  ADD CONSTRAINT sms_quiet_hours_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND tenant_id IS NOT NULL AND
    public.sms_contract_text_valid(label, 128, 512, true, false) AND
    country_code IN ('','US','CA') AND
    start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439 AND
    public.sms_weekdays_valid(days) AND
    public.sms_contract_text_valid(timezone, 128, 512, false, true) AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

ALTER TABLE sms_keyword_responses
  DROP CONSTRAINT sms_keyword_responses_private_projection_check;
ALTER TABLE sms_keyword_responses
  ADD CONSTRAINT sms_keyword_responses_private_projection_check CHECK (
    public.sms_uuid_v4_valid(id) AND tenant_id IS NOT NULL AND
    char_length(keyword) BETWEEN 1 AND 80 AND octet_length(keyword) <= 320 AND
    keyword = upper(btrim(keyword)) AND keyword ~ '^[A-Z0-9_.:-]+$' AND
    keyword NOT IN ('STOP','STOPALL','UNSUBSCRIBE','END','QUIT','REVOKE','OPTOUT','CANCEL','START','UNSTOP','HELP') AND
    octet_length(response_body) <= 16384 AND char_length(response_body) <= 4800 AND response_body ~ '[^[:space:]]' AND
    action IN ('reply_only','opt_out') AND
    public.sms_timestamp_valid(created_at) AND public.sms_timestamp_valid(updated_at) AND updated_at >= created_at
  ) NOT VALID;

DO $$
DECLARE
  invalid_overlay_count bigint;
  invalid_projection_count bigint;
BEGIN
  SELECT count(*) INTO invalid_overlay_count
    FROM sms_suppressions
   WHERE NOT (
     CASE manual_overlay_state
       WHEN 'none' THEN true
       WHEN 'preserved' THEN
         NOT (reason = 'manual' AND source = 'manual') AND
         expires_at IS NULL
       WHEN 'legacy_unknown' THEN
         NOT (reason = 'manual' AND source = 'manual') AND
         expires_at IS NULL
       ELSE false
     END
   );
  SELECT count(*) INTO invalid_projection_count
    FROM sms_suppressions
   WHERE NOT (
     public.sms_uuid_v4_valid(id) AND tenant_id IS NOT NULL AND
     phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' AND
     (phone IS NULL OR phone = phone_e164) AND
     (source_event_id IS NULL OR (length(source_event_id) BETWEEN 1 AND 256 AND source_event_id ~ '^[A-Za-z0-9_.:-]+$')) AND
     jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 8192 AND
     public.sms_timestamp_valid(created_at) AND
     (expires_at IS NULL OR public.sms_timestamp_valid(expires_at))
   );
  IF invalid_overlay_count > 0 OR invalid_projection_count > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Route42 SMS suppression overlay historical preflight failed',
      DETAIL = jsonb_build_object(
        'invalid_overlay_count', invalid_overlay_count,
        'invalid_projection_count', invalid_projection_count
      )::text;
  END IF;
END
$$;

ALTER TABLE sms_suppressions
  VALIDATE CONSTRAINT sms_suppressions_manual_overlay_check;
ALTER TABLE sms_suppressions
  VALIDATE CONSTRAINT sms_suppressions_private_projection_check;
ALTER TABLE sms_quiet_hours
  VALIDATE CONSTRAINT sms_quiet_hours_private_projection_check;
ALTER TABLE sms_keyword_responses
  VALIDATE CONSTRAINT sms_keyword_responses_private_projection_check;
