-- 1876_refuse_segment_delete_with_sendable_campaigns.sql
--
-- Deleting a segment must not silently retarget a campaign at everyone.
--
-- `campaigns_tenant_segment_fk` is `ON DELETE SET NULL (segment_id)`. Deleting
-- a segment therefore nulls the column on every campaign using it, and
-- `ResolveCampaignAudience`'s default branch treats "no list, no segment" as
-- WORKSPACE-WIDE — every enabled subscriber. So `DELETE /api/v1/segments/{id}`
-- converts a targeted campaign into a company-wide blast, silently, with no
-- state change anyone can see on the campaign itself.
--
-- WHY A TRIGGER AND NOT `ON DELETE RESTRICT`. A blanket RESTRICT would forbid
-- deleting a segment that any campaign has EVER referenced, including ones sent
-- two years ago whose reference is purely historical. That makes old segments
-- undeletable forever, and a rule people cannot satisfy is one they work around
-- — here by clearing `segment_id` on the campaign first, which reintroduces the
-- exact silent retarget this exists to stop.
--
-- The trigger refuses only when a campaign could STILL SEND: not yet dispatched
-- (`started_at IS NULL AND status NOT IN ('sending','sent')`), which is the same
-- predicate `campaigndispatch.EditablePredicate` uses so the two cannot drift
-- about what "not yet sent" means. For an already-sent campaign the FK's SET
-- NULL still applies and changes nothing about who received it.
--
-- The message names the campaigns, because "cannot delete" without saying what
-- is holding the reference is an error someone has to go and investigate.

BEGIN;

CREATE OR REPLACE FUNCTION refuse_segment_delete_with_sendable_campaigns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    blocking text;
    blocking_count int;
BEGIN
    SELECT count(*), string_agg(name, ', ' ORDER BY name)
      INTO blocking_count, blocking
      FROM (
        SELECT c.name
          FROM campaigns c
         WHERE c.tenant_id = OLD.tenant_id
           AND c.segment_id = OLD.id
           AND c.started_at IS NULL
           AND c.status NOT IN ('sending', 'sent')
         LIMIT 5
      ) AS pending;

    IF blocking_count > 0 THEN
        RAISE EXCEPTION
            'segment is the audience of % campaign(s) that have not sent yet (%). '
            'Deleting it would retarget them at every subscriber. Point those '
            'campaigns at another audience first.',
            blocking_count, blocking
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS segments_refuse_delete_with_sendable_campaigns ON segments;
CREATE TRIGGER segments_refuse_delete_with_sendable_campaigns
    BEFORE DELETE ON segments
    FOR EACH ROW
    EXECUTE FUNCTION refuse_segment_delete_with_sendable_campaigns();

COMMENT ON FUNCTION refuse_segment_delete_with_sendable_campaigns() IS
    'Refuses deleting a segment while an un-sent campaign targets it. The FK is '
    'ON DELETE SET NULL, and a NULL segment_id resolves to the whole workspace, '
    'so without this a segment deletion silently converts targeted campaigns '
    'into company-wide sends.';

COMMIT;
