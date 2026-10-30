# Zero-Copy Warehouse Triggers — multi-week migration recipe

`sto-zero-copy-warehouse-triggers` is Braze's "Zero-Copy Canvas Triggers"
parity gap (P3, effort=XL). Within seconds of a warehouse INSERT in a
customer's Snowflake / BigQuery / Redshift table, the matching journey
starts — no ETL into our event stream is required.

This doc records the shipped runtime and remaining live-certification work.

## Architecture (words, no ASCII art)

The flow is four hops:

1. **Operator** configures one `external_warehouse_triggers` row pointing
   at a `warehouse_connections` row (creds + provider) plus the SQL query
   to poll, the cursor column (timestamptz or monotonic id), and a target
   `automation_journeys` id.
2. **Cross-tenant scanner** (`Worker.Run` → `Repo.ListDue`) wakes on a
   ticker, pulls active triggers whose `last_polled_at + interval` has
   elapsed. Uses the `app.outbox_worker` GUC so RLS lets the unbound
   connection see all tenants.
3. **Per-trigger driver call** (`PollOnce`) re-enters the tenant scope,
   resolves the `Driver` for the trigger's provider, runs the query with
   `:last_seen_cursor` substituted, and walks the returned rows. Each
   row → `ResolveSubscriberID` → enqueue `flow_runs` via the
   `FlowRunEnqueuer` seam (in production, `flowbuilder.Repo`).
4. **Ledger writes** record one `external_warehouse_trigger_fires` row
   per warehouse row + bump `last_seen_cursor` / `last_polled_at` /
   `rows_fired_total` so the next tick picks up from the right point.

Migration 0345 layers three new scaffolds on top of that base:

- **Alerts** (`external_warehouse_trigger_alerts`): per-trigger
  thresholds (consecutive failures, lag seconds, fires-per-tick burst)
  + cooldown bookkeeping so the alerter does not spam ops.
- **Health cache** (`health_status` / `health_checked_at` /
  `health_error` columns on the base table): the cross-tenant scanner
  can skip provably-dead triggers between healthchecks.
- **DLQ** (`external_warehouse_trigger_dlq`): warehouse rows the worker
  saw but could not enroll (unresolved subscriber, enqueue failure,
  partial driver row) are preserved with their payload + a retry counter
  so a reconciliation pass can replay them.

## What is shipped today

- Migrations 0285, 0325, 0345 (data model + RLS + indexes).
- `repo.go` — full CRUD for triggers + fires + tick / fire recording.
- `worker.go` — cross-tenant loop, per-trigger PollOnce path, error
  truncation, fire status enum, consent firewall, and DLQ reconciliation.
- `driver.go`, `sql_driver.go`, `bigquery_driver.go` — fail-closed driver
  registry plus concrete Postgres/Redshift/Snowflake and BigQuery polling.
  Missing registrations return an error instead of a successful empty poll.
  The runtime accepts only one conservative `SELECT`/`WITH ... SELECT`
  statement, rejects comments and write-capable tokens, uses read-only SQL
  transactions, requires a `read_only=true` credential payload, applies a
  30-second timeout, and caps every poll at 1,000 rows, 1 MiB per serialized
  row, and 8 MiB total. BigQuery additionally sets a 30-second server-side job
  timeout and a 1 GiB `maximumBytesBilled` ceiling, and rejects incomplete
  synchronous results rather than treating them as an empty successful poll.
  SQL pools retain at most one idle socket each, expire idle/lifetime state,
  and use a process-wide 256-entry LRU ceiling. Resolved credential JSON is
  capped at 256 KiB before decoding.
- `credentials.go` — derives every credential name from the authenticated
  tenant and a local label:
  `postwave/tenants/<tenant-uuid>/warehouse/read-only/<label>`. A stored
  reference for another tenant is rejected before the shared secret backend is
  called, and SQL pools are keyed by tenant plus connection id.
- `alerts.go` — AlertConfig + AlertRepo + GET/PUT handlers + cooldown
  bookkeeping helper (`RecordFired`).
- `dlq.go` — DLQEntry + DLQRepo + ListDLQ / RetryDLQ handlers and the
  worker-driven `ReconcileDLQ` implementation.
- HTTP wiring for all of the above (apikeys-scoped CRUD + alerts + DLQ).
- Unit tests for the worker dispatch tree against a fake driver / repo.

## What is explicitly deferred

The remaining work is deployment and live-account certification:

1. **Credential-provider certification.** Provision each label under
   `postwave/tenants/<tenant-uuid>/warehouse/read-only/<label>` in the selected
   shared secret backend. Payloads must be JSON, include `read_only: true`, and
   identify a provider account/role with SELECT-only grants. Rotate the
   tenant-scoped secret, exercise pool replacement, and prove that logs and
   error rows never contain credentials. Legacy process-wide `POSTWAVE_WH_*`
   values are not read by production composition and must be migrated before
   enabling a trigger.

   BigQuery access tokens should use a read-only OAuth scope and an IAM role
   limited to query-job creation plus data read; do not grant dataset/table
   mutation permissions. Provider error bodies are capped before logging, but
   certification must still verify the provider does not echo credentials.

   Postgres and Redshift DSNs must use `sslmode=verify-full`; provision the
   appropriate trusted CA chain and a hostname matching the warehouse
   certificate. `require`, `verify-ca`, `prefer`, `allow`, and `disable` are
   rejected because they do not provide full server-identity verification.

   Connections used by this runtime must be `active` and have direction
   `import` or `bidirectional`; export-only and paused/error connections fail
   closed before credential resolution.

2. **Live provider suites.** Run bounded polling, cursor, retry, quota, and
   cancellation tests against representative Snowflake, BigQuery, Redshift,
   and Postgres accounts. Configure Snowflake streams where true CDC is
   required rather than ordinary table polling.

3. **Healthcheck routine.**
   New goroutine in the worker that walks
   `external_warehouse_triggers_health_stale_idx` rows older than (say)
   5 minutes, runs `SELECT 1` against the driver, writes
   `health_status` / `health_checked_at` / `health_error`. The main
   poll loop skips triggers where `health_status='dead'` AND
   `health_checked_at` is within the configured re-check window.

4. **Alert evaluator.**
   New goroutine: after each `RecordTick`, evaluate the alert config,
   check cooldown via `last_alert_fired_at`, post to either the
   per-trigger `notify_webhook_url` or the tenant default channel,
   call `AlertRepo.RecordFired`. Wire into the existing `audit_alerts`
   package so it shares the same delivery infrastructure.

5. **Operator UX in the desktop app** (depends on live certification +
   alerts shipping).
   Trigger list + per-trigger editor + fires inspector + DLQ inspector
   + alert config form. The handlers are already wired; only the
   frontend remains.

6. **End-to-end integration tests.** Exercise warehouse row → consent
   firewall → subscriber resolution → journey enrollment → receipt,
   including driver failure, DLQ replay, restart, and duplicate-cursor cases.

## Effort estimate

Estimate live certification and the remaining operational/UX work against the
chosen deployment and customer provider mix; the driver implementations are no
longer the gating item.

## Inspiration

- Braze, "Zero-Copy Canvas Triggers" — the parity target; eliminates
  ETL by polling the customer's warehouse and firing journeys off new
  rows in-place.

## Migration number ledger

- `0285_zero_copy_warehouse_triggers.sql` — base tables + RLS.
- `0325_zero_copy_trigger_worker_policy.sql` — RLS bypass for the
  cross-tenant worker scan.
- `0345_sto_zero_copy_warehouse_triggers.sql` — alerts + health cache
  + DLQ (this iteration).
