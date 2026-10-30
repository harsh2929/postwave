-- 0549_custom_fields_data_classification.sql
--
-- SUB-057 — Data-classification tags on every attribute.
--
-- Why this migration:
--   The custom-fields registry (tenant_custom_fields, 0415) already carries a
--   `config jsonb` blob holding the FieldConfig (options, item_type, schema,
--   pattern, pii_flag, encryption_flag). pii_flag is only a boolean — it cannot
--   express the full data-classification taxonomy a policy engine needs
--   (PII / PHI / PCI / sensitive / business). This migration adds a
--   data_classification field, persisted inside that same config jsonb, and
--   pins its accepted values with a CHECK constraint so a drifting client
--   cannot land an unknown classification.
--
--   Allowed values: pii, phi, pci, sensitive, business, none.
--   Absent / null / 'none' all mean "unclassified" — the policy engine treats
--   them identically (no masking/retention rule attaches).
--
-- rollback-strategy: additive. Hard rollback = DROP the CHECK constraint.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'tenant_custom_fields_data_classification_chk'
    ) THEN
        ALTER TABLE tenant_custom_fields
            ADD CONSTRAINT tenant_custom_fields_data_classification_chk
            CHECK (
                config IS NULL
                OR NOT (config ? 'data_classification')
                OR config ->> 'data_classification' IN (
                    'pii', 'phi', 'pci', 'sensitive', 'business', 'none'
                )
            );
    END IF;
END$$;

COMMENT ON CONSTRAINT tenant_custom_fields_data_classification_chk
    ON tenant_custom_fields IS
    'SUB-057: config.data_classification, when present, must be one of pii/phi/pci/sensitive/business/none.';

COMMIT;
