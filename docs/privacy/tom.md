# Technical And Organizational Measures

This document describes the technical and organizational measures Moosewave
maintains to protect personal data, in support of GDPR Article 32 and Annex 2
of the Data Processing Agreement.

Last reviewed: 2026-05-11. Next review: 2026-11-11.

Status: Moosewave can be run locally through Docker for development and test.
The production target is AWS-first, with exact regions and sub-processors set
by the deployment decision.

## 1. Confidentiality

### 1.1 Physical Access Control

- Production infrastructure should run only on managed providers with published
  data-center security controls and processor terms. The current AWS-first
  target relies on AWS physical controls for compute, database, object storage,
  secrets, networking, and backup storage.
- Moosewave employees do not access production hardware directly.

### 1.2 Logical Access Control

- Administrative access requires individual accounts and multi-factor
  authentication for source control, cloud infrastructure, billing, observability,
  sending providers, AI providers, and payment processors.
- Production access must be least-privilege, role-based, time-bound where the
  provider supports it, and logged.
- Database access must use non-owner application roles so row-level security
  policies apply to application queries.

### 1.3 Data Access Control

- Tenant tables use row-level security with the per-transaction
  `app.tenant_id` setting. Application code should enter tenant scopes through
  `db.WithTenant`.
- Tenant exports discover tenant-scoped tables dynamically and exclude
  credential, OAuth state, idempotency, queue/outbox, and transient migration
  records.
- Secret columns in otherwise exportable tables are omitted from exports.

### 1.4 Pseudonymization And Encryption

- At rest: sensitive secrets are envelope-encrypted in application-managed
  ciphertext envelopes; the AWS target should move KEKs into AWS KMS before
  production launch.
- In transit: public traffic uses HTTPS; service and database traffic must use
  TLS where supported by the deployed provider.
- Desktop: API keys are stored in the operating-system credential vault, with
  legacy localStorage keys migrated out on startup.
- Mobile: secrets should use platform secure storage where available.

## 2. Integrity

### 2.1 Transmission Control

- Dodo Payments and compatibility Stripe webhooks are signature-verified before processing.
- Provider webhooks and inbound endpoints must use configured secrets,
  signatures, or unguessable per-tenant tokens.
- Listmonk/API service calls authenticate over HTTP interfaces and should use
  private networking or TLS in production.

### 2.2 Input Control

- Mutating API calls write audit records with actor, action, request id, target
  resource, and structured metadata where available.
- Public form submissions write form data and, when consent is supplied, a
  corresponding `consent_events` ledger entry.
- API error handling avoids exposing SQL details, stack traces, secrets, or raw
  provider payloads to clients.

### 2.3 Logging And Redaction

- API logs redact OAuth parameters, tokens, API keys, passwords, signatures,
  session identifiers, email addresses, subscriber identifiers, and recipient
  identifiers.
- Sentry clients on API, web, desktop, and mobile scrub common secret and PII
  query parameters before events leave the app.
- Telemetry defaults fail closed when consent or local storage cannot be read.

## 3. Availability And Resilience

- Local development recovery relies on Docker volumes and explicit database
  dumps; local data is not a production backup.
- AWS production target: RDS automated backups and point-in-time recovery,
  versioned/lifecycle-managed S3 for object data and backup artifacts, and
  documented restore drills.
- Deployment and migration changes should be reversible or forward-fixable with
  no data loss; data-safety runbooks define preflight checks, lock handling,
  restore tests, and rollback points.
- Raw provider payload retention jobs minimize old webhook payloads while
  retaining structured support and audit fields.

## 4. Process For Regular Review

- Review this TOM at least every six months and after material architecture
  changes.
- Run dependency scanning, vulnerability checks, migration safety checks, and
  focused tests before release.
- Keep deployment docs, data-flow docs, sub-processor lists, and cost/economic
  docs aligned with the actual deployed stack.

## 5. Data Minimization

- Subscriber records require only an email address; additional fields are
  tenant-defined.
- Campaign analytics use structured event fields and campaign-recipient
  denominators, not raw payloads, for long-term reporting.
- Successful and dead-lettered webhook retry payloads are retained only for the
  operational support window.
- Web-vitals rows are retained for a limited diagnostics window.

## 6. Sub-Processors

The live sub-processor list must match the deployed configuration. Expected
production candidates include AWS, Stripe, configured email-sending providers,
configured AI providers, crash/error monitoring, and optional analytics tools.
Customers should receive advance notice before a new sub-processor begins
processing personal data.

## 7. Data Rights

Tenants can export their data through the data-export workflow. Deletion,
correction, portability, and objection requests are supported through tenant
administration and operational runbooks. Restores from backup must replay any
deletion requests that occurred before the restored system returns to service.
