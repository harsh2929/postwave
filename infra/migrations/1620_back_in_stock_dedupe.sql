-- 1620_back_in_stock_dedupe.sql
--
-- Dedupe active back-in-stock email sign-ups. The unauthenticated onsite intake
-- (apps/api/internal/commerce/back_in_stock_public.go) lets anonymous shoppers
-- create back_in_stock_subscriptions rows; without a uniqueness guard a shopper
-- (or a bot) submitting the same email repeatedly spams rows and earns duplicate
-- restock emails. This partial unique index caps it at one waiting/eligible
-- subscription per (integration, product, variant, email). COALESCE folds a NULL
-- variant to a sentinel so product-level signups also collapse. Email-less rows
-- (the admin subscriber_id path) are excluded, so they are unaffected.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS back_in_stock_active_email_uniq
    ON back_in_stock_subscriptions (
        tenant_id,
        integration_id,
        product_id,
        COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
        subscriber_email
    )
    WHERE subscriber_email IS NOT NULL AND status IN ('waiting', 'eligible');

COMMIT;
