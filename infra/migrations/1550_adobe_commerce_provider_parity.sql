-- 1550_adobe_commerce_provider_parity.sql
-- Admit Adobe Commerce / Magento into the managed commerce control plane and
-- DSAR provider fan-out constraints.

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
            'adobe-commerce',
            'paypal',
            'razorpay',
            'wix-stores',
            'squarespace-commerce'
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
            'adobe-commerce',
            'paypal',
            'razorpay',
            'wix-stores',
            'squarespace-commerce'
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
            'adobe-commerce',
            'paypal',
            'razorpay',
            'wix-stores',
            'squarespace-commerce'
        ));
END$$;

COMMIT;
