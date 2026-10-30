-- 0213_mailchimp_gap_closure_foundation.sql
--
-- Mailchimp gap-closure foundations:
--   - campaign asset folders are first-class content-library records;
--   - long-tail Mailchimp compatibility resources persist in
--     mailchimp_platform_state instead of falling back to process memory.

BEGIN;

ALTER TABLE campaign_assets DROP CONSTRAINT IF EXISTS campaign_assets_asset_type_check;
ALTER TABLE campaign_assets ADD CONSTRAINT campaign_assets_asset_type_check
    CHECK (asset_type IN ('image', 'file', 'video', 'product', 'folder'));

ALTER TABLE mailchimp_platform_state DROP CONSTRAINT IF EXISTS mailchimp_platform_state_kind_check;
ALTER TABLE mailchimp_platform_state ADD CONSTRAINT mailchimp_platform_state_kind_check
    CHECK (kind IN (
        'batch',
        'batch_webhook',
        'account_export',
        'connected_site',
        'verified_domain',
        'merge_field',
        'list_segment',
        'list_webhook',
        'campaign_folder',
        'campaign_feedback',
        'journey_trigger',
        'ecommerce_customer',
        'authorized_app',
        'transactional_template',
        'transactional_message',
        'parity_task',
        'provider_gate',
        'activation_run'
    ));

COMMIT;
