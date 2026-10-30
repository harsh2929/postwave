# Runbook — Migration Job Failure

When a Pillar 1 migration (Mailchimp / ConvertKit / Substack / Beehiiv /
MailerLite / CSV) fails partway through. Migrations are designed to be
idempotent and resumable, but human judgment is needed when the source
platform throws unexpected shapes or our adapter hits an unhandled edge.

---

## Symptoms

- `migrations.state = 'failed'` row in Postgres.
- Inngest run shows a non-retried terminal error.
- UI shows the user a "We hit a snag" card with the run ID.
- `migration_failures_total` Prometheus counter incremented.

## Detection

- Sentry captures the unhandled error with `migration_id`, `tenant_id`,
  `source`, `step`, `cursor`, and the raw source-platform response body
  (PII-redacted).
- An automated PagerDuty SEV3 page fires for *any* migration failure
  during business hours; SEV2 if the same tenant has failed twice in 24h.
- Daily report to `#migrations` with all failures from the previous day.

## Severity matrix

| Condition | Severity |
|---|---|
| Single failure, retried successfully on next attempt | SEV4 (info only) |
| Failure persists after 3 retries | SEV3 |
| Same source platform fails for ≥3 distinct tenants in 24h | SEV2 |
| Data-loss potential (duplicate writes, partial commits without rollback) | SEV1 |

---

## Immediate response

P0 (SEV1):
1. **Halt all active migrations** for that source by flipping the
   per-source feature flag in `migration_config`:
   ```sql
   UPDATE migration_config SET enabled = false WHERE source = $1;
   ```
2. Notify the customer: data integrity is at risk; we're holding their
   import rather than continuing.
3. Page the migration lead.

P1/P2:
1. **Pull the failed run state.**
   ```sql
   SELECT id, source, state, last_cursor, last_error, attempts
   FROM migrations WHERE id = $1;
   ```
2. Pull the audit log entries from the run:
   ```sql
   SELECT step, resource, count_in, count_out, started_at, ended_at
   FROM migration_audit_log
   WHERE migration_id = $1
   ORDER BY started_at;
   ```
   The last successful row's `cursor` is your resume point.

## Investigation triage

```
                      ┌── source rate-limited (HTTP 429 in last_error)
                      │     → wait, then retry; tune rate limiter
                      │
   migration failed ──┼── source returned a shape we don't handle
                      │     → patch adapter, add fixture test, redeploy, retry
                      │
                      ├── data integrity tripwire fired (count mismatch >0.5%)
                      │     → DO NOT auto-retry; rollback and re-discover
                      │
                      └── infrastructure (Postgres, Listmonk down)
                            → fix infra, retry; run automatically resumes
```

### Rate-limit failures
1. Inspect `last_error` for `Retry-After` or platform-specific headers.
2. Update the adapter's rate limiter (`internal/adapter/<source>/limiter.go`)
   to honor the new limit if the platform changed it (Mailchimp lowered
   their limit from 10 → 5 RPS in 2024 silently, for example).
3. Retry: `POST /v1/migrations/{id}/resume`.

### Adapter shape regressions
1. Save the offending payload to `services/migration/internal/adapter/<source>/fixtures/<date>-<descriptor>.json`.
2. Write a failing test using that fixture.
3. Patch the canonicalizer to handle the shape. Common cases:
   - Mailchimp returning `merge_fields: {}` instead of `[]` for empty
   - ConvertKit returning `null` for `unsubscribed_at` mid-page
   - Substack CSV with BOM bytes ahead of the header
4. Deploy. Then `POST /v1/migrations/{id}/resume` from the last
   successful cursor. The run is idempotent — already-imported
   subscribers are upserted, not duplicated.

### Data integrity tripwire
The migration runtime computes a checksum `(count, sum(hash(email)))`
per resource. If the post-import counts don't match the pre-discovery
counts within 0.5%, the run is halted automatically.

1. **Do not auto-retry.** Open the dry-run verification report side-by-side.
2. Check whether the source platform has paginated dynamically (some APIs
   reorder under load and skip rows when paginated by `?since=ts` rather
   than cursor). Switch to cursor-based pagination if available.
3. **Decide rollback vs forward-fix.** Rollback rules:
   - If `commit_at` is < 7 days ago → rollback is the cheap option.
     `POST /v1/migrations/{id}/rollback`.
   - If `commit_at` ≥ 7 days → user has likely sent campaigns; forward-fix
     by re-running discovery and importing only missing rows.

### Infrastructure failures
- Listmonk down: see `automation-runtime-stuck.md` for the underlying
  health check; once healthy the Inngest run resumes.
- Postgres down: see `database-incident.md`.

## Resolution

1. State transitions: `failed` → `running` (resume) or `failed` → `rolled_back`.
2. UI sends an email to the customer when the migration completes.
3. If we patched an adapter, ship the regression test alongside.

---

## Post-mortem template

```
## Migration failure — <migration_id>
**Source:** <mailchimp|convertkit|substack|...>
**Tenant:** <tenant_id>
**Detected:** <ts>      **Resolved:** <ts>

### Failure mode
<rate-limit | adapter shape | data integrity | infra>

### Pre-existing protections that did/didn't help
- [ ] Idempotency key prevented duplicate writes
- [ ] Cursor resume worked
- [ ] Audit log made debugging trivial

### Adapter patch (if any)
PR: #...
Fixture: <path>

### Followups
- [ ] Add adapter rate-limit observability metric
- [ ] Update onboarding warning if shape varies by plan tier
```

## Communication templates

Customer (initial):

> Hey — your <Source> import paused at step "<step>" while we look
> into the response we got from <Source>. We've kept all data already
> imported safely; we'll resume automatically once we patch the issue
> (typically within a few hours). You'll get an email when it's done.

Customer (resolved):

> Your <Source> import resumed and finished — N subscribers,
> M segments, K archived campaigns brought across. The verification
> report is at <link>. Welcome to Moosewave.
