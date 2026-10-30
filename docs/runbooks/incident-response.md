# Incident Response Runbook

This runbook is the canonical guide for responding to a production
incident at Moosewave. Read it now, before you need it.

The goals during an incident are, in priority order:

1. **Stop the bleeding** — restore service for paying customers.
2. **Communicate** — update the public status page and customer-
   facing channels every 30 minutes minimum.
3. **Preserve evidence** — capture logs, metrics, and traces before
   they roll off retention.
4. **Investigate root cause** — only after the bleeding stops.

If you find yourself debugging during an active outage and you have
not yet declared the incident or posted to the status page, stop. Do
those two things first.

## Detection

Incidents are detected through four channels. Treat any of them as
sufficient grounds to begin the response process.

### Sentry alerts

Sentry routes to `#oncall-alerts` in Slack. The alert rules that
matter:

- **`api-spike-5xx`** — triggers when the api gateway emits more than
  20 HTTP 5xx responses in 5 minutes. Almost always real.
- **`worker-backlog`** — triggers when any of the background workers
  (campaign send loop, retry queue, voice ingest) has more than 1,000
  pending jobs for >10 minutes. Sometimes a benign spike from a large
  campaign — check the size of the affected tenant's send first.
- **`stripe-dlq`** — triggers when `stripe_webhook_dead_lettered_total`
  increments. Always real, always paying customers.

### Status page anomalies

The aggregator at `/api/public/status` writes one ping per service per
minute. If three consecutive pings classify a service as `down`, the
status banner flips to "Some systems experiencing issues" automatically.
Operators do not control that automatic flip — but you DO control the
incidents table, and creating an incident there is what tells customers
you are aware.

### Customer reports

`support@moosewave.com` and the in-app feedback widget. Sales also
escalates via `#sales-incidents`. A single customer report from a
high-tier account is enough to investigate.

### Synthetic checks

External Pingdom hits the marketing site, the dashboard login page, and
`/api/public/status` from three regions every 60 seconds. Two
consecutive failures from at least two regions trigger a P1.

## Severity Classification

The severity dictates response speed and comms cadence. Pick the
highest severity that fits at least one of the criteria below; you can
always downgrade as you learn more.

### P0 — Critical

- All users locked out (e.g. authentication backend down).
- Data loss or corruption in a tenant table.
- Sending pipeline cannot deliver any campaigns.
- Dodo Payments billing webhooks dead-lettered for >1 hour.

Response: page on-call immediately, declare incident in
`#incident-active`, status page banner within 5 minutes.

### P1 — Major

- Subset of users affected (e.g. one region down).
- A core feature broken (campaign editor, voice training, migrations).
- Deliverability degraded across multiple tenants.
- More than 1% of API requests returning 5xx.

Response: page on-call within 15 minutes, status page banner within
15 minutes, comms every 30 minutes until resolved.

### P2 — Minor

- A non-core feature broken (segment builder, A/B winner picker).
- Slow response times affecting <10% of requests.
- Background job stalled but no immediate customer impact.

Response: assign during business hours, status page banner if customer-
visible, comms when the incident resolves.

### P3 — Cosmetic

- UI bugs that don't affect functionality.
- Stale dashboard data.
- Single-tenant issues with a clear workaround.

Response: file a ticket, no status page entry needed.

## Response Steps Per Severity

### P0 / P1 Initial Response

The first 15 minutes set the tone for the whole incident. Follow this
checklist:

1. **Acknowledge the page.** In `#oncall-alerts`, react with `:eyes:`
   so on-call coordination knows someone is on it.
2. **Open `#incident-active`.** This is the war room channel; it is
   archived and reviewed in the post-mortem.
3. **Write the first message.** Template:

   > P1: API gateway returning 5xx for ~30% of requests since 14:02
   > UTC. I am investigating. Will post next update at :30 past the
   > hour.

4. **Update the public status page.** Insert a row into the `incidents`
   table:

   ```sql
   INSERT INTO incidents (title, description, severity, status,
                          affected_services, started_at)
   VALUES ('API errors', 'Investigating elevated 5xx rate.',
           'major', 'investigating', ARRAY['api'], now());
   ```

5. **Pull in helpers.** Tag domain experts in `#incident-active` —
   not by paging them, just by `@`-mentioning. They self-select.

### P0 / P1 Mitigation

Stop the bleeding. Common mitigations, in rough order of how often we
reach for them:

- **Roll back.** If a deploy in the last 2 hours correlates with the
  start of the incident, roll it back. See `deploy-procedure.md`.
- **Failover region.** If one region is sick, drain it and let the
  other absorb the load. See `database-incident.md` for the DB side.
- **Disable the offending feature.** Most features are gated by an
  env var or a feature-flag column. Flip it off and tell customers
  the feature is temporarily unavailable.
- **Throttle the noisy tenant.** Per-tenant rate limits in
  `api_keys_rate_limit` and `tenants.send_rate_limit`. A single tenant
  blowing through their quota can degrade the whole platform.

Do not optimise during an incident. The right answer is whatever stops
the bleeding fastest, even if it is ugly.

### P2 / P3 Initial Response

Less ceremony, but document what you do.

1. File a ticket in Linear with the affected component label.
2. Triage during business hours.
3. If you discover during triage that it is actually a P1, escalate.

## Comms Templates

Pick the template that matches the channel.

### Status page update (50–100 chars in title, 200 chars in body)

> Title: API errors
>
> Body: We are investigating elevated 5xx rates from the API
> gateway. Some campaign sends and dashboard requests are
> currently failing. Updates every 30 minutes.

### Customer email (sent for P0/P1 only)

> Subject: Moosewave incident — [brief summary]
>
> We are currently investigating an issue affecting [feature]. The
> impact is: [specifics]. Our team is actively working on
> resolution. Updates will be posted at https://status.moosewave.com
> and emailed when the incident is resolved.

### Internal Slack (`#incident-active`)

Update every 30 minutes minimum even when "no change":

> 14:32 UTC: still investigating. Two team members on the DB side,
> one on the cache. Next update :60 past the hour.

## Post-Mortem Template

Within 48 hours of an incident closing, write a post-mortem. Use this
template — copy-paste it into a Confluence page tagged
`#incident-postmortem`.

```
# [Incident title] — [date]

## Summary
[Two sentences: what broke, what the customer impact was.]

## Timeline
- HH:MM UTC: [event]
- HH:MM UTC: [event]

## Root cause
[Causal chain. Five whys is fine. Write this with empathy — the goal
is to understand systems, not blame humans.]

## What went well
- [thing]

## What went poorly
- [thing]

## Action items
- [ ] [task] — owner — due
- [ ] [task] — owner — due

## Customer impact
- Tenants affected: [list or count]
- Requests affected: [count]
- Revenue impact: [dollar estimate]
```

Do not ship the post-mortem until each action item has an owner. An
unowned action item is an action item that won't happen.

## Escalation

If on-call cannot find the right expert in `#incident-active` within
15 minutes, escalate to the engineering lead via PagerDuty. The
on-call rotation runbook (`oncall-rotation.md`) lists the escalation
path.

## After the incident

- Resolve the row in `incidents` (`UPDATE ... SET resolved_at = now(),
status = 'resolved' WHERE id = ...`).
- Post a final update to the status page.
- Send the customer email if it's P0/P1.
- File the post-mortem within 48 hours.
- Archive `#incident-active` and start fresh for the next one.
