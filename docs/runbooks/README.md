# Moosewave Runbooks

Operational runbooks for incident response. Every runbook follows the same
structure: **Symptoms → Detection → Severity matrix → Immediate response
(P0/P1/P2) → Investigation → Resolution → Post-mortem template →
Communication template**.

If you're on-call, start with the index below. If you don't see a runbook
that matches the incident: open one as you go, even just bullet points —
better a partial runbook tomorrow than nothing.

## Index

| Runbook | Owner | One-line summary |
|---|---|---|
| [deliverability-incident.md](deliverability-incident.md) | Pillar 2 on-call | Anything wrong with Inbox Reality, Diagnostician, seedlist polling, auth checks, or fleet-wide spam-folder placement. |
| [account-ban.md](account-ban.md) | Pillar 2 on-call | A seedlist mailbox account got locked or banned by its provider — mark inactive, route around, replace with geo-distributed account. |
| [ip-delisting.md](ip-delisting.md) | Pillar 2 on-call | Sending IP showed up on Spamhaus/SORBS/Barracuda — pause the offending tenant, request delisting, route others to a clean IP pool. |
| [migration-failure.md](migration-failure.md) | Pillar 1 on-call | A migration job failed mid-run — triage by source-rate-limit / adapter shape / data-integrity tripwire / infra, then resume from cursor or roll back. |
| [automation-runtime-stuck.md](automation-runtime-stuck.md) | Platform on-call | Asynq queues backed up, executions not progressing — pprof the workers, inspect dead-letter, replay or quarantine poison messages, restart gracefully. |
| [database-incident.md](database-incident.md) | Platform on-call | Postgres outage / runaway query / **RLS bypass detected (SEV0)**. Includes Moosewave-specific RLS verification commands. |
| [customer-data-export.md](customer-data-export.md) | DPO + ops | GDPR/CCPA Subject Access Request SOP — verify identity, run the per-tenant export job, package with `age`-encrypted bundle, deliver via single-use signed URL. |
| [pre-production-launch-readiness.md](pre-production-launch-readiness.md) | Staff engineering | No-deploy launch gate covering providers, auth, API/SDK parity, migration compatibility, deliverability, and release packaging. |
| [provider-rehearsal.md](provider-rehearsal.md) | Staff engineering | Third-party provider rehearsal plan and credential preflight for Stripe, migrations, Shopify, deliverability, DMARC, and sending. |
| [email-verification-health.md](email-verification-health.md) | Deliverability + Platform on-call | BYO-provider email verification, A/B/C/D/F/U recipient health, consent precedence, paid-job safety, rollout, and incident response. |

## Severity convention

| SEV | Meaning |
|---|---|
| SEV0 | Data integrity / privacy breach. Wake everyone up. |
| SEV1 | Customer-visible outage or fleet-wide deliverability collapse. |
| SEV2 | Multi-customer regression OR a single-host failure with no redundancy. |
| SEV3 | Single-customer regression OR a recoverable subsystem fault. |
| SEV4 | Workflow/process item, no service impact. |

## Adding a new runbook

1. Copy any existing file as a scaffold.
2. Keep prose lean and command examples copy-pasteable.
3. Wire the alarm names into the runbook's Detection section so an
   on-call engineer can trace from PagerDuty → runbook section in <30s.
4. Link from this index. PR review must include an actual on-call
   engineer.

See `LICENSE-BOUNDARY.md` and `plan.md` for the broader architecture
context these runbooks operate in.
