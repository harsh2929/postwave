# Moosewave Audit Shareback — Snowflake Native App

Zero-copy data share that lands every Moosewave audit row in your
Snowflake account, OCSF 1.8-compliant, on your schedule.

## How it works

1. You install this Native App from Snowflake Marketplace.
2. The install script (`package.sql`) provisions
   `POSTWAVE_AUDIT.RAW`, an external stage, and a `RUN_COPY()`
   procedure inside your account.
3. In the Moosewave dashboard, you create an `Audit sink` of kind
   **Snowflake Native App Shareback**, supplying:
   - `account_locator` (e.g. `xy12345.eu-central-1.aws`)
   - `share_name` (must match the one the Native App created on
     install — find it under `SHOW SHARES`)
4. Moosewave writes one OCSF NDJSON file per batch to
   `s3://<bucket>/<prefix>/<account_locator>/<share_name>/<tenant>/<from>-<to>.ocsf.jsonl`.
5. You schedule `CALL POSTWAVE_AUDIT.RUN_COPY()` on whatever cadence
   you want (the Native App's default is every 5 minutes).
6. Query `POSTWAVE_AUDIT.OCSF_VIEW` for a flattened view.

## Why this design

- **Zero plaintext at rest in Snowflake**: the OCSF rows are PUT to
  S3 by Moosewave under the tenant's encrypted credentials envelope.
  Snowflake reads via the SHARE — no cross-cloud auth handshake from
  your side.
- **Reverse-pull**: the customer drives the COPY schedule, so
  Moosewave outages can't back-pressure Snowflake compute, and the
  customer's audit dashboards stay snappy.
- **OCSF-native**: the on-the-wire shape is OCSF 1.8 — drop into any
  detection-engineering pipeline (Splunk ES, Sigma, etc.) without
  schema mapping.

See `terraform/` for the customer-side IAM + Snowflake resources
the listing expects.
