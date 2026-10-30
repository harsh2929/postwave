-- Keep rollback's imported-resource ledger in sync with the migration
-- service resource types. Older installs only allowed the original runtime
-- resources, which blocks template/source-archive tracking during commits.

ALTER TABLE migration_imported_resources
    DROP CONSTRAINT IF EXISTS migration_imported_resources_resource_type_check;

ALTER TABLE migration_imported_resources
    ADD CONSTRAINT migration_imported_resources_resource_type_check
    CHECK (resource_type IN (
        'subscriber',
        'segment',
        'automation',
        'campaign_archive',
        'campaign',
        'campaign_report_event',
        'template',
        'paid_subscription',
        'source_archive',
        'automation_journey',
        'popup_form',
        'landing_page',
        'commerce_integration'
    ));
