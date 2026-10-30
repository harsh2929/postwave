# Campaign Assurance lifecycle SLO

This runbook is for the `campaign-assurance.slo-health` ops check. The check
and its Prometheus collector read one content-free aggregate through
`ops_campaign_assurance_slo_health()`. They do not expose tenant, campaign,
run, recipient, mailbox, MIME, extraction, prompt, provider-output, or
free-form error data.

## Objectives and alert thresholds

- A command that is ready for delivery should begin within five minutes.
  Five minutes is warning; more than fifteen minutes is red.
- An eligible queued run older than five minutes must have an unfinished
  durable command. Any orphan is red.
- A running run must not retain an expired worker lease. Any expired lease is
  red because recovery should have requeued or terminally failed it.
- Over the trailing 24 hours, at least 99% of terminal runs should finish with
  complete evidence. This ratio is evaluated only after 20 terminal runs.
  Below 99% is warning and below 95% is red. A legitimate deterministic block
  remains a complete run and does not count as pipeline failure.
- Two consecutive red/warning evaluations are required before the existing
  ops pusher changes alert state. If the aggregate query fails, the check is
  red and `postwave_campaign_assurance_slo_scrape_success` is `0`; the
  collector does not replay stale green gauges.

## Triage

1. Open the internal Campaign Assurance ops run view. Start with `queued` and
   `running`; use run detail and the metadata-only timeline for the affected
   lifecycle stage. Do not request or copy message content into an incident.
2. Compare these metrics:
   - `postwave_campaign_assurance_ready_commands`
   - `postwave_campaign_assurance_oldest_ready_command_age_seconds`
   - `postwave_campaign_assurance_orphaned_queued_runs`
   - `postwave_campaign_assurance_expired_running_leases`
   - `postwave_campaign_assurance_terminal_runs_24h{state=...}`
   - `postwave_campaign_assurance_slo_scrape_success`
3. If ready-command age is rising, verify that the Campaign Assurance worker
   is enabled and running, and inspect command delivery attempts and lease
   timestamps in the ops detail. Restore the worker/queue dependency; do not
   bypass an unavailable send gate.
4. If a run is orphaned, first confirm the durable command is truly absent in
   the authorized ops view. Replay the existing idempotent run scheduling path
   with its original request identity. Do not create a second run manually.
5. If leases are expired, verify the worker process is stopped before recovery
   to avoid dueling owners. Let the normal fenced lease recovery requeue the
   run. Never edit claim tokens, attempt counts, or run state directly.
6. If incomplete/failed share rises, group by bounded error code in the
   content-free run view. Check provider availability, raw-evidence storage,
   OCR/image broker health, cost ceilings, and artifact retrieval. Missing
   evidence must remain `incomplete`/`unavailable`, not be changed to pass.

## Recovery verification

Keep the incident open until two consecutive evaluations are healthy and:

- ready-command age is below five minutes;
- orphaned queued runs and expired running leases are both zero;
- newly created controlled runs reach a terminal state with the expected
  content-free audit actions; and
- `postwave_campaign_assurance_slo_scrape_success` remains `1` through an ops
  reconciler interval.

The canonical audit actions are:

```text
campaign.assurance_started
campaign.assurance_completed
campaign.assurance_incomplete
campaign.assurance_blocked
campaign.assurance_overridden
campaign.assurance_stale
```

They are inserted atomically with the lifecycle transition. The existing
audit transaction emitter publishes an `audit.created` outbox event carrying
only the action, resource type, and run ID; detailed content-free provenance
remains in the tenant audit export.
