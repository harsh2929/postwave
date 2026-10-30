-- 1970_coupon_allocation_safety.sql
--
-- Prerequisites for un-gating coupon allocation
-- (apps/api/internal/discounts, CouponAllocationAvailable).
--
-- WHAT THIS DOES NOT DO
-- It does not un-gate anything. `CouponAllocationAvailable` stays false. This
-- migration builds the four containment prerequisites that are CODE, so the
-- remaining certification is about facts a test cannot establish (who is
-- contractually allowed to mint codes in the merchant system) rather than about
-- machinery nobody has written yet. See
-- apps/api/internal/discounts/coupon_allocation_certification.go.
--
-- 1. RESERVATION EXPIRY / RELEASE
-- A coupon code moved to 'reserved' and never resolved is inventory destroyed
-- twice over: the recipient never got a usable code, and no one else can ever be
-- given that one. Nothing in 0200 ever looked at `reserved_until` again — it was
-- written and never read. The Go sweeper added alongside this migration reads it,
-- and this migration adds the pool-level ceiling (`max_reservation_ttl_seconds`)
-- that stops a caller from parking inventory for a decade with a single large
-- `reservation_ttl_seconds`.
--
-- 2. DURABLE ENTITLEMENT AUDITING
-- `coupon_entitlement_events` records every status transition of every code and
-- every assignment: who got what, when, under whose actor label, and why. It is
-- written BY THE DATABASE from triggers on coupon_codes and coupon_assignments,
-- which is the whole point — a code path that forgets to write the receipt cannot
-- exist, because no code path writes the receipt. A discount is money; "we think
-- we sent them a code" is not an answer to a chargeback.
--
-- The ledger is append-only in three independent ways, because one is a comment
-- and three are a property:
--   (a) UPDATE/DELETE/TRUNCATE are revoked from postwave_app;
--   (b) a BEFORE UPDATE OR DELETE trigger RAISES — this also binds the table
--       owner and any superuser statement, which privileges alone do not;
--   (c) INSERT is refused unless `app.coupon_ledger_writer` is bound, and only
--       the two transition triggers bind it (for the duration of their own
--       INSERT). postwave_app holds the INSERT privilege only so those triggers
--       can run as the invoking role; it cannot use it directly.
-- Deliberately NOT SECURITY DEFINER: a definer owned by the table owner reads
-- coupon_codes under FORCE RLS with no policy naming its role, which returns
-- zero rows and would silently write a receipt with a blank code. Running as the
-- caller keeps the tenant-scoped policies working exactly as they do everywhere
-- else.
--
-- Deletion is permitted in exactly one situation: a cascade from the tenant row
-- (`pg_trigger_depth() > 1`, i.e. we are nested inside the RI trigger of the only
-- foreign key this table has). A direct DELETE — including one issued by a
-- superuser — RAISES. The tenant check is deliberately NOT written as
-- `NOT EXISTS (SELECT 1 FROM tenants ...)`: `tenants` carries a resolver-only
-- SELECT policy, so outside the resolver scope that subquery returns no rows and
-- the guard would read "tenant is gone, deletion allowed" for every caller. RLS
-- filters; it does not refuse. A guard must not be built on a predicate that
-- fails open.
--
-- 3. ABUSE CONTROLS
-- `max_codes_per_subscriber` and `max_codes_per_campaign` on coupon_pools bound
-- how much of a pool one recipient and one sending scope can draw. The existing
-- partial unique indexes on coupon_assignments already dedup a replay that reuses
-- the same context_key; they do nothing about a loop that varies it, which is the
-- shape that drains a pool. Enforced by a BEFORE INSERT trigger, not only in Go:
-- the allocator is not the only writer, and the first sign of an unbounded draw
-- is a finance report. The trigger takes the pool row FOR UPDATE so the bound is
-- atomic rather than a count that two concurrent inserts both pass.
--
-- 4. RECONCILIATION
-- Reconciliation is Go-side and read-only (it runs in a READ ONLY transaction so
-- that "silently correct the drift" is not expressible). This migration only
-- supplies the ledger it reconciles against.
--
-- rollback-strategy: expand-contract
-- rollback-details: additive only — new table, new columns with defaults, new
-- triggers. To revert, drop the four triggers and the new table in a separately
-- reviewed migration; the coupon_pools columns are inert once unread. Do not
-- drop coupon_entitlement_events while any allocation has occurred: it is the
-- evidence for chargebacks against codes already in the world.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 3. Abuse-control bounds + reservation ceiling, on the pool.
-- ---------------------------------------------------------------------------

ALTER TABLE coupon_pools
    ADD COLUMN max_codes_per_subscriber integer NOT NULL DEFAULT 1,
    ADD COLUMN max_codes_per_campaign integer NOT NULL DEFAULT 10000,
    ADD COLUMN max_reservation_ttl_seconds integer NOT NULL DEFAULT 86400;

ALTER TABLE coupon_pools
    ADD CONSTRAINT coupon_pools_max_codes_per_subscriber_ck
        CHECK (max_codes_per_subscriber > 0 AND max_codes_per_subscriber <= 1000),
    ADD CONSTRAINT coupon_pools_max_codes_per_campaign_ck
        CHECK (max_codes_per_campaign > 0 AND max_codes_per_campaign <= 10000000),
    ADD CONSTRAINT coupon_pools_max_reservation_ttl_ck
        CHECK (max_reservation_ttl_seconds >= 60 AND max_reservation_ttl_seconds <= 2592000);

COMMENT ON COLUMN coupon_pools.max_codes_per_subscriber IS
    'Blast-radius bound: how many live (reserved|assigned|redeemed) codes one subscriber may hold from this pool. Enforced by coupon_assignment_quota_guard().';
COMMENT ON COLUMN coupon_pools.max_codes_per_campaign IS
    'Blast-radius bound: how many live codes one sending scope (campaign_id when set, else context_key) may draw from this pool. Not a business limit; raise it deliberately for a large send.';
COMMENT ON COLUMN coupon_pools.max_reservation_ttl_seconds IS
    'Ceiling on reservation_ttl_seconds. A reservation is inventory withheld from everyone else; an unbounded TTL is inventory destroyed.';

-- ---------------------------------------------------------------------------
-- 2. Durable entitlement ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE coupon_entitlement_events (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    pool_id           uuid NOT NULL,
    subject_kind      text NOT NULL CHECK (subject_kind IN ('code', 'assignment')),
    code_id           uuid,
    assignment_id     uuid,
    code              text NOT NULL DEFAULT '',
    from_status       text CHECK (from_status IS NULL OR from_status IN (
                          'available', 'reserved', 'assigned', 'redeemed',
                          'expired', 'disabled', 'released'
                      )),
    to_status         text NOT NULL CHECK (to_status IN (
                          'available', 'reserved', 'assigned', 'redeemed',
                          'expired', 'disabled', 'released'
                      )),
    subscriber_id     uuid,
    subscriber_email  text NOT NULL DEFAULT '',
    context_key       text NOT NULL DEFAULT '',
    render_key        text NOT NULL DEFAULT '',
    campaign_id       uuid,
    actor             text NOT NULL DEFAULT 'unattributed',
    reason            text NOT NULL DEFAULT '',
    reserved_until    timestamptz,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coupon_entitlement_events_subject_ck CHECK (
        (subject_kind = 'code' AND code_id IS NOT NULL)
        OR (subject_kind = 'assignment' AND assignment_id IS NOT NULL)
    )
);

CREATE INDEX coupon_entitlement_events_pool_idx
    ON coupon_entitlement_events (tenant_id, pool_id, occurred_at DESC, id DESC);

CREATE INDEX coupon_entitlement_events_assignment_idx
    ON coupon_entitlement_events (tenant_id, assignment_id, id)
    WHERE assignment_id IS NOT NULL;

CREATE INDEX coupon_entitlement_events_code_idx
    ON coupon_entitlement_events (tenant_id, code_id, id)
    WHERE code_id IS NOT NULL;

CREATE INDEX coupon_entitlement_events_subscriber_idx
    ON coupon_entitlement_events (tenant_id, pool_id, lower(subscriber_email), id)
    WHERE subscriber_email <> '';

COMMENT ON TABLE coupon_entitlement_events IS
    'Append-only, database-generated receipt for every coupon code and coupon assignment status transition. The evidence a chargeback is answered with.';

-- The receipt is written by the transition triggers only. postwave_app holds
-- INSERT solely so those triggers can execute as the invoking role; this guard
-- makes the privilege unusable outside them.
CREATE FUNCTION coupon_entitlement_events_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF current_setting('app.coupon_ledger_writer', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION
                'coupon entitlement receipts are written by the coupon transition triggers, not by callers'
                USING ERRCODE = 'PWL01';
        END IF;
        RETURN NEW;
    END IF;

    -- The only foreign key on this table is tenant_id. A cascade from a deleted
    -- tenant reaches us nested inside that RI trigger, so pg_trigger_depth() > 1.
    -- A direct DELETE (superuser included) is depth 1 and is refused.
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    RAISE EXCEPTION 'coupon entitlement receipts are append-only'
        USING ERRCODE = 'PWL02';
END;
$fn$;

REVOKE ALL ON FUNCTION coupon_entitlement_events_write_guard() FROM PUBLIC;

CREATE TRIGGER coupon_entitlement_events_write_guard
    BEFORE INSERT OR UPDATE OR DELETE ON coupon_entitlement_events
    FOR EACH ROW EXECUTE FUNCTION coupon_entitlement_events_write_guard();

CREATE FUNCTION coupon_entitlement_event_from_code()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    previous_status text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
            RETURN NULL;
        END IF;
        previous_status := OLD.status;
    ELSE
        -- Importing inventory entitles nobody. Only a code that arrives already
        -- spoken for (the generated-pool path inserts 'reserved'/'assigned')
        -- starts a receipt trail.
        IF NEW.status = 'available' THEN
            RETURN NULL;
        END IF;
        previous_status := NULL;
    END IF;

    PERFORM set_config('app.coupon_ledger_writer', 'true', true);
    INSERT INTO public.coupon_entitlement_events (
        tenant_id, pool_id, subject_kind, code_id, code,
        from_status, to_status, subscriber_id, subscriber_email,
        context_key, actor, reason, reserved_until
    ) VALUES (
        NEW.tenant_id, NEW.pool_id, 'code', NEW.id, NEW.code,
        previous_status, NEW.status, NEW.subscriber_id, NEW.subscriber_email,
        NEW.context_key,
        COALESCE(NULLIF(current_setting('app.coupon_actor', true), ''), 'unattributed'),
        COALESCE(NULLIF(current_setting('app.coupon_transition_reason', true), ''), ''),
        NEW.reserved_until
    );
    PERFORM set_config('app.coupon_ledger_writer', '', true);
    RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION coupon_entitlement_event_from_code() FROM PUBLIC;

CREATE TRIGGER coupon_codes_entitlement_receipt
    AFTER INSERT OR UPDATE ON coupon_codes
    FOR EACH ROW EXECUTE FUNCTION coupon_entitlement_event_from_code();

CREATE FUNCTION coupon_entitlement_event_from_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    previous_status text;
    issued_code     text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
            RETURN NULL;
        END IF;
        previous_status := OLD.status;
    ELSE
        previous_status := NULL;
    END IF;

    issued_code := NEW.static_code;
    IF NEW.code_id IS NOT NULL THEN
        SELECT c.code INTO issued_code
          FROM public.coupon_codes c
         WHERE c.tenant_id = NEW.tenant_id
           AND c.id = NEW.code_id;
    END IF;

    PERFORM set_config('app.coupon_ledger_writer', 'true', true);
    INSERT INTO public.coupon_entitlement_events (
        tenant_id, pool_id, subject_kind, code_id, assignment_id, code,
        from_status, to_status, subscriber_id, subscriber_email,
        context_key, render_key, campaign_id, actor, reason, reserved_until
    ) VALUES (
        NEW.tenant_id, NEW.pool_id, 'assignment', NEW.code_id, NEW.id,
        COALESCE(issued_code, ''),
        previous_status, NEW.status, NEW.subscriber_id, NEW.subscriber_email,
        NEW.context_key, NEW.render_key, NEW.campaign_id,
        COALESCE(NULLIF(current_setting('app.coupon_actor', true), ''), 'unattributed'),
        COALESCE(NULLIF(current_setting('app.coupon_transition_reason', true), ''), ''),
        NEW.reserved_until
    );
    PERFORM set_config('app.coupon_ledger_writer', '', true);
    RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION coupon_entitlement_event_from_assignment() FROM PUBLIC;

CREATE TRIGGER coupon_assignments_entitlement_receipt
    AFTER INSERT OR UPDATE ON coupon_assignments
    FOR EACH ROW EXECUTE FUNCTION coupon_entitlement_event_from_assignment();

ALTER TABLE coupon_entitlement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_entitlement_events FORCE ROW LEVEL SECURITY;

CREATE POLICY coupon_entitlement_events_scope_boundary ON coupon_entitlement_events
    AS RESTRICTIVE FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY coupon_entitlement_events_tenant_select ON coupon_entitlement_events
    FOR SELECT TO postwave_app
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY coupon_entitlement_events_transition_insert ON coupon_entitlement_events
    FOR INSERT TO postwave_app
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON coupon_entitlement_events TO postwave_app;
REVOKE UPDATE, DELETE, TRUNCATE ON coupon_entitlement_events FROM postwave_app;

-- ---------------------------------------------------------------------------
-- 3 (continued). Quota guard on allocation.
-- ---------------------------------------------------------------------------

CREATE FUNCTION coupon_assignment_quota_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    subscriber_cap integer;
    campaign_cap   integer;
    held           integer;
    scope_key      text;
BEGIN
    -- Only a fresh ALLOCATION is bounded. A materialised redemption receipt
    -- (status 'redeemed' at insert time, written when an already-issued code is
    -- presented) must never be refused by a bound: the code left the pool at
    -- allocation time and refusing here would break redemption of a code the
    -- recipient legitimately holds. reserved -> assigned is an UPDATE and draws
    -- nothing new.
    IF NEW.status NOT IN ('reserved', 'assigned') THEN
        RETURN NEW;
    END IF;

    -- FOR UPDATE serialises allocation per pool, so the counts below are a
    -- decision and not a race two concurrent inserts both win. AssignCoupon
    -- already holds this lock; re-taking it is free and covers every other
    -- writer.
    SELECT p.max_codes_per_subscriber, p.max_codes_per_campaign
      INTO subscriber_cap, campaign_cap
      FROM public.coupon_pools p
     WHERE p.tenant_id = NEW.tenant_id
       AND p.id = NEW.pool_id
       FOR UPDATE;

    IF NOT FOUND THEN
        -- Zero rows here means the pool does not exist, or row security hid it
        -- because no tenant scope is bound. Both must RAISE: continuing would
        -- allocate a code with no bound applied at all.
        RAISE EXCEPTION
            'coupon allocation refused: pool % is not readable in this scope, so its allocation bounds cannot be applied',
            NEW.pool_id
            USING ERRCODE = '55000';
    END IF;

    IF NEW.subscriber_id IS NOT NULL OR NEW.subscriber_email <> '' THEN
        SELECT count(*)::integer INTO held
          FROM public.coupon_assignments a
         WHERE a.tenant_id = NEW.tenant_id
           AND a.pool_id = NEW.pool_id
           AND a.status IN ('reserved', 'assigned', 'redeemed')
           AND (
                (NEW.subscriber_id IS NOT NULL AND a.subscriber_id = NEW.subscriber_id)
                OR (NEW.subscriber_email <> '' AND lower(a.subscriber_email) = lower(NEW.subscriber_email))
           );
        IF held >= subscriber_cap THEN
            RAISE EXCEPTION
                'coupon allocation refused: subscriber already holds % of % code(s) permitted from pool %',
                held, subscriber_cap, NEW.pool_id
                USING ERRCODE = 'PWQ01';
        END IF;
    END IF;

    -- One sending scope: the campaign when the caller names one, otherwise the
    -- context key, which is what flow nodes and render surfaces set. Both are
    -- "the thing that is looping if something is looping".
    scope_key := COALESCE(NEW.campaign_id::text, NULLIF(NEW.context_key, ''));
    IF scope_key IS NOT NULL THEN
        SELECT count(*)::integer INTO held
          FROM public.coupon_assignments a
         WHERE a.tenant_id = NEW.tenant_id
           AND a.pool_id = NEW.pool_id
           AND a.status IN ('reserved', 'assigned', 'redeemed')
           AND COALESCE(a.campaign_id::text, NULLIF(a.context_key, '')) = scope_key;
        IF held >= campaign_cap THEN
            RAISE EXCEPTION
                'coupon allocation refused: sending scope % already drew % of % code(s) permitted from pool %',
                scope_key, held, campaign_cap, NEW.pool_id
                USING ERRCODE = 'PWQ02';
        END IF;
    END IF;

    RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION coupon_assignment_quota_guard() FROM PUBLIC;

CREATE TRIGGER coupon_assignments_quota_guard
    BEFORE INSERT ON coupon_assignments
    FOR EACH ROW EXECUTE FUNCTION coupon_assignment_quota_guard();

COMMIT;
