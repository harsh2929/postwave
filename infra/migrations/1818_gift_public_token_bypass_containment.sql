-- 1818_gift_public_token_bypass_containment.sql
-- migration-execution: single-phase
-- rollback-strategy: no-op
-- rollback-details: Do not restore the public-token policies during an
-- application rollback. The public Gift lookup and redemption routes are not
-- mounted in this release, so the least-privilege database posture is to keep
-- token-based SELECT/UPDATE disabled. A future launch must introduce a newly
-- reviewed, narrowly scoped redemption contract and migration rather than
-- silently reviving migration 0219.
--
-- Migration 0219 widened the restrictive tenant policy and added permissive
-- token policies for unauthenticated Gift redemption. The HTTP feature is now
-- deliberately unavailable, but those database capabilities survived. Remove
-- the dormant bypass so an accidental internal call or route remount cannot
-- turn the app.public_gift_token GUC into row authority.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS public_token_visible ON gift_subscriptions;
DROP POLICY IF EXISTS public_token_redeem ON gift_subscriptions;

DROP POLICY IF EXISTS tenant_isolation ON gift_subscriptions;
CREATE POLICY tenant_isolation ON gift_subscriptions
    AS RESTRICTIVE FOR ALL
    USING (
        tenant_id = NULLIF(
            current_setting('app.tenant_id', true),
            ''
        )::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(
            current_setting('app.tenant_id', true),
            ''
        )::uuid
    );

COMMIT;
