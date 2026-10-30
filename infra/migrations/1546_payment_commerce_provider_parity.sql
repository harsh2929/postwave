-- 1546_payment_commerce_provider_parity.sql
--
-- Promote PayPal and Razorpay into the managed commerce/payments control
-- plane. They reuse commerce_integrations for credential references, sync
-- cursors, webhook topics, and DSAR fan-out policy/receipt surfaces.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'commerce_integrations_provider_check'
    ) THEN
        ALTER TABLE commerce_integrations
            DROP CONSTRAINT commerce_integrations_provider_check;
    END IF;

    ALTER TABLE commerce_integrations
        ADD CONSTRAINT commerce_integrations_provider_check
        CHECK (provider IN (
            'shopify',
            'woocommerce',
            'stripe',
            'square',
            'bigcommerce',
            'paypal',
            'razorpay'
        ));
END$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'dsar_policies_provider_check'
    ) THEN
        ALTER TABLE dsar_policies
            DROP CONSTRAINT dsar_policies_provider_check;
    END IF;

    ALTER TABLE dsar_policies
        ADD CONSTRAINT dsar_policies_provider_check
        CHECK (provider IN (
            'shopify',
            'woocommerce',
            'stripe',
            'square',
            'bigcommerce',
            'paypal',
            'razorpay'
        ));
END$$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'dsar_store_responses_provider_check'
    ) THEN
        ALTER TABLE dsar_store_responses
            DROP CONSTRAINT dsar_store_responses_provider_check;
    END IF;

    ALTER TABLE dsar_store_responses
        ADD CONSTRAINT dsar_store_responses_provider_check
        CHECK (provider IN (
            'shopify',
            'woocommerce',
            'stripe',
            'square',
            'bigcommerce',
            'paypal',
            'razorpay'
        ));
END$$;

COMMIT;
