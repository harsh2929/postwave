-- 1966_canonical_inbound_reply_convergence.sql
--
-- F05 had two product-visible reply systems:
--
--   * signed tenant-slug ingest wrote inbound_emails and the campaign UI read it;
--   * provider-authenticated reply ingest wrote campaign_replies and engagement,
--     A/B, and F01 analytics read it.
--
-- A reply could therefore be visible but absent from metrics, or counted but
-- absent from the campaign UI. This migration makes campaign_replies the one
-- reply read/analytics ledger, gives generic inbound rows an immutable one-to-
-- one link to that ledger, and moves mutable intent classification into an
-- append-only, receipt-backed revision history.
--
-- Existing exact Message-ID matches are adopted only when there is exactly one
-- possible canonical row. Every other linked legacy inbound row is materialized
-- as an honestly unclassified canonical reply; historical rows are never
-- backfilled to human_reply.
--
-- rollback-strategy: no-op (links and intent receipts are evidence; old code may
-- continue reading inbound_emails during an expand/contract rollout).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS inbound_email_campaign_reply_links (
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inbound_email_id bigint NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
    campaign_reply_id uuid NOT NULL REFERENCES campaign_replies(id) ON DELETE RESTRICT,
    link_method text NOT NULL CHECK (link_method IN (
        'transactional_projection',
        'legacy_exact_message_id',
        'legacy_materialized'
    )),
    link_contract_version text NOT NULL
        DEFAULT 'postwave.inbound-canonical-reply-link.v1'
        CHECK (link_contract_version = 'postwave.inbound-canonical-reply-link.v1'),
    link_receipt_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, inbound_email_id),
    UNIQUE (tenant_id, campaign_reply_id),
    CHECK (link_receipt_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS inbound_email_campaign_reply_links_reply_idx
    ON inbound_email_campaign_reply_links (tenant_id, campaign_reply_id);

CREATE OR REPLACE FUNCTION inbound_email_campaign_reply_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    inbound_tenant uuid;
    inbound_campaign uuid;
    inbound_from text;
    inbound_message_id text;
    reply_tenant uuid;
    reply_campaign uuid;
    reply_recipient text;
    reply_message_id text;
    reply_source text;
    reply_metadata jsonb;
    expected_receipt text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'inbound/canonical reply links are append-only'
            USING ERRCODE = '55000';
    END IF;

    SELECT tenant_id, campaign_id, lower(from_email), message_id
      INTO inbound_tenant, inbound_campaign, inbound_from, inbound_message_id
      FROM inbound_emails
     WHERE id = NEW.inbound_email_id;
    SELECT tenant_id, campaign_id, lower(recipient_email::text),
           raw_message_id, source, metadata
      INTO reply_tenant, reply_campaign, reply_recipient,
           reply_message_id, reply_source, reply_metadata
      FROM campaign_replies
     WHERE id = NEW.campaign_reply_id;

    IF inbound_tenant IS NULL OR reply_tenant IS NULL
       OR inbound_tenant <> NEW.tenant_id
       OR reply_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'inbound/canonical reply link tenant mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF inbound_campaign IS NULL
       OR reply_campaign IS NULL
       OR inbound_campaign <> reply_campaign
       OR inbound_from <> reply_recipient THEN
        RAISE EXCEPTION 'inbound/canonical reply link identity mismatch'
            USING ERRCODE = '23514';
    END IF;
    CASE NEW.link_method
        WHEN 'transactional_projection' THEN
            IF reply_source <> 'postwave-inbound'
               OR reply_metadata->>'inbound_email_id' IS DISTINCT FROM
                    NEW.inbound_email_id::text THEN
                RAISE EXCEPTION 'transactional canonical reply link provenance mismatch'
                    USING ERRCODE = '23514';
            END IF;
        WHEN 'legacy_exact_message_id' THEN
            IF NULLIF(btrim(inbound_message_id), '') IS NULL
               OR inbound_message_id IS DISTINCT FROM reply_message_id THEN
                RAISE EXCEPTION 'legacy exact canonical reply link identity mismatch'
                    USING ERRCODE = '23514';
            END IF;
        WHEN 'legacy_materialized' THEN
            IF reply_source <> 'postwave-inbound'
               OR reply_message_id <> 'legacy-inbound:' || NEW.inbound_email_id::text
               OR reply_metadata->>'legacy_inbound_email_id' IS DISTINCT FROM
                    NEW.inbound_email_id::text THEN
                RAISE EXCEPTION 'legacy materialized canonical reply link provenance mismatch'
                    USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'unknown inbound/canonical reply link method'
                USING ERRCODE = '23514';
    END CASE;

    NEW.link_contract_version := 'postwave.inbound-canonical-reply-link.v1';
    expected_receipt := encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'contract_version', NEW.link_contract_version,
                    'tenant_id', NEW.tenant_id::text,
                    'inbound_email_id', NEW.inbound_email_id,
                    'campaign_reply_id', NEW.campaign_reply_id::text,
                    'link_method', NEW.link_method
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    IF NEW.link_receipt_sha256 IS NOT NULL
       AND NEW.link_receipt_sha256 <> expected_receipt THEN
        RAISE EXCEPTION 'inbound/canonical reply link receipt mismatch'
            USING ERRCODE = '23514';
    END IF;
    NEW.link_receipt_sha256 := expected_receipt;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS inbound_email_campaign_reply_link_insert_guard
    ON inbound_email_campaign_reply_links;
CREATE TRIGGER inbound_email_campaign_reply_link_insert_guard
    BEFORE INSERT ON inbound_email_campaign_reply_links
    FOR EACH ROW EXECUTE FUNCTION inbound_email_campaign_reply_link_guard();

DROP TRIGGER IF EXISTS inbound_email_campaign_reply_link_update_guard
    ON inbound_email_campaign_reply_links;
CREATE TRIGGER inbound_email_campaign_reply_link_update_guard
    BEFORE UPDATE OR DELETE ON inbound_email_campaign_reply_links
    FOR EACH ROW EXECUTE FUNCTION inbound_email_campaign_reply_link_guard();

ALTER TABLE inbound_email_campaign_reply_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_campaign_reply_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON inbound_email_campaign_reply_links;
CREATE POLICY tenant_visible ON inbound_email_campaign_reply_links
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON inbound_email_campaign_reply_links FROM postwave_app;
GRANT SELECT, INSERT ON inbound_email_campaign_reply_links TO postwave_app;
REVOKE ALL ON FUNCTION inbound_email_campaign_reply_link_guard() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS campaign_reply_intent_classifications (
    id bigserial PRIMARY KEY,
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_reply_id uuid NOT NULL REFERENCES campaign_replies(id) ON DELETE RESTRICT,
    revision integer NOT NULL CHECK (revision > 0),
    supersedes_id bigint REFERENCES campaign_reply_intent_classifications(id)
        ON DELETE RESTRICT,
    intent_class text NOT NULL CHECK (
        intent_class IN ('question', 'praise', 'unsub', 'ooo', 'other')
    ),
    intent_confidence numeric(5,4) NOT NULL CHECK (
        intent_confidence >= 0 AND intent_confidence <= 1
    ),
    classifier text NOT NULL CHECK (
        classifier <> '' AND length(classifier) <= 128
    ),
    classifier_version text NOT NULL CHECK (
        classifier_version <> '' AND length(classifier_version) <= 160
    ),
    body_evidence_sha256 text NOT NULL CHECK (
        body_evidence_sha256 ~ '^[0-9a-f]{64}$'
    ),
    evidence_contract_version text NOT NULL
        DEFAULT 'postwave.campaign-reply-intent-evidence.v1'
        CHECK (
            evidence_contract_version =
                'postwave.campaign-reply-intent-evidence.v1'
        ),
    evidence_receipt_sha256 text NOT NULL CHECK (
        evidence_receipt_sha256 ~ '^[0-9a-f]{64}$'
    ),
    classified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, campaign_reply_id, revision),
    UNIQUE (tenant_id, supersedes_id)
);

CREATE INDEX IF NOT EXISTS campaign_reply_intent_current_idx
    ON campaign_reply_intent_classifications
        (tenant_id, campaign_reply_id, revision DESC, id DESC);

CREATE OR REPLACE FUNCTION campaign_reply_intent_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    reply_tenant uuid;
    reply_body_hash text;
    previous_id bigint;
    previous_revision integer;
    expected_receipt text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'campaign reply intent evidence is append-only'
            USING ERRCODE = '55000';
    END IF;

    -- Serialize revisions for one reply. Hash collisions only serialize two
    -- unrelated replies; they cannot merge their identities or evidence.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            NEW.tenant_id::text || ':' || NEW.campaign_reply_id::text,
            1966
        )
    );

    SELECT tenant_id, body_evidence_sha256
      INTO reply_tenant, reply_body_hash
      FROM campaign_replies
     WHERE id = NEW.campaign_reply_id;
    IF reply_tenant IS NULL OR reply_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'campaign reply intent tenant mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF reply_body_hash IS NULL THEN
        RAISE EXCEPTION 'campaign reply intent has no body evidence digest'
            USING ERRCODE = '23514';
    END IF;

    SELECT id, revision
      INTO previous_id, previous_revision
      FROM campaign_reply_intent_classifications
     WHERE tenant_id = NEW.tenant_id
       AND campaign_reply_id = NEW.campaign_reply_id
     ORDER BY revision DESC, id DESC
     LIMIT 1;

    IF NEW.revision IS NOT NULL
       AND NEW.revision <> COALESCE(previous_revision, 0) + 1 THEN
        RAISE EXCEPTION 'campaign reply intent revision mismatch'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_id IS NOT NULL
       AND NEW.supersedes_id IS DISTINCT FROM previous_id THEN
        RAISE EXCEPTION 'campaign reply intent supersedes mismatch'
            USING ERRCODE = '23514';
    END IF;

    NEW.revision := COALESCE(previous_revision, 0) + 1;
    NEW.supersedes_id := previous_id;
    NEW.body_evidence_sha256 := reply_body_hash;
    NEW.evidence_contract_version :=
        'postwave.campaign-reply-intent-evidence.v1';
    expected_receipt := encode(
        public.digest(
            convert_to(
                jsonb_build_object(
                    'contract_version', NEW.evidence_contract_version,
                    'tenant_id', NEW.tenant_id::text,
                    'campaign_reply_id', NEW.campaign_reply_id::text,
                    'revision', NEW.revision,
                    'supersedes_id', COALESCE(NEW.supersedes_id, 0),
                    'intent_class', NEW.intent_class,
                    'intent_confidence', NEW.intent_confidence,
                    'classifier', NEW.classifier,
                    'classifier_version', NEW.classifier_version,
                    'body_evidence_sha256', NEW.body_evidence_sha256,
                    'classified_at_epoch_us', floor(
                        extract(epoch FROM NEW.classified_at) * 1000000
                    )::bigint
                )::text,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    IF NEW.evidence_receipt_sha256 IS NOT NULL
       AND NEW.evidence_receipt_sha256 <> expected_receipt THEN
        RAISE EXCEPTION 'campaign reply intent evidence receipt mismatch'
            USING ERRCODE = '23514';
    END IF;
    NEW.evidence_receipt_sha256 := expected_receipt;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS campaign_reply_intent_evidence_insert_guard
    ON campaign_reply_intent_classifications;
CREATE TRIGGER campaign_reply_intent_evidence_insert_guard
    BEFORE INSERT ON campaign_reply_intent_classifications
    FOR EACH ROW EXECUTE FUNCTION campaign_reply_intent_evidence_guard();

DROP TRIGGER IF EXISTS campaign_reply_intent_evidence_update_guard
    ON campaign_reply_intent_classifications;
CREATE TRIGGER campaign_reply_intent_evidence_update_guard
    BEFORE UPDATE OR DELETE ON campaign_reply_intent_classifications
    FOR EACH ROW EXECUTE FUNCTION campaign_reply_intent_evidence_guard();

ALTER TABLE campaign_reply_intent_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_reply_intent_classifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_visible ON campaign_reply_intent_classifications;
CREATE POLICY tenant_visible ON campaign_reply_intent_classifications
    AS PERMISSIVE FOR ALL TO postwave_app
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON campaign_reply_intent_classifications FROM postwave_app;
GRANT SELECT, INSERT ON campaign_reply_intent_classifications TO postwave_app;
GRANT USAGE, SELECT ON SEQUENCE campaign_reply_intent_classifications_id_seq
    TO postwave_app;
REVOKE ALL ON FUNCTION campaign_reply_intent_evidence_guard() FROM PUBLIC;

CREATE OR REPLACE VIEW campaign_reply_intents_current_v
WITH (security_invoker = true, security_barrier = true)
AS
SELECT DISTINCT ON (tenant_id, campaign_reply_id)
       id,
       tenant_id,
       campaign_reply_id,
       revision,
       supersedes_id,
       intent_class,
       intent_confidence,
       classifier,
       classifier_version,
       body_evidence_sha256,
       evidence_contract_version,
       evidence_receipt_sha256,
       classified_at
  FROM campaign_reply_intent_classifications
 ORDER BY tenant_id, campaign_reply_id, revision DESC, id DESC;

REVOKE ALL ON campaign_reply_intents_current_v FROM PUBLIC;
GRANT SELECT ON campaign_reply_intents_current_v TO postwave_app;

-- First adopt a pre-existing canonical row only when exact immutable envelope
-- facts yield one and only one candidate. Ambiguity remains unlinked and falls
-- through to an independent, honestly unclassified materialization below.
INSERT INTO inbound_email_campaign_reply_links (
    tenant_id,
    inbound_email_id,
    campaign_reply_id,
    link_method
)
SELECT candidate.tenant_id,
       candidate.inbound_email_id,
       candidate.campaign_reply_id,
       'legacy_exact_message_id'
  FROM (
      SELECT e.tenant_id,
             e.id AS inbound_email_id,
             min(r.id::text)::uuid AS campaign_reply_id,
             count(*) AS candidate_count
        FROM inbound_emails e
        JOIN campaign_replies r
          ON r.tenant_id = e.tenant_id
         AND r.campaign_id = e.campaign_id
         AND lower(r.recipient_email::text) = lower(e.from_email)
         AND r.raw_message_id = e.message_id
       WHERE e.campaign_id IS NOT NULL
         AND NULLIF(btrim(e.message_id), '') IS NOT NULL
       GROUP BY e.tenant_id, e.id
  ) AS candidate
 WHERE candidate.candidate_count = 1
ON CONFLICT DO NOTHING;

-- Materialize every remaining campaign-linked legacy inbound row in bounded
-- batches. The synthetic raw id is stable and names the source ledger row; it
-- does not pretend to be an RFC Message-ID.
DO $legacy_backfill$
DECLARE
    rows_linked integer;
BEGIN
    LOOP
        WITH batch AS (
            SELECT e.*
              FROM inbound_emails e
             WHERE e.campaign_id IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1
                     FROM inbound_email_campaign_reply_links link
                    WHERE link.tenant_id = e.tenant_id
                      AND link.inbound_email_id = e.id
               )
             ORDER BY e.tenant_id, e.id
             LIMIT 1000
        ), inserted AS (
            INSERT INTO campaign_replies (
                tenant_id,
                campaign_id,
                subscriber_id,
                recipient_email,
                in_reply_to,
                subject,
                body_snippet,
                body_stripped,
                raw_message_id,
                source,
                received_at,
                metadata,
                classification,
                classified_at
            )
            SELECT tenant_id,
                   campaign_id,
                   subscriber_id,
                   from_email::citext,
                   NULLIF(in_reply_to, ''),
                   NULLIF(subject, ''),
                   NULLIF(left(body_text, 500), ''),
                   NULLIF(left(body_text, 65536), ''),
                   'legacy-inbound:' || id::text,
                   'postwave-inbound',
                   received_at,
                   jsonb_build_object(
                       'ingest_path', 'legacy_inbound_email_backfill',
                       'legacy_inbound_email_id', id
                   ),
                   NULL,
                   NULL
              FROM batch
            ON CONFLICT (tenant_id, source, raw_message_id)
                WHERE raw_message_id IS NOT NULL
            DO NOTHING
            RETURNING tenant_id, id, raw_message_id
        ), canonical AS (
            -- Rows inserted by a data-modifying CTE are visible through its
            -- RETURNING relation, not by rescanning the base table in the same
            -- statement. Pre-existing exact synthetic identities remain
            -- visible through the second branch.
            SELECT inserted.tenant_id,
                   inserted.id,
                   inserted.raw_message_id
              FROM inserted
            UNION ALL
            SELECT reply.tenant_id,
                   reply.id,
                   reply.raw_message_id
              FROM campaign_replies reply
              JOIN batch
                ON reply.tenant_id = batch.tenant_id
               AND reply.source = 'postwave-inbound'
               AND reply.raw_message_id = 'legacy-inbound:' || batch.id::text
             WHERE NOT EXISTS (
                 SELECT 1
                   FROM inserted
                  WHERE inserted.tenant_id = reply.tenant_id
                    AND inserted.raw_message_id = reply.raw_message_id
             )
        )
        INSERT INTO inbound_email_campaign_reply_links (
            tenant_id,
            inbound_email_id,
            campaign_reply_id,
            link_method
        )
        SELECT batch.tenant_id,
               batch.id,
               reply.id,
               'legacy_materialized'
          FROM batch
          JOIN canonical reply
            ON reply.tenant_id = batch.tenant_id
           AND reply.raw_message_id = 'legacy-inbound:' || batch.id::text
        ON CONFLICT DO NOTHING;

        GET DIAGNOSTICS rows_linked = ROW_COUNT;
        EXIT WHEN rows_linked = 0;
    END LOOP;
END
$legacy_backfill$;

-- Preserve prior intent facts as revision 1 on their newly canonical reply.
-- The evidence trigger binds each migrated result to the canonical body digest.
INSERT INTO campaign_reply_intent_classifications (
    tenant_id,
    campaign_reply_id,
    intent_class,
    intent_confidence,
    classifier,
    classifier_version,
    classified_at
)
SELECT intent.tenant_id,
       link.campaign_reply_id,
       intent.intent_class,
       intent.intent_confidence,
       intent.classifier,
       'legacy.inbound-email-intent.v1',
       intent.classified_at
  FROM inbound_email_intent intent
  JOIN inbound_email_campaign_reply_links link
    ON link.tenant_id = intent.tenant_id
   AND link.inbound_email_id = intent.inbound_email_id
  JOIN campaign_replies reply
    ON reply.id = link.campaign_reply_id
 WHERE NOT EXISTS (
     SELECT 1
       FROM campaign_reply_intent_classifications current
      WHERE current.tenant_id = intent.tenant_id
        AND current.campaign_reply_id = link.campaign_reply_id
 );
