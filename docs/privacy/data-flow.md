# Moosewave Data-Flow Documentation

This document describes the personal and operational data Moosewave collects,
where it flows, how long it is retained, and the deletion/export guarantees we
offer. It supports the DPA Annex 2 technical and organizational measures and
the internal GDPR Article 30 record of processing activities.

Status: development and test runs can be performed locally with Docker. The
production target is AWS-first, with RDS PostgreSQL, ECS/Fargate, S3,
CloudFront, SES or customer-owned sending, and managed secrets. This document
does not imply that AWS has already been deployed.

## High-Level Diagram

```text
 Subscriber / customer user / mobile app / desktop app
        |
        | HTTPS
        v
 Web app, API gateway, and public form endpoints
        |
        | authenticated tenant context
        v
 Postgres
   - tenant data, subscribers, campaigns, forms
   - consent_events, audit_log, subscriber_events
   - Stripe and provider webhook attempts
        |
        +--> Redis / queueing for jobs and send orchestration
        +--> Listmonk over HTTP for newsletter execution
        +--> SES or BYO SMTP/provider for outbound email
        +--> S3-compatible object storage for imports/exports/assets
        +--> Stripe for billing events
        +--> optional AI providers for voice, sequencing, diagnostics
```

## Data Types And Flows

### Subscriber Identity

- Source: public forms, CSV imports, migration imports, API writes, and
  customer-owned sender/list integrations.
- Stored in: subscriber tables, form submissions, custom fields, tags,
  suppressions, paid member records, and related per-tenant tables.
- Isolation: tenant-scoped tables are protected through row-level security and
  the `app.tenant_id` transaction setting.
- Retention: retained until the tenant deletes the record, the subscriber is
  deleted under a data-rights request, or the configured tenant retention policy
  expires.
- Export: tenant exports discover all tenant-scoped tables dynamically and omit
  secret columns such as hashes, encrypted tokens, and webhook secrets.

### Public Form Submissions

- Source: embedded forms, hosted forms, popup forms, and mobile/desktop admin
  previews that submit through the same public endpoint.
- Stored in: `form_submissions`, plus `consent_events` when the form includes a
  consent value.
- Consent proof: form consent records include email, channel, action, source,
  policy version, form id, submission id, IP address, user agent, and structured
  preferences.
- Retention: governed by tenant privacy settings and deletion requests.

### Consent, Preferences, And Suppressions

- Source: form consent, cookie preferences, unsubscribe flows, preference-center
  choices, admin suppression actions, and provider feedback loops.
- Stored in: `consent_events`, `notification_preferences`,
  `subscriber_suppressions`, and suppression or unsubscribe tables.
- Accuracy rule: consent state is append-only evidence first, projected state
  second. The event ledger is the audit source when state and UI disagree.

### Campaign Engagement

- Source: Listmonk/open/click events, provider webhooks, inbound email parsing,
  replies, bounces, complaints, and conversion tracking.
- Stored in: `subscriber_events`, `campaign_recipients`,
  `campaign_report_events`, `campaign_replies`, `bounce_events`,
  `complaint_events`, `inbound_events`, and conversion tables.
- Accuracy rule: campaign report denominators come from `campaign_recipients`,
  not from only the people who generated an event. This keeps no-event
  recipients visible in CSV exports and rate calculations.
- Raw provider payloads: bounce and complaint raw JSON is retained only for the
  support/debugging window, then minimized to an empty JSON object while keeping
  structured event fields.

### Billing And Commerce

- Source: Dodo Payments Checkout, subscription/payment webhooks, and Customer
  Portal actions; legacy Stripe events remain accepted for compatibility.
- Stored in: provider-neutral projected billing state, billing events, webhook attempts,
  coupons, affiliate records, referrals, and commerce import state.
- PCI scope: Moosewave does not process card PANs; provider-hosted/tokenized
  payment flows keep card data outside Moosewave systems.
- Retention: tax/accounting records are retained for statutory periods.
  Successful and dead-lettered webhook retry payloads are pruned after the retry
  support window.

### Migration Imports

- Source: Mailchimp, ConvertKit, Beehiiv, Substack, CSV, and similar customer
  export/import workflows.
- Stored in: migration jobs, imported subscribers, tags/segments, campaigns,
  templates, assets, and mapping records.
- Substack publication ZIPs are path- and size-validated before use. Raw
  per-recipient delivery/open CSV entries are stream-counted and not extracted;
  only post-level counts plus a non-content file digest/size manifest are kept
  with the prepared upload. Subscriber rows remain confidential migration data.
- Transient secrets: OAuth state, import session tokens, and idempotency or
  queue bookkeeping are excluded from tenant exports and should not be treated
  as customer content.
- Retention: imported artifacts follow tenant policy. Temporary migration state
  is short-lived and should be purged after completion or expiry.

### AI, Voice, And Automation Data

- Source: tenant-provided voice material, campaign drafts, automation goals,
  prompts, generated content, and optional diagnostic workflows.
- Stored in: voice profiles, semantic signatures, templates, sequences, usage
  tables, labels, and automation state.
- External processing: only configured AI providers receive prompts. Provider
  use must be covered by no-training/no-retention terms or a DPA before
  production use.
- Retention: tenant-controlled voice data is exportable and deletable. Usage
  and audit metadata may be retained for billing, security, or abuse prevention.

### Device, Desktop, And Mobile Data

- Web: stores only local preferences, consent choices, and session/browser
  state needed by the app. Telemetry is fail-closed when consent or storage
  cannot be read.
- Desktop: API keys are stored in the operating-system credential vault and any
  legacy localStorage key is migrated out on startup.
- Mobile: secrets use platform secure storage where available; telemetry is not
  enabled by default.

### Web Vitals, Logs, And Telemetry

- Source: browser web-vitals metrics, API logs, request ids, Sentry events, and
  optional analytics providers when configured.
- Stored in: `web_vitals_events`, logs, and provider-specific dashboards.
- Accuracy rule: web-vitals ingestion preserves the browser metric id and sane
  browser timestamp, clamping obviously stale or future timestamps to server
  receipt time.
- Attribution rule: the endpoint is anonymous, so a body-supplied `tenant_id`
  is ignored and the stored tenant attribution is always NULL. Per-tenant
  attribution requires a future authenticated, server-derived identity path.
- Abuse boundary: requests are capped at 64 KiB and 20 metrics; the bounded
  per-client budget is charged by metric count using the deployment's reviewed
  trusted-proxy client-IP resolver.
- Redaction: API logs and Sentry scrub OAuth parameters, tokens, API keys,
  session identifiers, email addresses, subscriber identifiers, recipient
  identifiers, passwords, signatures, and common secret aliases.
- Retention: web-vitals rows are pruned on the raw-payload retention schedule.

### Audit Log

- Source: mutating API calls, admin actions, imports, billing-sensitive actions,
  and security-sensitive workflows.
- Stored in: `audit_log`, partitioned by time where supported.
- Retention: tenant policy controls normal retention, with longer retention for
  security, tax, or legal hold where required.
- Export: audit rows are tenant-exportable except for operational secrets and
  transient infrastructure records.

### Backups

- Local development: Docker volumes and explicit database dumps are the source
  of recovery. Local development data is not a production backup.
- AWS target: RDS automated backups and point-in-time recovery for Postgres;
  versioned/lifecycle-managed S3 buckets for assets, exports, and backup
  artifacts; restore drills through the disaster-recovery runbooks.
- Deletion requests: if a backup restore is required after a deletion request,
  deletion jobs must be replayed before the restored system is returned to
  service.

## Data Export Coverage

Tenant export is implemented as a dynamic table discovery process:

- Include tenant-owned tables that expose `tenant_id`.
- Include explicit tenant metadata that is not tenant_id-scoped.
- Exclude auth sessions, OAuth state, idempotency, queue/outbox records,
  transient migration sessions, and secret-bearing credential stores.
- Omit sensitive secret columns from otherwise exportable tables.
- Preserve structured event fields needed for portability and dispute review.

## Data Residency

The current planning baseline is a single AWS region, currently documented as
`us-east-1` in the AWS economics and deployment runbooks. EU-only residency,
multi-region residency, or tenant-selectable regions require a separate
deployment decision, processor list, backup-region policy, and operational
runbook before they are offered.

## Sub-Processors

The live sub-processor list must match the deployed configuration. Expected
production candidates include AWS, Stripe, configured email-sending providers,
configured AI providers, crash/error monitoring, and optional analytics tools.
Changes should be notified to customers before a new sub-processor begins
processing personal data.
