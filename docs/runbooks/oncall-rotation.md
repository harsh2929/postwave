# On-Call Rotation

This runbook describes how the Moosewave on-call rotation works, what
the on-call engineer is responsible for, and how to hand off cleanly.

## Schedule Format

The on-call rotation is one engineer per week, Monday 09:00 UTC →
following Monday 09:00 UTC. The rotation cycles through the
engineering org alphabetically by display name; new joiners are
added at the bottom of the order after their first 30 days.

The current rotation is in PagerDuty under the schedule named
"Moosewave-Primary." A read-only view is mirrored to the
`#oncall-schedule` Slack channel — that channel posts the next week's
on-call every Friday at 17:00 UTC so people can plan around it.

### Coverage windows

- **Primary:** 24/7 during your week. You are the first responder.
- **Secondary:** the engineer one slot ahead of you in the rotation.
  Auto-paged if primary doesn't ack within 5 minutes.
- **Manager escalation:** the engineering lead. Auto-paged if
  secondary doesn't ack within an additional 5 minutes.

### Swaps and overrides

If you can't take a shift, swap with someone in PagerDuty (Schedules
→ Moosewave-Primary → Override). Document the swap in
`#oncall-schedule`. Swaps are encouraged and have no stigma.

If you can't find a swap, escalate to the engineering lead. Don't
silently miss a shift — pages will go unanswered and customers will
notice.

## Hand-off Checklist

Mondays at 09:00 UTC, the outgoing on-call hands off to the incoming
on-call. The hand-off is a 15-minute call (or async via Slack DM if
both prefer); use this checklist.

### From the outgoing engineer

1. **Active incidents.** Walk through anything still open in
   `#incident-active` or `incidents` table.
2. **Watch items.** Anything you've been keeping an eye on but
   hasn't quite tripped a page yet — error rate trending up,
   slow query logs growing, unusual traffic from a new tenant.
3. **Pending fixes.** PRs that fix recent issues but haven't merged,
   or that have merged but need monitoring after deploy.
4. **Recent post-mortems.** Anything written in the last 7 days that
   the incoming should be aware of (the post-mortem itself is in
   Confluence; just point to it).

### From the incoming engineer

1. **Confirm access** — see "Access Required" below.
2. **Read the open `#oncall-alerts` thread** for the previous 48
   hours.
3. **Skim recent deploys** in `#eng-deploys` (last 72 hours).
4. **Acknowledge the schedule change** in `#oncall-schedule` so it's
   on the record.

## Responsibilities During Your Week

### Reactive work

- Respond to PagerDuty alerts within 5 minutes during business hours
  (09:00–18:00 your timezone) and within 15 minutes outside business
  hours.
- Triage Sentry issues that hit the on-call queue. Most are auto-
  routed; what comes to you is the residue.
- Respond to `support@moosewave.com` escalations from the support
  team. Goal: same-day acknowledgment.

### Proactive work

- One hour per day reviewing dashboards (see `dashboards.md`). Look
  for trends, not point-in-time spikes.
- Run the weekly chaos test on Wednesday at 14:00 UTC. The test
  script is in `scripts/chaos/`; pick one and run it on staging.
  Report results in `#chaos-engineering`.
- Update this runbook (or any other in `docs/runbooks/`) with
  anything new you learned during your week.

### What you are NOT responsible for

- Feature work. Your week is paid for by being on-call; product
  velocity is everyone else's problem.
- Writing post-mortems for incidents that started before your shift.
  The original on-call owns the post-mortem.
- Customer billing questions. Those go to support; if support
  escalates a billing engineering question (e.g. a stuck Stripe
  webhook), you handle it.

## Escalation Paths

When you need help:

### Within engineering

1. **`#engineering`** — general engineering questions. Response time
   varies; don't rely on it for an active fire.
2. **Page secondary on-call** via PagerDuty if primary is overwhelmed.
3. **Page engineering lead** if it's a P0 and you need command-and-
   control authority (e.g. taking the site down for emergency
   maintenance, or rolling back a migration).

### Outside engineering

- **Customer comms** — page the on-call CSM via PagerDuty rotation
  "Moosewave-Comms." They draft and send customer emails for
  incidents.
- **Legal / regulatory** — page the head of operations. Trigger:
  any incident involving PII exposure, regulatory deadlines, or
  payment processing failures sustained >2 hours.
- **External vendors** — Stripe, Postmark, Anthropic, AWS — vendor
  contacts are in 1Password under "Vendor support." Use the
  enterprise support tier, not the free-tier ticket system.

## Tools the On-Call Needs

You need active access to all of these before your first shift. If
any are missing, ping the engineering lead at least 1 week before
your rotation.

### Critical (must work)

- **PagerDuty** — paging tool. Keep the mobile app installed with
  push notifications enabled.
- **Slack** — `#oncall-alerts`, `#incident-active`,
  `#eng-deploys`, `#oncall-schedule`. Mute non-critical channels.
- **GitHub** — write access to the main repo for emergency reverts.
- **kubectl access** — production cluster. Test before your shift:
  `kubectl get pods -n postwave-prod | head`.
- **AWS console** — IAM role `postwave-oncall`, allows read on most
  services and write on a narrow set (RDS snapshots, S3 lifecycle
  rules, CloudFront invalidation).
- **Production database read access** — use the bastion + read
  replica. Direct write access is intentionally NOT given — you
  request it via the secrets-vault break-glass procedure when needed,
  with auto-expiry after 1 hour.
- **Sentry** — admin role on the Moosewave project. Lets you mute
  noisy issues and adjust alert routing during an incident.

### Nice to have

- **Datadog / Grafana** — performance dashboards. See
  `dashboards.md`.
- **Linear** — for filing tickets that come out of incidents.
- **Confluence** — for writing post-mortems.
- **1Password** — for vendor support contacts.

## Compensation

On-call is compensated. Specific arrangement is in the employee
handbook; the short version: a per-shift stipend, plus comp time off
for any hour worked outside business hours.

If you're routinely paged outside hours (more than 2 incidents in
your week), file a ticket — that's a signal we have a systemic
problem we should fix, not a personal failure on your part.

## When to break the rules

Most of what's in this runbook is "normal operations." Break any of
it during a P0 if breaking it would help. The post-mortem is the
right place to argue about whether the rule should change.

## Onboarding a new on-call

The first 90 days an engineer is at Moosewave, they are not in the
rotation. Days 30–60 they shadow another engineer's shift (read
`#oncall-alerts` in real time, ask questions, don't get paged).
Days 60–90 they reverse-shadow (they're "on-call," but every page
also pages an experienced backup who jumps in if needed).

After day 90, they're solo on-call. The first solo shift is always
during a "low-risk" week — no Friday deploys, no major launches.
