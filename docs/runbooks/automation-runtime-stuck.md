# Runbook — Automation Runtime Stuck

When `services/automation` (the wait/branch/send/action runtime that
powers Pillar 3 voice sequences and supported paused Mailchimp Classic
Automations) stops
making progress: queue depth grows, executions don't advance, dead-letter
fills.

---

## Symptoms

- `asynq_queue_size{queue=~"automation.*"}` rising monotonically.
- `automation_step_duration_ms` P99 spikes to seconds-or-minutes.
- Customer reports: "my welcome sequence email 3 hasn't gone out and it's
  been hours."
- `automation_dead_letter_size` non-zero.
- Service `/health` may still return 200 (we ping the listener, not the
  worker), so don't trust it alone.

## Detection

Two alarms:
1. **Queue backlog**: `asynq_queue_size > 5000` for >10 minutes (workers
   are not draining at the expected rate).
2. **Stalled enrollment**: `automation_enrollment_age_seconds > 86400`
   p95 across active enrollments — i.e. some enrollment hasn't progressed
   in 24h despite having a `wait` step due in less than 24h.

Both page SEV2.

## Severity matrix

| Condition | Severity |
|---|---|
| One queue backed up, others fine, draining slowly | SEV3 |
| All queues backed up, no draining, single host | SEV2 |
| Cluster-wide backlog AND dead-letter growing | SEV1 |
| Data integrity (duplicate sends, missed sends) suspected | SEV1 |

---

## Immediate response (P0)

1. **Confirm scope.** `asynq` admin UI (or `asynqmon` CLI):
   ```
   asynq stats --uri redis://...
   asynq dash
   ```
   Count queued / in-progress / retry / dead per queue.
2. **Look for poison messages.** A single bad task can wedge a worker.
   - List the dead-letter for the affected queue:
     ```
     asynq task ls --queue automation.send --state archived
     ```
   - Inspect the top item — `payload` includes `enrollment_id`, `step_id`.
3. **Pause new enrollments** if the backlog is growing faster than it's
   draining:
   ```sql
   UPDATE automation_config SET enrollments_paused = true
   WHERE tenant_id IS NULL; -- global pause
   ```
   Existing enrollments continue; new triggers are buffered.

## Investigation

1. **Pprof the workers.** Each automation worker exposes `/debug/pprof`.
   Capture CPU + goroutine + heap profiles. Common patterns:
   - 90%+ goroutines blocked on a single mutex → scheduler contention,
     usually around the rate limiter shared by `send` steps.
   - Goroutines blocked on Postgres → DB issue, see `database-incident.md`.
   - Goroutines blocked on Listmonk transactional API → check Listmonk
     queue, may be feeding-back pressure.
2. **Check the clock-skew bug.** The simulated-clock test header
   (`X-Postwave-Clock-Speedup`) is staging-only. If it leaked into prod
   somehow, `wait` steps fire at the wrong time. Verify via:
   ```sql
   SELECT enrollment_id, current_step, scheduled_for, NOW() - scheduled_for AS overdue
   FROM automation_steps WHERE state = 'pending'
   ORDER BY overdue DESC LIMIT 20;
   ```
3. **Listmonk feedback.** If `send` steps are stuck, Listmonk's
   `/api/tx` may be 5xx-ing or its outbound queue may be saturated. Pull
   Listmonk logs.
4. **Asynq scheduler health.** Asynq's own scheduler can falter if Redis
   has lost data. `redis-cli INFO replication` + `INFO persistence`.

## Resolution

### Restart procedure (graceful)
1. Drain workers gracefully (SIGTERM; they finish the in-flight task).
   `kubectl rollout restart deploy/automation-worker`.
2. Workers come back, pick up `pending` and `retry` queues.
3. Monitor `automation_step_duration_ms` returning to baseline (<200ms p99).

### Dead-letter inspection / replay
1. Pull each dead message into a JSON file for offline review:
   ```
   asynq task export --queue automation.send --state archived > dl.jsonl
   ```
2. For each, decide:
   - **Code bug** that we've since fixed → replay:
     `asynq task replay --queue automation.send --task-id <id>`.
   - **Recipient-level** issue (invalid email, hard bounce) → drop with
     `asynq task delete` and write a `automation_failures` row so the
     UI can show the customer.
   - **Unknown** → leave in dead-letter, escalate.
3. Always replay in batches with concurrency cap to avoid re-flooding.

### Poison-pill quarantine
If one task type is causing repeated failures, route it to a quarantine
queue:
```go
// services/automation/internal/scheduler/queues.go
QueueQuarantine = "automation.quarantine"
```
And bump worker concurrency on that queue to 1.

---

## Post-mortem template

```
## Automation runtime stall — <date>
**Detected:** <ts>      **Resolved:** <ts>      **Severity:** SEV<N>
**Backlog peak:** N tasks across M queues
**Affected enrollments:** K (P50 delay <X>, P99 delay <Y>)

### Root cause
- <single sentence>

### Why detection lagged
- <if applicable>

### Followups
- [ ] Per-tenant rate limit (so one tenant cannot wedge the global queue)
- [ ] Quarantine queue routing for known poison-pill task types
- [ ] Listmonk-tx circuit breaker
- [ ] Add `enrollment_age_seconds` SLO to dashboard
```

## Communication templates

Internal:

> [SEV2] Automation runtime backlog
> Queue depth: 8.2K tasks; cause: <reason>; ETA drain: <duration>.
> New enrollments paused at <ts>; will resume after backlog clears.

Customer (only if delays exceeded the email's own scheduled delay by
>30 min):

> A few of your sequence emails went out late between <start> and
> <end> due to a brief processing slowdown on our side. Recipients still
> got the messages in the right order; only the timing slipped. Apologies.
