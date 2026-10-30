# Email Verification and Recipient Health Operations

Owner: Deliverability + Platform on-call

Applies to: `apps/api/internal/verification`, subscriber forms/imports, and the
campaign send-time recipient safety gate

## Purpose and support boundary

Moosewave combines free local checks, an optional tenant-provided ZeroBounce or
Kickbox account, and Moosewave's own consent, suppression, bounce, complaint,
delivery, human-classified click, and human-reply records. It returns canonical verification
statuses and the `postwave-email-health-v1` A/B/C/D/F/U health model.

This is not a proprietary contact database, a proprietary cross-customer
signal network, an unlimited data product, or a guarantee that a message will
deliver. Vendor requests consume the tenant's vendor credits. Health grades
are a decision aid; they never create consent or override a suppression.

## Architecture

The verification path is deliberately layered:

1. A tenant cache is checked by normalized email address.
2. The local tier checks syntax, DNS/MX, disposable domains, role addresses,
   and common domain typos. Built-in disposable-domain and functional-role
   matches are advisory. Only an explicit constructor-level disposable
   override is terminal, and production composition does not currently supply
   one. The tier performs no SMTP mailbox probe and can never prove `valid`.
3. Undecided addresses may go to the tenant's enabled provider. Moosewave does
   not run SMTP `RCPT TO` probes from its own sending infrastructure.

Local DNS/MX work is process-bounded: same-domain cache misses coalesce, lookup
concurrency defaults to 32 across all tenants, and the shared LRU retains at
most 4,096 domains. Those limits are composition/test seams rather than
tenant-controlled settings, so tenant input cannot expand process resources.
4. The health resolver combines verification with tenant-local consent,
   suppressions, subscriber events, and classified human replies.
5. Campaign dispatch first applies canonical consent/suppressions, then adds
   terminal verification and recent negative evidence as an additional block.
   The same composition runs in batch preflight and immediately before
   dispatch.

Synchronous paid-verification batches are capped at 8 addresses; synchronous
health-only batches remain capped at 1,000. Durable verification jobs are
capped at 250,000 addresses and use provider-aware claims: up to 100 rows for
ZeroBounce/local chains, but at most one eight-address fan-out window for
Kickbox. Claims use a 10-minute lease and yield after 20 batches so tenants can
interleave. The worker polls every 15 seconds when idle. ZeroBounce calls are
chunked at 100; Kickbox fans out bounded single-address requests.
Every ZeroBounce real-time batch first reserves a tenant/provider-wide slot in
`verification_provider_batch_slots`. The table has RLS enabled and forced, and
its two-second reservation clock is shared by synchronous calls, durable jobs,
and every application replica. If a caller is cancelled or its lease expires
after reserving a slot but before dispatch, that slot is intentionally
abandoned; it is never reused because reuse could exceed the provider's
30-batch-per-minute account limit.
Single-provider calls time out after 30 seconds; ZeroBounce real-time batches
use a dedicated 75-second response-header budget around its documented
70-second provider ceiling and an 80-second HTTP envelope. Other integrations
retain the shared 15-second response-header budget.

Provider origins are fixed in code to official HTTPS endpoints. Redirects are
rejected and the shared integration-egress boundary blocks private or reserved
destinations. Tenant settings cannot replace provider origins.

The ZeroBounce adapter is currently pinned to the vendor's official default
`api.zerobounce.net` origin. Although ZeroBounce also offers `api-us` and
`api-eu` endpoints, Moosewave does not yet expose regional endpoint selection.
A tenant contractually requiring a regional ZeroBounce endpoint must keep full
mode and provider egress disabled until a reviewed allowlisted enum and
credential-probe rollout exists. Arbitrary tenant-supplied origins are not an
acceptable workaround.

## Canonical verdicts and health grades

Verification statuses are `valid`, `invalid`, `catch_all`, `spamtrap`,
`abuse`, `do_not_mail`, and `unknown`. Grades are resolved at an explicit
`as_of` time; evidence more than five minutes in the future is ignored.

| Grade | Exact `postwave-email-health-v1` meaning | Recommendation | Eligible absent consent/suppression block? |
|---|---|---|---|
| A | External ZeroBounce/Kickbox verdict `valid`, checked within 30 days, with no higher-precedence negative | `send` | Yes |
| B | High-confidence first-party human reply, explicitly human-classified click, or delivered event within 90 days, newer than any recoverable negative | `send` | Yes |
| C | External ZeroBounce/Kickbox verdict `catch_all` | `caution` | Yes |
| D | Historical hard bounce, soft bounce, or ambiguous negative within 30 days and not superseded by a newer trusted positive | `do_not_send` | No |
| F | `invalid`, `spamtrap`, `abuse`, or `do_not_mail`; a complaint; or a current authoritative consent/suppression hard stop, including an active hard-bounce suppression | `blocked` | No |
| U | Stale `valid`, open-only evidence, or no decisive evidence | `caution` | Yes |

An active temporary soft-bounce suppression preserves grade D while changing
the recommendation to `blocked`. Historical hard and soft bounce events age to
U after 30 days and can be retired by a genuinely newer trusted delivery,
human-classified click, or human reply; an active canonical hard-bounce
suppression remains F.
If verification succeeds but tenant evidence cannot be read, the response is U
with `evidence_complete=false` and `send_eligible=false`; callers must fail
closed. Opens alone never earn B.

The current B sources are Moosewave first-party deliveries, explicitly
human-classified clicks, and human-classified campaign replies. The internal
vocabulary reserves a `vendor_activity` evidence kind for wire compatibility,
but it is advisory: it cannot earn B or retire negative evidence, and no
runtime vendor-activity feed currently populates it.

## Consent and enforcement precedence

The order is load-bearing:

1. Canonical consent and active suppression state is authoritative. An
   unsubscribe, complaint, missing consent proof, or active suppression cannot
   be cleared by A, B, a provider result, or later engagement.
2. Terminal mailbox/safety evidence adds a block: invalid, spamtrap, abuse,
   do-not-mail, complaint, or an active canonical hard stop.
3. Recent recoverable negatives are compared chronologically with trusted
   positives.
4. A/B/C/U may guide an operator only after steps 1-3 are clear.

A stored positive subscriber address can be hidden from the application role
when its exact-address consent proof is missing or expired. Health resolution
uses a scalar identity predicate so a later suppression-state write cannot make
that hidden primary or secondary address look like suppression-only history.
The predicate is owned by a dedicated no-login, no-membership BYPASSRLS role
with `SELECT` on only `subscriber_emails.(tenant_id,email)`; it requires exact
`app.tenant_id` equality before its fixed query and returns one boolean, never
subscriber or consent data. Do not broaden its grants or replace the tenant
check with a caller-controlled bypass policy.

### Public form signup

The tenant policy defaults to `forms_mode=off`. `local` uses only free checks.
`full` requires the configured vendor for non-local decisions. The default
rejection set is the complete terminal provider set: `invalid`, `spamtrap`,
`abuse`, and `do_not_mail`. A role/functional mailbox is cautionary rather than
terminal in the local and provider mappings, so addresses such as `sales@` are
not rejected merely because they are role based. The configurable rejection
vocabulary also permits `catch_all` and `unknown`, but never `valid`; runtime
reads fail closed on malformed legacy policies and migration 2005 prevents new
or updated rows from storing a non-rejectable status.

The paid gate runs after required-field, syntax, CAPTCHA, and recent-submission
checks and before subscriber mutation. Full-mode anonymous paid egress requires
an explicit successful server-side CAPTCHA authorization. A missing/failed
authorization, a legacy/JavaScript-disabled submission, or a hosted submission
without its browser token is restricted to local-only checks and is visibly
degraded; it never makes an unreceipted paid call.

The hosted browser mints at least 128 bits of opaque submission-attempt entropy
and preserves that ID only for an exact transport retry. It rotates the ID when
authored intent changes or after a deterministic response, and resets/re-arms
CAPTCHA while retaining the same ID after an uncertain response. The server
stores a tenant-wide normalized-address digest reservation plus a tenant/form-
scoped attempt digest and request fingerprint for 24 hours. Raw attempt tokens,
addresses, bodies, and provider errors are never stored in either receipt.

The identity reservation is pending before provider work, and the owner-attempt
digest is committed as a durable lease. The dispatch boundary is committed
before egress. A fresh pending reservation—whether the retry uses the same
token, a distinct token, or another form—returns `503` with `Retry-After`; it
cannot mutate a subscriber or race ahead of an eventual invalid verdict. A
stale reservation that never dispatched can be safely reclaimed by one exact
attempt. A stale or failed post-dispatch outcome becomes terminal ambiguous and
can never redispatch. Exact terminal retries replay their original decision;
new attempts reuse only policy-neutral status evidence and apply the tenant's
current policy. Reusing one attempt ID with changed input is rejected.

Storage uncertainty before a receipted call remains local-only. Configuration,
credit, auth, and vendor failures that are durably terminal admit the signup
with a degraded decision. A decisive local rejection still stands during a
vendor outage. This fail-open policy protects real signups; it also makes
degraded-admission and retryable telemetry important.

### Subscriber import

Import preflight is a no-credit projection: it reports local decisions, cache
hits, addresses needing a mailbox probe, and estimated credits. Confirmation
freezes the reviewed `off`, `local`, or `full` policy. A changed policy forces a
new preflight.

For a confirmed `local` or `full` import, the worker binds one idempotent
durable verification job and waits for a complete immutable decision set before
any subscriber or consent mutation. `full` is fail closed and cannot degrade to
local after confirmation. Rows with `invalid`, `spamtrap`, `abuse`, or
`do_not_mail` are omitted and receive the privacy-bounded row error
`email_verification_rejected`; `rows_verification_rejected` is incremented.

### Campaign sending

The recipient safety gate wraps the existing suppression converger. It can only
add a block. Terminal verification and complaint evidence block while retained;
historical hard/soft bounces and ambiguous negatives block for 30 days unless a
newer trusted positive retires them. Active canonical hard-bounce suppressions
remain authoritative. Evidence-read errors or incomplete result maps withhold
recipients rather than sending.

## API and authorization

| Surface | Scope |
|---|---|
| `POST /api/v1/verification/verify` | `write:subscribers` |
| `POST /api/v1/verification/verify-batch` | `write:subscribers` |
| `GET /api/v1/verification/health`, `POST /health/batch` | `read:subscribers` |
| Create/cancel durable jobs | `write:subscribers` |
| List/get jobs and results | `read:subscribers` |
| Provider and policy GET/PUT/DELETE | `admin` |
| Credits/cache summary | `read:subscribers` |
| Targeted cache invalidation | `write:subscribers` |

Verification reads and result-bearing responses contain tenant evidence and use
`Cache-Control: private, no-store`. Health-bearing surfaces additionally emit
`Pragma: no-cache`.

Every synchronous verify, synchronous verify-batch, and durable-job POST
requires exactly one printable UTF-8 `Idempotency-Key` of 1-255 bytes, with no
leading or trailing whitespace. The key is exact and is not normalized. The
synchronous endpoints use the shared tenant/principal-scoped HTTP ledger for 24
hours: the same key, method, path, query, and byte-identical body replays the
original deterministic 2xx/4xx response; different input returns
`422 idempotency_key_request_mismatch`; a concurrent or uncertain ledger entry
returns `409 idempotency_key_in_progress` with `Retry-After`. Transient 5xx
responses before billable dispatch are not retained.

Once a synchronous request crosses the vendor boundary, an uncertain provider
outcome returns the retained conflict
`409 verification_provider_outcome_ambiguous`; retrying the same key cannot
dispatch it again. If persisting an executed handler's replay response itself
fails, its pending claim is retained for operator reconciliation rather than
deleted. Durable inline/upload jobs additionally bind their key to the
normalized source, execution mode, and address set. Dynamic tag/all-subscriber
jobs bind the selector and mode; the first resolved membership is frozen in job
items, and an exact key replay returns that job even if membership later
changes. Generate a new key only when an operator has intentionally approved
new billable work.

Supported sources are `inline`, `upload`, `tag`, and `all_subscribers`.

## Provider credential provisioning

Supported provider identifiers are `zerobounce` and `kickbox`. At most one is
enabled for a tenant.

`credential_ref` is a tenant-local identifier matching
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. The server, not API input, derives the
secret name:

```text
postwave/tenants/<tenant-uuid>/verification/<provider>/<credential-ref>
```

Provision that exact name through the production secrets/IaC workflow before
calling the provider API. The value may be a single-line raw API key, or a JSON
object with one string field named `api_key`, `apiKey`, `apikey`, `token`, or
`key`. The resolved secret is limited to 16 KiB. Raw keys must never be placed
in Postgres, API payloads, tickets, logs, screenshots, or shell history.

Production uses AWS Secrets Manager when `POSTWAVE_SECRETS_BACKEND=aws` and
`AWS_REGION` is configured; environment lookup remains the fallback. AWS
values are cached in-process for five minutes and each lookup is capped at five
seconds. For local development, the environment name is the full derived path
uppercased with `/`, `-`, and `.` replaced by `_`.

Configure only after the secret exists:

```bash
curl --fail-with-body -X PUT \
  "$POSTWAVE_API_BASE/api/v1/verification/providers/zerobounce" \
  -H "Authorization: Bearer $POSTWAVE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{
    "credential_ref": "primary-2026-08",
    "enabled": true,
    "settings": {
      "cache_ttl_days": 30,
      "degrade_on_failure": false
    }
  }'
```

The PUT resolves the tenant-bound secret and performs a live credit-balance
probe before mutating the database. A bad proposed key cannot replace a working
configuration. Rotate by provisioning a new credential identifier and PUTting
that reference; retire the old secret after the probe and observation window.
Updating a value under the same AWS name can remain cached for five minutes;
environment-backed rotation requires a process restart.

Allowed settings are:

- `cache_ttl_days`: `0` means the 30-day default; valid explicit range is
  1-180 days.
- `degrade_on_failure`: permits fallback only for explicitly advisory internal
  chain callers. Billable synchronous APIs, full signup decisions, and durable
  jobs/imports override this to strict behavior so an uncertain provider charge
  is never presented as a harmless local result.
- `ip_address`: optional valid IPv4/IPv6 input for ZeroBounce enrichment.

## Runtime controls

| Control | Effect |
|---|---|
| `POSTWAVE_DISABLE_VERIFICATION_BULK_JOBS=1` | Rejects new HTTP durable-job creation with 503 before reading the body; existing jobs continue. |
| `POSTWAVE_DISABLE_VERIFICATION_JOB_RUNNER=1` | After restart, stops durable-job execution. Pending work remains queued and linked imports remain fail closed until the seven-day non-terminal watchdog safely fails abandoned jobs. Job creation is controlled separately. |
| `POSTWAVE_DISABLE_SUBSCRIBER_IMPORT_WORKER=1` | Stops the subscriber-import worker after restart; use when freezing confirmed imports. |
| `POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE=1` | After restart, removes only the additive verification-health send gate. Canonical consent and suppression checks remain active. |
| Tenant `forms_mode` / `import_mode` = `off` | Stops verification on future form decisions or newly confirmed imports. Existing frozen imports retain their reviewed mode. |
| Delete the enabled provider configuration | Prevents future vendor-chain construction. An already dispatched request may still settle. The secret itself is not deleted. |
| Targeted `DELETE /api/v1/verification/cache` | Invalidates reusable cache rows for up to 1,000 validated addresses per transaction, forcing a re-check. Retained terminal health evidence continues blocking until a newer trusted validation supersedes it. Whole-cache deletion is intentionally unsupported. |

Creation, execution, import orchestration, and additive send enforcement have
separate switches. This separation is intentional: for example, stopping the
runner keeps paid work durable and queued during an intervention without
weakening consent or allowing a linked import to mutate subscribers. The
retention janitor fails work still abandoned after seven days; the runner kill
switch is not an indefinite queue archive.

## Deployment and rollout

The feature depends on these migration filename stems, in migrator order:

- `1839_email_verification`
- `1850_verification_policy`
- `1953_verification_bulk_job_safety`
- `1954_email_health_grade`
- `1956_subscriber_import_verification_enforcement`
- `1997_verification_signup_attempt_fence`
- `2001_verification_result_contract`
- `2004_verification_provider_batch_pacing`
- `2005_verification_policy_rejectable_contract`
- `2006_verification_subscriber_email_identity_predicate`

Do not infer migration identity from the leading number alone: this repository
allows multiple files with the same numeric prefix and records the full stem.

Dry-run and apply from the repository root:

```bash
go -C apps/api run ./cmd/migrate \
  --dir ../../infra/migrations \
  --database-url "$DATABASE_URL" \
  --dry-run \
  --timeout 20m

go -C apps/api run ./cmd/migrate \
  --dir ../../infra/migrations \
  --database-url "$DATABASE_URL" \
  --timeout 20m
```

Exit code 2 is checksum drift, 3 is lock contention, and 5 is an unsafe
migration finding. Stop rather than bypassing any of them.

Recommended rollout:

1. Apply migrations before deploying the binary. Keep all tenant policies off,
   set the bulk-job kill switch, and leave the subscriber-import worker off if
   the new import path has not yet been certified.
2. Deploy the binary and confirm both verification workers are alive. Validate
   FORCE RLS with two test tenants.
3. Provision a canary tenant's secret, configure the provider, and verify the
   reported balance is timestamped. Test controlled valid, invalid, catch-all,
   and provider-failure fixtures; never use a production recipient as a probe.
4. Run a small durable job with a recorded spend acknowledgement. Confirm
   idempotent replay returns the same job and that cache hits do not spend again.
5. Enable form `local` mode for the canary, then `full` only after degraded-path
   monitoring exists. Exercise an exact browser transport retry, a changed
   intent, and a JavaScript-disabled submission before expanding. Enable import
   `local`, then a small `full` import and reconcile rejected rows.
6. Remove the bulk-job kill switch progressively. Watch credit usage,
   ambiguity, hard-bounce/complaint rates, send-gate errors, and cache backlog.

## Workers and RLS

All verification/provider/cache/job/policy/snapshot/signup-identity and
signup-attempt tables use FORCE RLS. Normal reads and writes require
`app.tenant_id`.

Cross-tenant job discovery is allowed only while `app.outbox_worker=true` and
only on `verification_jobs`; every item/result mutation re-enters tenant worker
scope. Cache maintenance can select/delete only rows whose `expires_at <= now()`.
The subscriber-import worker retains the existing tenant-worker boundary.

The retention janitor runs hourly. In each tick it may delete or scrub up to
10,000 eligible rows from each affected table:

- non-terminal jobs older than seven days are first failed only when neither
  the parent nor any leased item has a live lease; request-started items become
  terminal `ambiguous`, while undispatched leases return to the canonical
  pending shape. This starts a definite completion-based retention clock even
  if the provider runner stays disabled or crash-looping;
- expired non-terminal cache rows immediately;
- expired terminal `invalid`, `spamtrap`, `abuse`, and `do_not_mail` cache rows
  only once `checked_at` is at least 365 days old;
- health snapshots once `computed_at` is at least 365 days old;
- per-address job items only when their parent job is terminal and completed at
  least 365 days ago;
- expired public-form verification identity reservations after their fixed
  24-hour replay window; linked exact-attempt receipts cascade in the same
  bounded deletion.

The per-table worker RLS policies enforce those same predicates. Aggregate job
rows remain for accounting, but after 365 days the janitor clears `source_ref`,
`idempotency_key`, `request_fingerprint`, and `created_by` in bounded batches.
Expired cache rows are never reused to avoid a vendor call. Retaining terminal
rows past refresh expiry keeps the send gate from forgetting a known trap
merely because the ordinary cache TTL elapsed, while the 365-day ceiling
prevents indefinite plaintext retention.

Health reads materialize one snapshot per tenant/address. Valid verification
older than 30 days grades U even if a longer cache TTL retains the row.

Never troubleshoot FORCE RLS by disabling it or setting a broad tenant bypass.
Use the normal application role with an explicit tenant transaction. Reserve
fleet-wide, non-PII aggregate queries for the approved monitoring role.

## Detection and alerts

Existing HTTP telemetry is:

- `pw_http_requests_total{method,status_class,route}`
- `pw_http_duration_seconds_bucket{route}`
- `postwave_sendloop_recipient_health_gate_total{reason}` where reason is one
  of `verification_invalid`, `verification_spamtrap`, `verification_abuse`,
  `verification_do_not_mail`, `hard_bounce`, `hard_complaint`,
  `recent_negative`, `error`, or `incomplete`
- `postwave_sendloop_suppression_decision_unavailable_total{reason}`
- `postwave_forms_signup_verification_total{outcome}` where fail-open outcomes
  are `degraded_allowed` and `error_allowed`, and an in-flight spend fence is
  `retryable`
- `postwave_email_verification_provider_batches_total{provider,outcome}`
- `postwave_email_verification_provider_addresses_total{provider,outcome}`
- `postwave_email_verification_credits_spent_total{provider}`
- `postwave_email_verification_usage_persistence_failures_total{surface}`
- `postwave_email_verification_jobs_terminal_total{status,failure_code}`
- `postwave_email_verification_evidence_purge_total{outcome}`
- `postwave_email_health_decisions_total{grade,evidence_complete}`
- `postwave_email_health_evidence_unavailable_total`

Provider metric outcomes are the closed set `success`, `ambiguous`,
`no_credits`, `unauthorized`, `account_rejected`, `not_configured`,
`unavailable`, and `error`.

Minimum alerts:

```promql
sum(rate(pw_http_requests_total{route=~"/api/v1/verification/.*",status_class="5xx"}[5m])) > 0

increase(postwave_sendloop_recipient_health_gate_total{reason=~"error|incomplete"}[5m]) > 0

increase(postwave_forms_signup_verification_total{outcome=~"degraded_allowed|error_allowed"}[5m]) > 0

increase(postwave_email_verification_jobs_terminal_total{status="failed",failure_code="verification_outcome_ambiguous"}[5m]) > 0

increase(postwave_email_verification_jobs_terminal_total{status="failed",failure_code="verification_job_retention_timeout"}[1h]) > 0

increase(postwave_email_verification_provider_batches_total{outcome=~"no_credits|unauthorized|account_rejected|not_configured|unavailable|error|ambiguous"}[5m]) > 0

increase(postwave_email_verification_usage_persistence_failures_total[5m]) > 0

increase(postwave_email_health_evidence_unavailable_total[5m]) > 0

sum(increase(postwave_sendloop_recipient_health_gate_total{reason=~"verification_.*|hard_.*|recent_negative"}[1h]))
```

The third query is an anomaly signal, not a page by itself; compare it with
recipient volume and established baselines. Never add tenant IDs or email
addresses as Prometheus labels.

Alert from database aggregates when:

- any job has `failure_code=verification_outcome_ambiguous`;
- any job has `failure_code=verification_job_retention_timeout` (the job was
  abandoned for seven days without a live parent or item lease);
- pending work is materially older than the 15-second poll interval;
- a running lease remains expired beyond the 10-minute lease window;
- `verification_no_credits`, `verification_provider_unauthorized`, or
  `provider_not_configured` appears;
- eligible cache, health-snapshot, terminal job-item, job-metadata, or expired
  signup-identity retention backlog grows faster than its per-table 10,000
  rows/hour sweep budget;
- an import remains in verification `pending`/`running` without corresponding
  job progress.

Useful non-PII tenant-scoped snapshot:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :'tenant_id', true);

SELECT status,
       COALESCE(NULLIF(failure_code, ''), 'none') AS failure_code,
       count(*) AS jobs,
       min(created_at) AS oldest_created_at,
       sum(total) AS addresses,
       sum(processed) AS processed,
       sum(ambiguous) AS ambiguous,
       sum(credits_spent) AS recorded_credits
  FROM verification_jobs
 WHERE created_at >= now() - interval '7 days'
    OR completed_at >= now() - interval '7 days'
 GROUP BY status, COALESCE(NULLIF(failure_code, ''), 'none')
 ORDER BY status, failure_code;

SELECT count(*) AS expired_cache_rows
  FROM verification_cache
 WHERE expires_at <= now()
   AND (
       status NOT IN ('invalid', 'spamtrap', 'abuse', 'do_not_mail')
       OR checked_at <= now() - interval '365 days'
   );

SELECT count(*) AS expired_health_snapshots
  FROM email_health_snapshots
 WHERE computed_at <= now() - interval '365 days';

SELECT count(*) AS expired_job_items
  FROM verification_job_items AS item
  JOIN verification_jobs AS job
    ON job.tenant_id = item.tenant_id AND job.id = item.job_id
 WHERE job.status IN ('completed', 'failed', 'canceled')
   AND job.completed_at <= now() - interval '365 days';

SELECT count(*) AS expired_signup_identity_reservations
  FROM verification_signup_identities
 WHERE expires_at <= now();

SELECT grade, count(*) AS snapshots
  FROM email_health_snapshots
 GROUP BY grade
 ORDER BY grade;

ROLLBACK;
```

Relevant log messages are:

- `verification: poll for pending jobs`
- `verification: job failed`
- `verification: could not record provider rejection`
- `verification: could not record ambiguous provider outcome`
- `verification: could not record job failure`
- `verification: recipient health evidence unavailable after verification`
- `verification cache purge failed`
- `verification cache purged`
- `subscriber_import: linked verification cancellation failed`
- `subscriber_import: verification projection failed; omitting it from the preview`
- `forms: signup verification gate failed; admitting submission`
- `forms: signup verification degraded`

## Severity matrix

| Severity | Example |
|---|---|
| SEV0 | Credential/PII exposure, cross-tenant result access, or RLS bypass |
| SEV1 | Campaign safety gate is unavailable fleet-wide; unsafe recipients were sent; widespread incorrect terminal verdicts; fleet-wide ambiguous paid calls |
| SEV2 | Multi-tenant provider/job outage, imports stuck before mutation, cache purge backlog threatening storage, or sustained degraded signup admission |
| SEV3 | One tenant has an exhausted/unauthorized key, one stuck job, or a bounded cache inconsistency |
| SEV4 | Last-known balance shown during a failed live probe, dashboard/reporting gap, or documentation drift with no enforcement impact |

## Immediate response

### SEV0

1. Disable new bulk jobs and subscriber-import execution. Set both tenant
   policies off for affected tenants. Disable the verification job runner if
   already queued paid work must stop.
2. Remove the affected provider config and contain the secret through the
   secrets incident process. Do not copy raw material into the incident room.
3. Preserve audit/job evidence, engage Security/DPO, and follow the database
   incident runbook for any RLS suspicion.

### SEV1

1. Stop new paid work with the bulk-job and job-runner kill switches and set
   policies off. Pause the import worker if confirmed imports are involved.
2. If provider egress must stop, delete the enabled config. Allow already
   dispatched calls to settle; do not restart them blindly.
3. If the campaign health gate is returning `error`/`incomplete`, sends already
   fail closed. Keep them withheld until evidence reads recover. If the gate is
   producing wrong blocks, set `POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE=1` and
   restart; the rollout helper preserves canonical consent/suppression checks.
4. Identify whether results are unbilled failures or ambiguous requests before
   approving any rerun.

### SEV2/SEV3

1. Scope by tenant, provider, job ID, failure code, and time range without
   copying addresses.
2. Verify credential reference, enabled provider, balance timestamp, policy,
   job lease, worker logs, and expired-cache count.
3. Apply the matching resolution below and monitor a controlled canary.

## Failure codes and resolution

| Code/symptom | Meaning | Safe action |
|---|---|---|
| `verification_outcome_ambiguous` | A provider request crossed the durable request-start boundary but no complete result was recorded | Do not auto-retry. Reconcile the provider's request/billing evidence and ambiguous item count; approve a new idempotency key only if duplicate cost/risk is accepted. |
| `verification_no_credits` | Provider explicitly rejected work before a partial outcome | Add provider credits, verify the balance out of band, then intentionally create a new job. The old idempotency key returns the failed job. |
| `verification_provider_unauthorized` | Provider rejected the configured credential | Provision a new credential ID and PUT it; the live balance probe must pass before the config changes. |
| `provider_not_configured` / `verification_not_configured` | Full execution has no usable enabled provider or secret | Correct secret/backend/configuration. Local APIs still work, but full durable imports/jobs fail closed. |
| `verification_provider_unavailable` | A provider failed before billable dispatch, or an advisory caller did not dispatch billable work | Check provider status and egress/DNS. A synchronous failure after dispatch is instead retained as `verification_provider_outcome_ambiguous`; durable full work never degrades. |
| `verification_job_retention_timeout` | A pending/running job exceeded seven days with no live parent or item lease; the janitor terminalized it to bound address retention | Fix the worker/queue outage before creating a new job. Any request-started item is separately preserved as ambiguous and must not be retried automatically. |
| `verification_job_failed` | Non-specific durable failure | Inspect safe server logs and job lease state; fix the cause before a new billable run. |
| Job stays `running` with expired lease | Worker died or lost its lease | Let the normal claimant reconcile it. Items with a request-start receipt become ambiguous; undispatched leased items return to pending. Do not mutate attempt rows manually. |
| Health is U unexpectedly | No decisive evidence, stale valid result, or open-only activity | Inspect checked/evidence timestamps and `reason_codes`; U is not proof of invalidity. Reverify only with approved spend. |
| Send queue is withheld | Canonical suppression, terminal/recent health evidence, or unavailable evidence | Inspect bounded reason metrics first. Never clear consent/suppression to work around a health incident. |

`credits_spent` records durably accepted billable results. An ambiguous provider
call may still have been charged upstream, so Moosewave's recorded value is a
lower bound until reconciliation.

## Cache invalidation and recovery

Use targeted invalidation only for a known stale/mis-mapped address set:

```bash
curl --fail-with-body -X DELETE \
  "$POSTWAVE_API_BASE/api/v1/verification/cache" \
  -H "Authorization: Bearer $POSTWAVE_WRITE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"emails":["controlled-fixture@example.test"]}'
```

Invalidation transactionally removes reusable provider results and may cause
the next check to spend credits. It deliberately preserves derived snapshots
and terminal verification chronology; invalidation alone is not proof that a
known invalid/trap result recovered. A newer trusted external validation is
persisted before it may supersede that terminal history, including across a
later cache expiry. It does not change consent, suppressions, or durable job
items. Canonical suppression still takes precedence after invalidation.
Complete a controlled re-verification before treating an address as recovered,
and do not clear whole tables or manually mutate evidence during a provider
incident.

## Rollback and disablement

1. Set `forms_mode` and `import_mode` off for future decisions.
2. Enable `POSTWAVE_DISABLE_VERIFICATION_BULK_JOBS=1` and restart to reject new
   HTTP jobs. Enable `POSTWAVE_DISABLE_VERIFICATION_JOB_RUNNER=1` to preserve
   queued jobs without executing them. Pause subscriber imports if a binary
   rollback could bypass a frozen verified import.
3. Let in-flight calls settle, then cancel undispatched jobs if appropriate.
   Reconcile any request-started items as
   ambiguous; cancellation cannot undo an already dispatched provider call.
4. Delete provider configuration if all future provider egress must stop.
5. Roll back the application binary only after workers are drained/paused.
   Leave additive migrations in place during the incident; down-migrating loses
   cache, job, ambiguity, and audit evidence.
6. If the additive campaign health gate itself must be removed, set
   `POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE=1` and restart. Confirm canonical
   consent/suppression enforcement remains active before resuming sends.

## Security, privacy, and retention

- Treat addresses, grades, evidence timestamps, provider references, and job
  results as tenant data. Health responses are no-store and require subscriber
  scope.
- Provider keys exist only in the secrets backend and process memory. Provider
  errors are sanitized at the HTTP boundary; job errors returned to clients are
  generic.
- Persisted snapshot evidence is normalized and excludes raw provider payloads,
  reply bodies, IPs, user agents, and suppression metadata.
- Terminal cache fallback is capped at 365 days from verification, and terminal
  job item detail is removed 365 days after job completion. A health snapshot
  becomes purge-eligible 365 days after its last computation; active, valid
  recomputation renews that derived read model. Aggregate jobs remain, with
  source, idempotency, request-fingerprint, and creator metadata scrubbed after
  the same window. Public-form paid-verification reservations contain a tenant-
  wide normalized-address digest, tenant/form-scoped attempt/fingerprint
  digests, and closed decision codes only and are deleted after 24 hours.
- Do not use real recipient addresses in smoke tests. Do not paste addresses
  into logs, metrics, incident tickets, or database query output.
- Tenant deletion cascades provider, cache, policy, job, item, usage, and health
  rows. Targeted cache deletion is not subscriber erasure; follow the privacy
  workflow for data-subject requests.

## Production checklist

- [ ] All ten migration stems dry-run and apply cleanly; checksums, RLS, and the
  isolated verification identity-predicate grants are verified.
- [ ] Bulk creation and subscriber imports start disabled; policies remain off
  by default.
- [ ] Secrets are tenant/provider namespaced, least-privilege access is
  reviewed, and raw keys are absent from Postgres/logs/client payloads.
- [ ] Provider live probe and controlled status fixtures pass.
- [ ] Synchronous and durable-job idempotent replay, mismatch/in-progress
  responses, response-ledger failure, lease recovery, explicit quota failure,
  and ambiguous-outcome handling are exercised.
- [ ] Health A/B/C/D/F/U precedence, consent hard stops, fail-closed evidence
  errors, and send-time batch/scalar gates pass.
- [ ] Signup local/full/fail-open behavior, exact retry replay, changed-intent
  rejection, pending/ambiguous no-redispatch, legacy local-only fallback, and
  import preview/frozen-execution behavior pass.
- [ ] Dashboards/alerts cover HTTP 5xx/latency, health-gate errors,
  ambiguity/failure codes, worker age, credits, and cache backlog.
- [ ] Bulk creation, job runner, subscriber-import worker, and additive
  recipient-health kill switches are rehearsed independently.
- [ ] Spend-capable route scope, synchronous idempotency, cache invalidation
  with retained terminal evidence, and bounded actor retention are contract-tested.
- [ ] Canary rollback is rehearsed without deleting migrations or bypassing
  canonical consent/suppression enforcement.

Focused verification commands:

```bash
go -C apps/api test ./internal/verification ./internal/sending \
  ./internal/forms ./internal/subscriber_import ./internal/server ./internal/workers

go -C apps/api test -race ./internal/verification ./internal/sending

pnpm --filter @postwave/openapi sync-json:check
pnpm --filter @postwave/openapi codegen:check
pnpm --filter postwave-desktop-shell typecheck
pnpm --filter @postwave/web typecheck
pnpm --filter @postwave/mobile typecheck
pnpm audit:migration-numbering
```

Database-backed Go tests require the normal test `DATABASE_URL` and should run
against an isolated database with the current migrations applied.

## Post-incident and communication templates

Post-mortem must record: tenant/provider scope, first and last affected time,
whether any request crossed the request-start boundary, upstream versus
recorded credits, affected enforcement points, whether consent/suppressions
remained authoritative, cache/snapshot state, and the exact safe-resume gate.

Status update template:

> Email verification is degraded for [scope]. [Signups are being admitted with
> degraded verification / imports are paused before subscriber mutation /
> campaign recipients are being withheld fail-closed]. New paid bulk work is
> disabled. We have identified [count] ambiguous provider requests and will not
> retry them until billing and result reconciliation completes. Consent and
> suppression enforcement remains active. Next update: [time].
