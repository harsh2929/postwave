# Snowflake Warehouse Integration

Status: Native / partial. The unified connector contract now classifies the implemented Snowflake warehouse export/health slice as `native_runtime_complete_live_certification_pending`; full `RuntimeAvailable` still requires live Snowflake account certification plus remote import materialization, schema discovery, provider-aware retry proof, and Snowflake-side cleanup proof.

The Snowflake warehouse tile is a Moosewave-owned control plane for warehouse
connections, run history, manifest evidence, and load-plan handoff evidence.
It passes ready export-copy requests to a linked local `SnowflakeSQLExecutor`
after verifying stored artifacts, and passes configured import-table query
plans plus opt-in `SELECT 1` provider-health probes to the same executor. It
still needs live Snowflake account certification before public full-availability
claims.
Disconnect is row-preserving: Moosewave marks the local connection
`disconnected`, stops future runs, blocks import-mapping and reverse-ETL
mutations, retains run and mapping history, keeps health in the disconnected
state even when older runs failed, and stores operator-managed
`config.provider_cleanup` readiness evidence. Operators can then record local
attestation for the manual Snowflake console cleanup through
`POST /api/v1/warehouse/connections/{id}/provider-cleanup/acknowledge`; that
endpoint only updates Moosewave evidence and does not call Snowflake APIs.

## What Works Today

- Create Snowflake warehouse connections through `POST /api/v1/warehouse/connections`.
- Validate required Snowflake settings: `account`, `warehouse`, `database`, `schema`, and `credentials_ref`.
- Reject raw Snowflake keys, tokens, passwords, nested secrets, and raw-looking `credentials_ref` values in public config.
- Validate Snowflake account shape, SQL identifiers, optional one-/two-/three-part `stage` paths, and optional `import_table` paths.
- Generate Snowflake SQL with unquoted-identifier semantics by normalizing accepted lowercase identifiers to uppercase in quoted COPY/query SQL.
- Record export runs as auditable manifests with `delivery_state=prepared_manifest`, `provider_target_uri`, `provider_driver_attachment=manifest_worker`, row/byte counts, and stored ZIP handoff artifacts when warehouse object storage is configured.
- Store per-object JSONL handoff artifacts for Snowflake exports when warehouse object storage is configured.
- Emit deterministic `snowflake_load_plan` metrics with target tables, artifact paths, fully qualified stage references in COPY SQL text, warnings, and `snowflake_load_plan_state=load_plan_ready` only when every selected executable object has stage, storage-artifact, and credential-reference prerequisites.
- Emit destination schema previews for executable export objects, including `destination_schema_version`, `CREATE TABLE IF NOT EXISTS` SQL, and information-schema validation SQL.
- Emit a typed `snowflake_provider_job` / nested `provider_job` request envelope with Snowflake target settings, credential-ref presence, target URI, artifact references/object keys, COPY SQL or import query previews, an ordered statement plan, executable flags, warnings, `execution_state`, and `live_state`.
- Verify executable JSONL artifacts from object storage, pass typed copy or import-query requests plus the ordered executable statement plan to the linked executor, and record `snowflake_provider_execution_*` metrics for execution state/mode, artifact count, rows loaded, tables loaded, statements executed, driver warnings, and executor-reported `live_state`.
- Moosewave now bundles and registers the Snowflake `database/sql` driver and attaches a `SnowflakeSQLExecutor` to the warehouse repo by default. Set `POSTWAVE_DISABLE_SNOWFLAKE_EXECUTOR=1` only to disable this runtime, optionally set `POSTWAVE_SNOWFLAKE_SQL_DRIVER` when a deployment registers a non-default driver name, and tune `POSTWAVE_SNOWFLAKE_MAX_OPEN_CONNS` / `POSTWAVE_SNOWFLAKE_MAX_QUERY_ROWS` for connection-pool and query-sampling bounds. The executor resolves `credentials_ref` through the shared runtime secret resolver, accepts JSON/key-value secret payloads or a raw DSN escape hatch, pools `*sql.DB` by connection ID, reopens on DSN rotation, executes ordered DDL/COPY/query/health statements, and reports `execution_mode=snowflake_database_sql` plus bounded query sample evidence.
- Accept `run_mode=dry_run` for warehouse runs and preserve the run record while skipping artifact writes, Snowflake executor calls, product-event materialization, row-error inserts, and cursor advancement.
- Record `retry_count` plus `retry_basis=prior_failed_runs_for_connection_direction` for local `run_mode=retry` attempts. This is local run-history evidence, not provider-driver backoff certification.
- Honor `GET /api/v1/warehouse/connections/{id}/runs?limit=` up to 500 rows and return `404` for missing connection-scoped run history.
- Keep placeholder-only objects such as unavailable `reviews` evidence non-executable in the generated COPY plan.
- Record import runs with no staged rows as `loader_state=import_plan_ready` when `import_table` plus credential prerequisites are present, or `waiting_for_provider_driver` when they are not. Configured import-table plans emit `snowflake_import_plan` and provider-job query evidence, and an injected executor can record query execution metrics without claiming remote row materialization.
- Expose health with `provider_runtime_status=partial`, `provider_driver_attachment=manifest_worker`, and Snowflake `provider_health` evidence. By default the response reports the deterministic `SELECT 1` plan and missing-setting state; `?provider_check=true` executes that probe through the attached executor only when the row is active or in error state.
- Mark deleted warehouse connections `disconnected` instead of hard-deleting them, hide disconnected rows from ordinary lists unless `?status=disconnected` is requested, reject pause/run/import-mapping/reverse-ETL mutation paths for disconnected rows, and retain `config.provider_cleanup` evidence for operator-managed Snowflake cleanup.
- Record local Snowflake cleanup acknowledgement with completed action keys, notes, actor attribution, and `acknowledged_at` merged into the preserved `config.provider_cleanup` evidence.
- Support staged-row import and reverse-ETL mapping/writeback through the warehouse surface.

## What Is Not Native Yet

- No automatic upload from Moosewave object storage into a Snowflake internal/external stage.
- No certified production/live Snowflake `SELECT 1` health check evidence yet; the health endpoint can execute the probe through the attached executor, but live account evidence must still be recorded.
- No live schema/table introspection or automatic destination table creation beyond preview SQL attached to the provider-job handoff.
- No remote Snowflake table polling or returned-row materialization for import or reverse ETL.
- No Snowflake-side role, grant, stage, task, stream, or key cleanup automation on disconnect; cleanup acknowledgement is local operator attestation only.
- No provider-certified retry/backoff behavior or Retry-After handling yet; current retry evidence is local run-history counting only.
- No live Snowflake account certification evidence.

## Required Settings

- `account`: Snowflake account locator or organization-account name.
- `warehouse`: Snowflake compute warehouse.
- `database`: Target database.
- `schema`: Target schema.
- `credentials_ref`: Vault or secret-manager reference containing Snowflake key-pair, OAuth, PAT, password, or workload-identity material.

Optional settings:

- `role`: Snowflake role.
- `stage`: One-, two-, or three-part named stage used by the linked SQL executor for COPY planning/execution.
- `import_table`: One-, two-, or three-part table/view identifier used by the linked SQL executor for import-query planning/execution.

## Promotion Checklist

Keep the catalog tile `RuntimePartial` until all of the following are true:

- Credential refs resolve through the production shared-secret resolver for supported Snowflake auth modes.
- Connection health performs the bounded `SELECT 1` probe through the production driver and records certified live-account evidence.
- Export jobs create or validate destination tables and execute live staged COPY/load work from the stored handoff artifact.
- Import and reverse-ETL jobs fetch remote rows with durable cursors.
- Provider errors, retry behavior, idempotency, and `snowflake_provider_execution_*` run metrics are captured from the live driver.
- Disconnect posture for Snowflake-side users, roles, grants, stages, tasks, streams, and keys is either automated or explicitly certified as operator-managed; local acknowledgement evidence alone is not live cleanup certification.
- Live account certification covers connect, sync, backfill, retry, health, disconnect, credential rotation, and data-delete behavior.
