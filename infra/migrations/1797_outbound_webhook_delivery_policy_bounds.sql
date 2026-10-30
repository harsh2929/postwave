-- 1797_outbound_webhook_delivery_policy_bounds.sql
--
-- Defense-in-depth for the delivery filter/projection surface. Application
-- writes perform the complete DSL and RFC 6901 validation; these constraints
-- keep direct SQL and older binaries from storing unbounded/non-object input.
-- NOT VALID avoids blocking rollout on historical rows while still enforcing
-- the rule for every new or changed row.

BEGIN;

ALTER TABLE outbound_webhooks
    ADD CONSTRAINT outbound_webhooks_filter_expression_size
        CHECK (
            filter_expression IS NULL
            OR octet_length(filter_expression) <= 4096
        ) NOT VALID,
    ADD CONSTRAINT outbound_webhooks_transform_template_shape
        CHECK (
            transform_template IS NULL
            OR (
                jsonb_typeof(transform_template) = 'object'
                AND octet_length(transform_template::text) <= 16384
            )
        ) NOT VALID;

COMMENT ON CONSTRAINT outbound_webhooks_filter_expression_size
    ON outbound_webhooks IS
    'Application-validated filter DSL is bounded to 4 KiB.';

COMMENT ON CONSTRAINT outbound_webhooks_transform_template_shape
    ON outbound_webhooks IS
    'Application-validated RFC 6901 projection must be a JSON object <=16 KiB.';

COMMIT;
