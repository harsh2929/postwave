# Canonical campaign-report projection

This package is the default-off, additive dual-run bridge from canonical
`subscriber_events` to the compatibility read model in
`campaign_report_events`. It records exact source-to-report lineage; it does
not make that report table canonical, switch any reader, or authorize removal
of the remaining direct report writers.

## Protocol stack and runtime gate

Migration 1959 provides exact materialization/adoption, immutable projection
links, and bounded reconciliation. Migration 1964 adds the separately governed
identity/privacy/rollback mutation protocol. Production composition is enabled
only with:

```text
POSTWAVE_ENABLE_CAMPAIGN_REPORT_PROJECTION=true
```

The default and every recognized false value return a real nil dependency and
perform no readiness query. An invalid value fails configuration. An enabled
runtime fails startup unless the restricted `postwave_app` role can prove all
of these boundaries:

- migrations 1959 and 1964 tables and public functions exist;
- the app role can execute only append, identity repoint, privacy erasure, and
  governed rollback entry points, while internal helpers remain inaccessible;
- immutable evidence is readable but not directly writable;
- mutation requests, receipts, and heads are read-only to the app role; the
  private transaction-scoped authorization table has no app privilege at all;
- direct `subscriber_events` updates to `subscriber_email`, `user_agent`, and
  `ip` are revoked; and
- all projection, mutation-evidence, and private-authorization tables have
  enabled and forced tenant RLS.

Enabling this flag means **dual-run, not authoritative**. `sent` and
`conversion` remain outside the canonical subscriber-event vocabulary, and the
mutation protocol remains a separate, purpose-scoped subsystem.

## Eligible live-writer composition

Only campaign-scoped `delivered`, `opened`, `clicked`, `bounced`, `complained`,
`unsubscribed`, and `replied` events are eligible. Producer packages expose a
narrow local transactional interface so they do not depend on one another or
grant themselves worker scope.

| Producer | Composed behavior when enabled |
|---|---|
| Listmonk | Writes the canonical row and its existing exact legacy report peer, then adopts that peer with `AppendInTx` in the same tenant-worker transaction. It never adds a second metric row. |
| ESP deliverability webhooks | Writes a canonical provider event, then materializes its missing report row and lineage in the same transaction. Provider unsubscribe now also records the canonical fact after durable suppression. |
| Authenticated subscriber-event ingest | Projects a newly inserted, eligible campaign event in the same transaction. |
| Strong human replies | After F01 creates and classifies a strongly correlated canonical `replied` event, projects it in that same transaction. Automatic, weakly correlated, duplicate, and sandbox replies remain excluded. |

Any projector error rolls back the caller-owned canonical/report transaction.
Exact replay converges on one lineage row, and a plain tenant transaction cannot
self-elevate into projection worker scope. A deduplicated producer replay is a
no-op and does not retrofit a row written before the feature was enabled;
bounded reconciliation is the explicit retrofit mechanism.

## Fail-closed writer inventory

`writer_coverage_test.go` parses every non-test Go file under `apps/api` and
`services`, fingerprints every literal `INSERT` into `subscriber_events` or
`campaign_report_events`, and requires a mechanically checked disposition. The
current ledger covers 19 production insert sites. A new or changed SQL writer
fails CI until it is composed or receives a narrow exclusion with a stable
policy ID and rationale.

Deliberate exclusions are:

- anonymous attribution: writes `campaign_id = NULL`, so no campaign report
  row can be formed;
- trigger replay `identified`, lifecycle transitions, and all MCP `custom`
  events: domain events outside the report vocabulary;
- sandbox events and onboarding sample rows: synthetic product data;
- Mailchimp compatibility ingest: report-only input with no canonical source
  identity to bind;
- conversion writers: the conversion ledger, not `subscriber_events`, is the
  future canonical source;
- migration archive history: includes report-only geo/device/client/revenue
  dimensions and remains import/rollback-owned until a lossless canonical
  import protocol exists; and
- `sent`: must derive from campaign-recipient/send evidence rather than an
  invented subscriber event.

These exclusions are rollout boundaries, not silent claims that their readers
are canonical.

## What exact projection proves

- The source identity is `(tenant_id, subscriber_events.id,
  subscriber_events.at)` and both source/report foreign keys include tenant and
  partition time.
- A missing exact report row is inserted once. One exact existing row is
  adopted. Ambiguous legacy matches and non-exact replays fail closed.
- Immutable links retain source, report, and projection fingerprints. Linked
  rows cannot be rewritten or deleted through ordinary table privileges.
- Reconciliation requests freeze an immutable time window and source-ID fence,
  then use a request hash, cursor, counters, attempt, lease token, and batches
  capped at 1,000. Projection and cursor advancement commit together.
- An expired worker is fenced out. Source-fence drift can terminate the run
  durably. A new reconciliation request is required for commits that become
  visible after a completed run.
- Projection evidence requires tenant scope plus `app.outbox_worker=true` and
  `app.campaign_report_projection_worker=true`. Controlled-seed rows retain raw
  lineage and stay hidden from ordinary report reads by the recipient-event
  boundary.

The source fence means rows committed and visible when a request is created,
not every backdated transaction that might commit later. A transaction that
allocated an ID before the fence and becomes visible mid-run causes drift
checks to fail closed.

## Governed identity, privacy, and rollback mutations

Canonical events legitimately change during subscriber merge/email rotation,
anonymous-to-known stitching, and privacy erasure. Migration 1964 composes
those specific callers through purpose-scoped security-definer functions. A
linked canonical/report pair changes atomically and appends immutable
request/receipt evidence plus a chained current-state head; ordinary direct
identity/privacy updates remain revoked.

Migration rollback preserves two different boundaries:

- current unlinked legacy import rows retain their tracked tombstone/delete
  behavior; and
- a linked row can be removed only when the canonical event contains the exact
  preallocated imported-resource and job ownership metadata. The source,
  report, link, and mutable head are removed together while the immutable
  tombstone receipt survives.

Do not compose future canonical imports without that ownership metadata. Do
not weaken the projected-row immutability trigger as a shortcut.

## Reader and cutover status

No reader is switched by writer composition. Analytics, reporting,
compatibility APIs, attribution, billing, limits, and migration state may keep
reading `campaign_report_events` while exact adoption holds counts stable.
Classification-aware engagement metrics may join through projection lineage to
canonical F01 evidence, but billing and limits must be the final consumer
cohort.

Authoritative cutover still requires:

1. a quiescent or watermarked historical reconciliation window;
2. tenant-by-tenant count, identity, seed-exclusion, and provenance parity;
3. production dual-run telemetry and a rollback-safe soak window;
4. separate canonical sources for `sent` and `conversion`;
5. a lossless canonical migration-import/ownership design; and
6. consumer-by-consumer adoption, with financial/enforcement readers last.

Exact adoption is not a concurrency barrier for an unmodified peer writer: a
legacy insert racing after the projector's match check can still add a row
because that writer does not hold the canonical-event advisory lock. Historical
reconciliation must therefore stay behind a quiescent/watermarked horizon, and
each eligible live writer must remain transactionally composed before its
window enters reconciliation.
