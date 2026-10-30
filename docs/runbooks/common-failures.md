# Common Failures

Quick-reference playbook for incidents we have seen multiple times.
Each entry covers: how to recognise the failure, the diagnostic
commands to run first, and the fix.

If a failure mode here turns out to be something else, edit the entry.
This file rots fast if it isn't kept current.

## Audit-sink delivery failures

Symptoms:

- `postwave_auditsink_consecutive_failures` is 10 or higher.
- A configured customer audit export is delayed or auto-disabled.

Diagnose:

1. Identify the `sink_id` and `kind` labels, then correlate them with the
   tenant-scoped sink record through the operator API. Never paste endpoint
   credentials or customer audit rows into the incident channel.
2. Check the sink worker's structured logs for the opaque sink ID and bounded
   upstream status/error code.
3. Test DNS, TLS expiry, destination authorization, and provider rate limits
   from the production task network without bypassing the secure-egress
   policy.

Fix:

- Rotate or correct the destination credential in the encrypted sink config.
- If the provider is unavailable, leave delivery paused and retain the durable
  cursor; do not advance it manually. Resume only after a bounded test
  delivery succeeds and the consecutive-failure gauge returns to zero.
- If rows may have been skipped or duplicated, export the affected audit-ID
  interval, reconcile it at the destination, and attach the result to the
  incident record before closing the alert.

## Privacy request overdue

Symptoms:

- `postwave_privacy_overdue_requests` is non-zero for export or deletion.
- A request's recorded `due_at` is in the past without a fulfilled timestamp.

Diagnose:

1. Use the operator privacy queue to identify opaque request IDs and owners;
   do not post subject email addresses or export contents into chat/tickets.
2. Check the request workflow and durable outbox state for each ID, including
   provider deletion/export dependencies.
3. Confirm whether the request is blocked on identity verification, a provider
   outage, or an internal worker failure and record the legal/privacy owner.

Fix:

- Restore the failed worker/provider path, replay through the idempotent
  workflow, and verify the generated receipt or export checksum.
- Do not mark a request fulfilled merely to silence the alarm. Escalate every
  genuinely overdue request to the privacy owner and preserve dated evidence
  of the completion or approved exception.

## Stripe webhooks not firing

Symptoms:

- Customers complete checkout but their tier isn't upgraded.
- The dashboard shows "Payment processing" indefinitely.
- `billing_events` table has no recent rows.
- `stripe_webhook_dead_lettered_total` increments unexpectedly.

Diagnose:

1. **Check the webhook secret.** A rotated secret is the most common
   cause.

   ```bash
   echo $STRIPE_WEBHOOK_SECRET | head -c 8
   # should match the prefix in the Stripe dashboard
   ```

   Stripe Dashboard → Developers → Webhooks → click the endpoint →
   "Signing secret". Compare prefix.

2. **Check the DLQ.** Messages that arrived but failed to dispatch
   land here:

   ```sql
   SELECT event_id, attempt_number, last_error, dead_lettered_at
   FROM stripe_webhook_attempts
   WHERE status = 'dead_lettered'
   ORDER BY dead_lettered_at DESC
   LIMIT 20;
   ```

3. **Check pending retries.** Backoff progression:

   ```sql
   SELECT event_id, attempt_number, next_attempt_at, last_error
   FROM stripe_webhook_attempts
   WHERE status = 'pending'
   ORDER BY next_attempt_at ASC
   LIMIT 20;
   ```

4. **Check Stripe's "Recent events" tab** for HTTP 400/500 responses
   from our endpoint.

Fix:

- If the secret is wrong: rotate it via the secrets manager and
  redeploy. Stripe will retry pending events automatically.
- If the DLQ is non-empty after a fix: replay each affected event:

  ```bash
  curl -X POST "https://api.moosewave.com/api/internal/admin/stripe-webhook-attempts/<id>/replay" \
    -H "Authorization: Bearer $POSTWAVE_INTERNAL_API_TOKEN"
  ```

## Legacy DMARC IMAP research ingest not running

> Production note: the legacy poller is intentionally forbidden in production.
> It cannot prove the SMTP envelope recipient or a trusted DMARC verdict for the
> report email. Do not enable it to restore a customer-facing feature.

Symptoms:

- The `dmarc_reports_ingested_total` counter has been flat for >1 hour.
- A synthetic staging rehearsal is not producing aggregate-report rows.

Diagnose:

1. **Confirm this is an isolated non-production rehearsal**, then check the
   explicit break-glass flag and IMAP variables.

   ```bash
   env | grep DMARC_IMAP
   # DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION=true (non-production only)
   # DMARC_IMAP_HOST, DMARC_IMAP_USER, DMARC_IMAP_PASSWORD
   ```

2. **Test IMAP credentials** from the bastion:

   ```bash
   openssl s_client -crlf -connect "$DMARC_IMAP_HOST:993"
   # then: a LOGIN $DMARC_IMAP_USER $DMARC_IMAP_PASSWORD
   ```

3. **Check the ingestion logs:**

   ```bash
   kubectl logs -l app=deliverability --tail=200 | grep -i dmarc
   ```

Fix:

- For isolated staging, rotate stale credentials through the secrets manager
  and restart the deliverability pod.
- For production, leave the poller disabled and keep the DMARC reporting
  capability unavailable. There is no implemented fallback S3/R2 ingestion
  path. Restore service only through the qualified authenticated inbound design.

## Send loop stalled

Symptoms:

- A campaign is stuck at "Sending" for >30 minutes.
- `campaign_recipients` has many rows in `pending` state for one
  campaign.
- Postmark dashboard shows steady delivery for other tenants.

Diagnose:

1. **Pending count for the affected campaign:**

   ```sql
   SELECT campaign_id, COUNT(*)
   FROM campaign_recipients
   WHERE state = 'pending' AND campaign_id = '<id>'
   GROUP BY campaign_id;
   ```

2. **Sending state row:**

   ```sql
   SELECT * FROM sending_state WHERE campaign_id = '<id>';
   ```

   `last_lease_at` more than 5 minutes old means the worker died
   holding the lease.

3. **Postmark API status.** Check https://status.postmarkapp.com.

4. **Per-tenant quota:**

   ```sql
   SELECT tenant_id, daily_send_limit, sent_today
   FROM tenant_send_quotas WHERE tenant_id = '<tid>';
   ```

Fix:

- Stale lease: zero out `last_lease_at` so a fresh worker picks it up:

  ```sql
  UPDATE sending_state SET last_lease_at = NULL,
                           leased_by = NULL
  WHERE campaign_id = '<id>';
  ```

- Quota exhausted: bump the daily limit, or wait until the quota
  rolls over (UTC midnight).
- Postmark outage: pause new sends via the admin endpoint, wait for
  Postmark to recover.

## Voice profile builder timing out

Symptoms:

- Voice training jobs stuck at "Analyzing" for >10 minutes.
- The voice service logs show repeated `context deadline exceeded`
  on Gemini API calls.

Diagnose:

1. **Gemini API status:** check Google AI Studio / Google Cloud status.

2. **API key:**

   ```bash
   curl -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     https://api.anthropic.com/v1/models
   # 200 OK = key is valid
   ```

3. **Tone classifier env vars:**

   ```bash
   env | grep -E "TONE_CLASSIFIER|VOICE_INGEST"
   ```

4. **Per-tenant quota:**

   ```sql
   SELECT tenant_id, voice_jobs_today, voice_quota
   FROM tenant_voice_quotas;
   ```

Fix:

- Anthropic outage: pause new training jobs via the voice admin UI;
  pending jobs will auto-resume when the service recovers.
- Stale API key: rotate via secrets manager + restart voice pod.
- Quota exhausted: bump the per-tenant quota or wait for the daily
  rollover.

## Migration jobs hanging

Symptoms:

- A migration job is in `running` state for >2 hours.
- The orchestrator logs show no recent progress.
- Customer reports "migration progress bar frozen."

Diagnose:

1. **Orchestrator goroutine:**

   ```sql
   SELECT id, source, target, status, last_progress_at,
          rollback_state
   FROM migration_jobs WHERE id = '<id>';
   ```

2. **Goroutine is alive?** Check the migration service health endpoint:

   ```bash
   curl https://migration.moosewave.com/health
   ```

3. **Rollback state.** If `rollback_state = 'mid_rollback'`, the
   previous run started a rollback that didn't complete; resuming
   the original migration will be confusing.

Fix:

- Stuck mid-rollback: complete the rollback via the admin endpoint
  before retrying.
- Genuinely stuck (no progress, no rollback in flight): cancel the
  job and instruct the customer to re-trigger.

## Sample data seeded twice

Symptoms:

- A new tenant has 200 fake subscribers (instead of 100).
- Sample campaigns have duplicate names with `(2)` suffix.

Cause: the sample-data seeder used to run once per tenant per process
restart, not once per tenant total. Fixed in migration 0084 by adding
a `tenants.sample_data_seeded_at` column with a unique constraint on
non-null values.

If you see duplicates on a fresh tenant created today, the migration
may not have run on production yet. Check:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'tenants' AND column_name = 'sample_data_seeded_at';
```

If the column does not exist, the migration is pending. Apply it
before any new tenant signs up.

To clean up an already-seeded duplicate set, delete rows where
`metadata->>'sample' = 'true'` for that tenant; the seeder will not
re-run because the `sample_data_seeded_at` column is now non-null.

## Status page showing stale data

Symptoms:

- Status page banner says "operational" but customers report problems.
- `service_health_pings` has no recent rows for the affected service.

Diagnose:

1. **SERVICE_HEALTH_URLS env var:**

   ```bash
   env | grep SERVICE_HEALTH_URLS
   ```

2. **The aggregator goroutine.** Check API logs for:

   ```text
   "health aggregator persist failed"
   "health aggregator disabled (no targets)"
   ```

Fix:

- If the env var is empty, configure it: `name=url,name=url`. The
  aggregator picks it up at next API restart.
- If pings are landing but the page is stale, check `Cache-Control`
  on `/api/public/status` — should be 30s.
