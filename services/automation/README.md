# services/automation — Automation runtime

Executes wait, branch, send, and action nodes against Listmonk's transactional
HTTP API. Powers Pillar 3 voice sequences and supported paused Classic
Automations imported from Mailchimp. Mailchimp Customer Journey graphs are
manual rebuild work because the supported Marketing API does not expose a
general graph export. V1 ships the runtime only — the drag-drop builder UI is V2 (React Flow).
This AGPL-3.0-only service communicates only over HTTP with the separately
running upstream Listmonk process; see `LICENSE-BOUNDARY.md`.

## Persistence

`internal/runtime/postgres_store.go` provides `PostgresStateStore`, a
durable replacement for `MemoryStore` that writes execution rows to
`automation_executions` and pause flags to `automation_paused` (see
`infra/migrations/0011_automation_state.sql`). Execution ids are
deterministic (sha256 of automation+subscriber) so duplicate triggers
UPSERT into the same row.

`main.go` selects PostgresStateStore when `DATABASE_URL` is reachable.
If Postgres is configured but unavailable, startup fails unless
`POSTWAVE_ALLOW_MEMORY_FALLBACK=1` is set for an isolated local demo.

## Architecture

```
        +--------------------+
        |  apps/api gateway  |
        +----------+---------+
                   | POST /v1/automations/trigger
                   v
        +--------------------+        +--------------+
        |  HTTP control      |        |  Asynq /     |
        |  plane (chi)       +--------> Redis queue  |
        +----------+---------+        +------+-------+
                   |                         |
                   |  runtime.Engine         | ProcessAt(now+wait)
                   v                         v
        +--------------------+        +--------------+
        |  Engine.Execute    +<-------+  worker.go   |
        |  (per-node)        |        +--------------+
        +----+-----+-----+---+
             |     |     |
        send |     | act | branch
             v     v     v
        +--------------------+
        | listmonk HTTP only |  (no AGPL imports)
        +--------------------+
```

## Runtime semantics

- **Trigger** — `Engine.Trigger(ctx, automationID, triggerType, email, payload)`
  matches against the automation's triggers (type + optional list/tag/event)
  and, on match, enqueues an `Execution` for the entry node.
- **Execute** — pops a node by id, dispatches per node type:
  - `wait`: `ProcessAt(now + duration_seconds)` for the next node.
  - `send_email`: `POST /api/tx` with `template_id` + subscriber email.
  - `branch`: evaluates `condition` against subscriber attrs (resolved by
    `SubscriberResolver`) and routes to `true_next` / `false_next`.
  - `action`: tag add/remove, list move, unsubscribe — all via Listmonk admin
    HTTP.
- **Idempotency** — Execution IDs are stable: `{automation}:{subscriber}:{node}`.
  Asynq's `TaskID` dedup catches re-enqueues; the `StateStore` records
  per-node completion so `Execute` is a no-op when replayed.
- **Pause/Resume** — `Pause(automationID)` flips the `paused` flag; subsequent
  `Execute` calls re-enqueue with a 1-minute delay until resumed. In-flight
  executions are not cancelled mid-node.

## Endpoints

Non-health endpoints are sidecar-internal. Set `POSTWAVE_INTERNAL_API_TOKEN`
in deployed environments; callers must send `Authorization: Bearer <token>`.
When unset, non-health routes only accept loopback requests for local dev.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/automations/trigger` | enqueue entry node |
| `GET`  | `/v1/automations/{id}/executions` | list active per tenant |
| `POST` | `/v1/automations/{id}/pause` | flip paused flag |
| `POST` | `/v1/automations/{id}/resume` | clear paused flag |
| `GET`  | `/v1/automations/health` | queue depth + worker liveness |

## Graceful shutdown

On SIGINT/SIGTERM the process:

1. Stops the chi server (`srv.Shutdown` w/ 30s deadline).
2. Calls `asynqSrv.Stop()` so the worker stops fetching new tasks.
3. Calls `asynqSrv.Shutdown()` to wait for in-flight handlers to drain.

Wait nodes survive restarts because they're scheduled in Redis (Asynq's
delayed-task ZSET), not in process memory.

## Operational follow-ups

- Stripe billing webhooks now fan out lifecycle events as `product_event`
  automation events, with `event_name` values such as
  `billing.subscription.created`, `billing.payment.failed`, and
  `billing.studio.purchased`.
- Dead-letter alarm thresholds tuned against prod data.
