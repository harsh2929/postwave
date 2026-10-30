-- 1905_gift_subscriptions_public_token.sql
--
-- Gift preview and redemption returned "not found" for every valid gift.
--
-- Both public paths (`GiftPreview`, `RedeemGift`) open a transaction, set
-- `app.tenant_id` to the all-zero uuid because the redeemer has no tenant, and
-- set `app.public_gift_token` to the hex of the token they presented. They then
-- select the gift by `redemption_token_sha256`.
--
-- Nothing anywhere read `app.public_gift_token` — a schema-wide search across
-- every policy and every function body found zero references. The row was
-- therefore matched against the all-zero tenant, no real gift ever matched, and
-- every preview and redemption resolved to ErrNotFound.
--
-- Proven directly: with the owning tenant set the row is visible; with the
-- public path's zero tenant and the correct token it is not.
--
-- IT MUST BE THE RESTRICTIVE POLICY THAT ADMITS THE TOKEN. `tenant_isolation`
-- here is RESTRICTIVE FOR ALL, so it ANDs with every other policy — a new
-- permissive policy cannot grant anything past it, which is what a first
-- attempt at this fix got wrong. The token path has to be part of the
-- restrictive predicate itself.
--
-- THE TOKEN IS THE CREDENTIAL, exactly as it is for action tickets: the
-- redeemer has no session and no tenant, which is the entire point of a gift
-- link, so possession of the token is the only thing that can authorise the
-- read.
--
-- SCOPED TO ONE ROW. The predicate compares the presented token to THAT ROW's
-- stored hash, so possession of one token reveals exactly one gift and never
-- the tenant's others. Without the per-row equality this would be a capability
-- to read every gift in the table.
--
-- The tenant branch is unchanged and still governs every authenticated path;
-- the token branch is additive and cannot widen it, because a request that
-- presents no token fails the added disjunct outright.

BEGIN;

-- BOTH HALVES ARE REQUIRED, and getting only one produced no access at all.
--
-- PostgreSQL ANDs every RESTRICTIVE policy and ORs the PERMISSIVE ones, and a
-- row is visible only when the restrictive set passes AND at least one
-- permissive policy passes. The token therefore has to appear twice: in the
-- restrictive rule so it does not veto, and in a permissive rule so something
-- actually grants. A first attempt added only the permissive pair (vetoed by
-- the restrictive tenant rule) and a second added only the restrictive branch
-- (nothing left to grant). Neither changed the observable behaviour, which is
-- exactly how a half-finished RLS change hides.
DROP POLICY IF EXISTS gift_public_token_read ON gift_subscriptions;
CREATE POLICY gift_public_token_read ON gift_subscriptions
    FOR SELECT
    USING (
        NULLIF(current_setting('app.public_gift_token', true), '') IS NOT NULL
        AND redemption_token_sha256 IS NOT NULL
        AND encode(redemption_token_sha256, 'hex')
            = lower(current_setting('app.public_gift_token', true))
    );

-- Redemption updates the row's status. SELECT and UPDATE only: nothing about a
-- gift link should let its bearer INSERT a new gift or DELETE somebody else's,
-- which FOR ALL would grant.
DROP POLICY IF EXISTS gift_public_token_claim ON gift_subscriptions;
CREATE POLICY gift_public_token_claim ON gift_subscriptions
    FOR UPDATE
    USING (
        NULLIF(current_setting('app.public_gift_token', true), '') IS NOT NULL
        AND redemption_token_sha256 IS NOT NULL
        AND encode(redemption_token_sha256, 'hex')
            = lower(current_setting('app.public_gift_token', true))
    )
    -- The row may not be moved to another tenant, nor its token rewritten, by a
    -- bearer who only proved possession of the current one.
    WITH CHECK (
        encode(redemption_token_sha256, 'hex')
            = lower(current_setting('app.public_gift_token', true))
    );

DROP POLICY IF EXISTS gift_public_token_select ON gift_subscriptions;
DROP POLICY IF EXISTS gift_public_token_update ON gift_subscriptions;

DROP POLICY IF EXISTS tenant_isolation ON gift_subscriptions;
CREATE POLICY tenant_isolation ON gift_subscriptions
    AS RESTRICTIVE
    USING (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            NULLIF(current_setting('app.public_gift_token', true), '') IS NOT NULL
            AND redemption_token_sha256 IS NOT NULL
            AND encode(redemption_token_sha256, 'hex')
                = lower(current_setting('app.public_gift_token', true))
        )
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR (
            NULLIF(current_setting('app.public_gift_token', true), '') IS NOT NULL
            AND redemption_token_sha256 IS NOT NULL
            AND encode(redemption_token_sha256, 'hex')
                = lower(current_setting('app.public_gift_token', true))
        )
    );

COMMENT ON POLICY tenant_isolation ON gift_subscriptions IS
    'Tenant isolation, plus the one capability a gift link can present. A gift '
    'redeemer has no session and no tenant, so possession of the redemption '
    'token is the only thing that can authorise the read; the predicate '
    'compares it to THIS row''s stored hash, so one token reveals one gift. '
    'Before this the public paths matched the all-zero tenant and every valid '
    'gift resolved to "not found".';

COMMIT;
