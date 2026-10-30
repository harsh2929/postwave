-- Store Shopify OAuth install material in encrypted envelopes instead of
-- plaintext JSON settings. Existing legacy settings remain readable by the
-- application fallback until a later cleanup migration rewraps/removes them.

ALTER TABLE commerce_integrations
    ADD COLUMN IF NOT EXISTS access_token_envelope bytea,
    ADD COLUMN IF NOT EXISTS webhook_secret_envelope bytea;

COMMENT ON COLUMN commerce_integrations.access_token_envelope IS
    'Envelope-encrypted provider OAuth access token for native commerce integrations such as Shopify.';

COMMENT ON COLUMN commerce_integrations.webhook_secret_envelope IS
    'Envelope-encrypted provider webhook signing secret for native commerce integrations such as Shopify.';
