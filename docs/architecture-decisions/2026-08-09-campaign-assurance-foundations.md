# Campaign Assurance foundation decisions

**Status:** Accepted

**Date:** 2026-08-09

**Decision owners:** Moosewave campaign, deliverability, analytics, security, and product engineering

**Supersedes:** No prior architecture decision

**Related baseline:** [`../moosewave-ai-inbox-campaign-assurance-implementation-blueprint-2026-08-09.md`](../moosewave-ai-inbox-campaign-assurance-implementation-blueprint-2026-08-09.md)

## Context

Campaign Assurance cannot issue a trustworthy semantic receipt while campaign
delivery sends mutable HTML, seed polling records placement-only headers, and
two Inbox Reality paths own incompatible lifecycles. The same ambiguity exists
in engagement analytics: normalized subscriber events, campaign report events,
and provider ingestion paths currently behave like peer sources.

This decision fixes the service, identity, evidence, transport, privacy, and
gate boundaries that implementation may rely on. It does not claim that
Moosewave can observe a recipient's personalized AI inbox.

## Decision

### Product and evidence language

- **Agent Legibility** is the umbrella product capability.
- A modeled result is **Predicted Agent Comprehension** and may expose a
  decomposable **Predicted Comprehension Score**.
- A summary captured from an owned, named test configuration is an **Observed
  Controlled-Test Summary**.
- Folder/category evidence remains **Inbox Reality placement**.
- UI, API, SDK, CLI, MCP, audit exports, sales material, and support tooling must
  preserve these names and the modeled/observed distinction. They must not say
  "what Gemini saw" or use "summary placement" for modeled output.
- Every engagement rate must expose an unambiguous numerator and denominator;
  a bare `ctr` field or label is prohibited in new contracts.

Evidence is grouped into four source classes and never silently merged:

1. deterministic artifact/compiler evidence;
2. modeled comprehension evidence;
3. controlled mailbox/client observations; and
4. live recipient/provider events.

### Launch and gate policy

Program A (F06–F11, then measured F13) launches before Program B. Program B
(F01–F05, F12, then F14–F15) may proceed in parallel after the shared artifact
identity exists. F16 remains demand-gated as required by the PRD.

Only deterministic failures block the initial release. The predicted numeric
score is advisory until a versioned calibration report establishes false-block
rate and outcome correlation on a named corpus. Queueing fails closed for stale
or mismatched artifacts, missing required analyzer output, invalid MIME,
unresolved critical branches/merge slots, and tenant/security failures.

### Service ownership and one Inbox Reality lifecycle

The API/gateway is the sole public lifecycle authority. It owns:

- tenant-scoped test/run IDs, idempotency, authorization, entitlements, audit,
  public state, and receipts;
- mutable campaign drafts, Fact Contracts, immutable content revisions, send
  plans, render artifacts, the canonical compiler, and artifact hashes;
- the public Campaign Assurance API and authoritative queue-time gate; and
- dispatch of compiled messages through a raw-MIME-capable transport boundary.

The deliverability service is the execution engine. It owns:

- controlled seed registry operations, mailbox polling, MIME acquisition, and
  provider/client capability observations;
- deterministic inbox-specific analyzers, OCR orchestration, model extraction
  suites, normalization, scoring, and calibration; and
- idempotent internal commands/events that advance the gateway-owned public
  lifecycle.

`apps/api/internal/inboxreality` must stop using `StaticSeedRegistry{}` as a
production authority. Gateway creation will issue a durable idempotent command
to the deliverability engine; results return through one authenticated internal
contract. The duplicate deliverability report identifier may survive as an
internal execution ID only and must map one-to-one to the gateway test ID.

### Immutable artifact identity

The mutable `campaigns` row is an editor draft, never an assurance oracle.

- An explicit save, assurance request, or queue attempt creates or reuses an
  immutable `campaign_content_revision` addressed by canonical source hash.
- A `campaign_send_plan` freezes revision, variants, locale/conditional
  coverage, synthetic fixture set, renderer/compiler/transform versions, and
  gate policy.
- A `campaign_render_artifact` represents exactly one required scenario and
  stores projection hashes, normalized MIME-structure hash, outbound MIME hash,
  compiler receipt, and encrypted short-lived object references.
- Queue/send ledgers bind plan ID, scenario ID, compiler version, and outbound
  MIME hash to every recipient attempt.
- Live dispatch may substitute only declared runtime slots under the frozen
  plan. It may not re-render from a mutable campaign row.

The API owns these records and their RLS policies. Large payloads use the
existing tenant-associated object storage/KMS boundary rather than unrestricted
database body columns.

### Canonical compiler and transport

One server-side compiler projects semantic HTML, semantic `text/plain`, and
eligible provider markup, applies declared transforms, composes RFC MIME, and
returns hashes/receipts. Preview, assurance, seed, and live-delivery paths must
call this compiler.

The campaign transport accepts an already compiled message and must not
re-render it. The selected production path must support raw RFC messages or a
certified equivalent that preserves `multipart/alternative` with plain text
first and HTML last. The existing HTML-only Listmonk route remains behind a
legacy flag and is never labeled multipart-compliant. SES raw MIME is a
candidate adapter, not certified campaign transport until dedicated
messenger/IP routing, DKIM/SPF/DMARC, suppression, idempotency, feedback, reply,
and provider-event parity pass live capture tests.

### Retention and model-input policy

- Synthetic assurance fixtures use reserved identities and contain no real
  subscriber PII.
- Real-recipient MIME is not retained by default.
- Received seed MIME, raw model output, OCR payloads/text, and controlled
  screenshots start with a 30-day maximum retention class, subject to a shorter
  tenant/legal policy.
- Durable hashes, structured findings, normalized scores, versions, and audit
  metadata follow normal campaign/audit retention when they contain no direct
  PII.
- Sensitive objects are encrypted with tenant-associated KMS context, accessed
  by short-lived authorized references, never logged, and deleted or
  crypto-shredded on expiry/erasure.
- The model worker has no tools, browser, network, credentials, or action
  capability. Content is untrusted quoted data and output must pass a closed
  JSON schema.

### Track B canonical event direction

`subscriber_events` is the canonical normalized domain-event ledger.

- Add `subscriber_event_observations` as the append-only raw/provenance envelope
  with versioned schema, idempotent source identity, ordered headers,
  provider/message identifiers, seed attribution, short-lived encrypted raw
  object reference, and privacy expiry.
- Add append-only `event_classifications` keyed by canonical event and
  classifier/methodology version. The closed top-level classes are `human`,
  `machine`, and `unknown`; conflicting evidence remains visible.
- Treat `campaign_report_events` as a rebuildable projection. Migrate through
  dual-write, reconciliation, backfill, consumer cutover, and only then stop its
  independent ingestion.
- Provider-specific payload handlers are input adapters. Each must emit one
  idempotent canonical event identity rather than creating another peer ledger.

F12 uses the human-engaged floor plus an explicit unknown-only upper band and
cannot launch before classifier calibration includes both machine and labeled
human corpora.

## Consequences

- The artifact foundation and multipart transport are prerequisites for any
  score or send gate.
- A modeled score cannot be upgraded into observed provider evidence by naming
  or UI placement.
- Every meaningful variant/locale/semantic branch needs a terminal result; a
  campaign-wide average cannot hide a failed scenario.
- Raw evidence costs and privacy exposure stay bounded independently of durable
  receipts.
- Existing Listmonk, seed, analytics, holdout, conversion, and reply code is
  migrated behind these boundaries rather than duplicated.

## Required verification before rollout

1. Forced-RLS, composite-tenant-FK, append-only, lifecycle-transition, and
   concurrent-idempotency database tests for each new evidence table.
2. Golden compiler fixtures and deterministic hashes across HTML, text,
   structured data, normalized MIME structure, and outbound MIME.
3. Capture-mailbox certification for MIME order, authentication, headers,
   dedicated routing, feedback correlation, retries, and suppression parity.
4. End-to-end gateway test creation → deliverability dispatch → mailbox
   observation → receipt through the one public lifecycle.
5. Queue-path tests proving manual, scheduled, approval, API, mobile, and agent
   sends consume the same exact-hash verdict.
6. Versioned classifier/calibration reports before human-engagement labels or
   probabilistic score thresholds become authoritative.
