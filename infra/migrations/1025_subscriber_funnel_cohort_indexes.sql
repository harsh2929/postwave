-- 1025_subscriber_funnel_cohort_indexes.sql
--
-- SUB-128 (cont.): planner-support indexes for the SubscriberFunnel cohort
-- aggregation (apps/api/internal/analytics/service.go).
--
-- SubscriberFunnel buckets subscribers by signup-month cohort, then joins
-- commerce_orders by lower(email) to count first / repeat purchasers per
-- cohort. The base subscribers table already indexes (tenant_id, email) but
-- NOT (tenant_id, created_at) — the cohort GROUP BY date_trunc('month',
-- created_at) would otherwise scan the full tenant partition each load. Add a
-- composite (tenant_id, created_at) index so the cohort enumeration is an
-- index-ordered range scan.
--
-- commerce_orders already has commerce_orders_customer_idx
-- (tenant_id, customer_email, ordered_at DESC), which the email-join leg
-- reuses directly; no new commerce_orders index is required. A functional
-- index on lower(customer_email) would duplicate that citext-keyed index
-- (customer_email is already citext, so equality is case-insensitive), so we
-- deliberately do NOT add one.
--
-- Both indexes are idempotent (IF NOT EXISTS). No table is created here, so no
-- new RLS policy is needed — the indexed tables already enforce tenant RLS.

BEGIN;

-- Cohort enumeration: GROUP BY date_trunc('month', created_at) per tenant.
CREATE INDEX IF NOT EXISTS subscribers_tenant_created_at_idx
    ON subscribers (tenant_id, created_at);

COMMIT;
