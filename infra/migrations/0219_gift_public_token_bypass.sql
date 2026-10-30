-- 0219_gift_public_token_bypass.sql
--
-- The public gift-redemption endpoints (GET /api/public/gifts/{token}
-- + POST /api/public/gifts/{token}/redeem) have no tenant context —
-- the raw token in the URL IS the authn factor (we store sha256;
-- finding the row proves the requester has the token).
--
-- Two RLS layers blocked this path:
--
--   1. The PERMISSIVE `tenant_visible` policy from 0079 needed
--      `app.tenant_id` to be a valid uuid (or it 22P02'd on cast).
--   2. The RESTRICTIVE `tenant_isolation` policy from 0074 ANDed
--      a `tenant_id = current_setting('app.tenant_id')::uuid`
--      check on top of every other PERMISSIVE bypass. Because
--      RESTRICTIVE acts as a veto gate, no PERMISSIVE bypass alone
--      could ever let the row through; the restrictive predicate
--      must itself widen to admit the public-token case.
--
-- Fix:
--   * Drop and recreate `tenant_isolation` with a widened predicate
--     that admits either the tenant-id match OR a matching
--     public-token GUC. Belt-and-suspenders tenant scoping is
--     preserved for normal traffic; the public token is the
--     scoping primary key for the unauthenticated path.
--   * Add a PERMISSIVE `public_token_visible` / `public_token_redeem`
--     pair so the tenant_visible policy's cast doesn't have to
--     succeed (we still set app.tenant_id to a sentinel zero-uuid
--     in the handler, but these PERMISSIVE policies are what admit
--     the row).
--
-- Mirrors the public-token pattern used by approvals (migration
-- 0023, app.public_approval_id), but adapted to the RESTRICTIVE +
-- PERMISSIVE layering 0074/0079 left us with.

BEGIN;

-- 1. Replace the restrictive tenant_isolation veto with a widened
--    version that also admits the public-token path. Same security
--    posture for tenant traffic; opens a precise bypass for the
--    SHA256 of the raw token only.
DROP POLICY IF EXISTS tenant_isolation ON gift_subscriptions;
CREATE POLICY tenant_isolation ON gift_subscriptions
    AS RESTRICTIVE FOR ALL
    USING (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      OR encode(redemption_token_sha256, 'hex')
         = NULLIF(current_setting('app.public_gift_token', true), '')
    )
    WITH CHECK (
      tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      OR encode(redemption_token_sha256, 'hex')
         = NULLIF(current_setting('app.public_gift_token', true), '')
    );

-- 2. PERMISSIVE companions: the tenant_visible policy from 0079
--    still requires SOME permissive admit, and we don't want to
--    rely on its uuid cast succeeding on the public path.
CREATE POLICY public_token_visible ON gift_subscriptions
    AS PERMISSIVE FOR SELECT
    TO postwave_app
    USING (
      encode(redemption_token_sha256, 'hex')
        = NULLIF(current_setting('app.public_gift_token', true), '')
    );

CREATE POLICY public_token_redeem ON gift_subscriptions
    AS PERMISSIVE FOR UPDATE
    TO postwave_app
    USING (
      encode(redemption_token_sha256, 'hex')
        = NULLIF(current_setting('app.public_gift_token', true), '')
    )
    WITH CHECK (
      encode(redemption_token_sha256, 'hex')
        = NULLIF(current_setting('app.public_gift_token', true), '')
    );

COMMIT;
