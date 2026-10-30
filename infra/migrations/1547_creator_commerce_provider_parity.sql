-- 1547_creator_commerce_provider_parity.sql
--
-- Admit creator-site commerce providers into the managed commerce control
-- plane. They reuse commerce_integrations and must also be valid DSAR
-- receipt providers because fan-out enumerates connected commerce rows.

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
            'paypal',
            'razorpay',
            'wix-stores',
            'squarespace-commerce'
        ));
END$$;

COMMIT;
