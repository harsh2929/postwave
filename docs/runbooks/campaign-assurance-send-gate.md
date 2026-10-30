# Campaign Assurance exact-hash send-gate runbook

Campaign Assurance is one staged policy applied to three surfaces: the cached
pre-send status, canonical campaign queue, and the provider boundary. It never
claims that modeled comprehension is a mailbox-provider observation.

## Configuration

| Variable | Contract |
|---|---|
| `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME` | Must be `true` for every active gate rollout so current exact-artifact evidence can be produced. |
| `POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT` | Closed value: `off`, `shadow`, `warn`, or `block`; defaults to `off`. |
| `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE` | Deprecated compatibility alias for `block`. It may be used alone or with explicit `block`; pairing it with `off`, `shadow`, or `warn` fails startup. |
| `POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH` | Independent process-wide live-send interlock. Gate rollout never overrides it. |

An active rollout without the durable runtime, database, or telemetry registry
fails API startup. Block mode additionally fails startup unless the encrypted
tenant object store, migrations 1920–1924, and a raw-MIME provider returning a
correlation receipt pass readiness. A Listmonk-only transport cannot satisfy
the block-mode bound runtime.

## One authority and entry-point contract

The process constructs one `campaignassurancegate.Rollout` and shares it with:

- `POST /api/v1/presend/verdict`, which reads cached evidence for the exact
  `campaign_id`, `content_revision_id`, and `source_hash` under a five-second
  ceiling;
- `queueCampaignCore`, reached by human `/queue`, compatibility `/send`, API,
  MCP/agent, scheduled, and approval-continuation paths; and
- `campaignsendruntime`, which calls `ReauthorizeBound` before artifact reads,
  recipient compilation, or provider work.

The old `/resend-to-non-openers` route directly cloned and enqueued work. It is
disabled in every active rollout. `/resend-unopened` is clone-only and returns
the exact next workflow: freeze the intended non-opener audience, run assurance
for the clone, then call its canonical `/queue` path.

Frequency-deferred recipients are continuations of an already authorized queue
operation. The retry promotion copies the complete immutable binding from the
campaign's canonical work set, including revision, plan, run/attempt, all three
hashes, decision, full sorted waiver set, and bound time. In block mode the
send guard independently withholds every unbound or partially bound row with
`BOUND_ASSURANCE_REQUIRED`/`BOUND_RUNTIME_*`; pre-rollout or secondary-producer
rows can never fall through to Listmonk.

The cross-tenant retry claim is migration 1939's only new RLS window. It
requires both transaction-local `app.outbox_worker=true` and the dedicated
`app.intelligent_retry_worker=true`; a generic worker alone sees and updates no
retry rows. The dedicated policies grant `SELECT`/`UPDATE` only. They add no
worker `INSERT`/`DELETE` authority and do not alter ordinary tenant policy.

## Rollout semantics

1. `off`: no Campaign Assurance component is added to pre-send and legacy
   unbound delivery remains available behind the independent live-send gate.
2. `shadow`: pre-send and queue consume the same exact-hash evaluation and emit
   observations, but queue authorization errors do not bind or block work.
3. `warn`: identical enforcement to shadow while product messaging may be
   promoted to operator warning. It still does not create a provider binding.
4. `block`: queue fails closed for missing, pending, stale, incomplete,
   integrity-invalid, or deterministically blocked evidence. A blocked run is
   sendable only when every current blocking deterministic finding has a latest
   unexpired `allow_send` decision from an owner/admin, matching the finding
   receipt and artifact-set hash.

Do not jump directly from off to block. Hold each advisory stage long enough to
measure exact-revision coverage, stale/pending share, dependency errors, and
queue latency against named launch thresholds.

## Immutable queue and dispatch proof

Migration 1923 copies the authorization receipt onto every
`campaign_recipients` row and makes it immutable. Queue replay rejects an
existing recipient whose binding differs. At dispatch:

1. the same exact-hash evaluator reauthorizes current run state and reconstructs
   the complete sorted live waiver set;
2. that receipt must equal every immutable queue field, including all waiver
   IDs;
3. frozen revision, plan, coverage, configuration, target, and synthetic
   artifact identities are verified;
4. recipient-specific RFC822 is compiled once with the frozen compiler and
   transform manifest;
5. the raw transport receives those compiled bytes unchanged and validates the
   SHA-256 before calling the provider; and
6. migration 1924 rechecks the complete latest waiver set inside the delivery
   INSERT transaction, closing the reauthorization-to-provider race.

The durable delivery coordinator owns idempotency and ambiguity. An accepted
attempt replays its receipt without another provider call; an indeterminate
provider outcome is terminal and never blindly retried.

## Telemetry and alerts

`postwave_campaign_assurance_gate_decisions_total` has only closed labels
`mode`, `surface`, `status`, and `action`. The surfaces are `presend`, `queue`,
and `dispatch`; no tenant, campaign, run, finding, content, or upstream error is
a metric label. `postwave_campaign_assurance_gate_duration_seconds` records
cached evaluation latency by surface and status.

The send loop independently emits
`postwave_sendloop_assurance_dispatch_blocks_total{reason}` for the global
provider-boundary interlock. `reason` is a closed non-PII vocabulary:
`BOUND_ASSURANCE_REQUIRED`, `BOUND_RUNTIME_UNCONFIGURED`,
`BOUND_UNSUBSCRIBE_UNAVAILABLE`, or `BOUND_RUNTIME_INVALID_RESULT`. It has no
tenant, campaign, recipient, run, finding, content, or error label. Logs carry
the same stable reason and the tenant/campaign correlation needed for bounded
operator investigation.

Alert in block mode on:

- any sustained `surface="dispatch",action="block"` increase;
- `status="error"` or `status="unavailable"` above the approved dependency
  budget;
- p99 queue/dispatch evaluation latency approaching five seconds;
- any increase of
  `postwave_sendloop_assurance_dispatch_blocks_total{reason="BOUND_ASSURANCE_REQUIRED"}`,
  which indicates a pre-rollout or unauthorized secondary recipient producer;
  and
- raw-delivery indeterminate receipts, which require reconciliation rather
  than automatic resend.

## Rollback

Move `block` to `warn`, then `shadow`, rather than deleting immutable receipts.
Already bound rows remain strictly reauthorized even after a rollout downgrade;
this is intentional so waiver revocation or run staleness cannot be bypassed.
If immediate live-send containment is required, disable
`POSTWAVE_ENABLE_CAMPAIGN_LIVE_DISPATCH` first. Setting rollout to `off` affects
new queue decisions only; it never weakens a row that already carries a receipt.

## Release evidence

Before production block rollout, archive:

- fresh migrations 1920–1924 and 1939 application under the migration role;
- restricted `postwave_app` queue, RLS, immutable-binding, plural-waiver,
  revocation, and delivery-lifecycle database suites;
- race suites for `campaignassurancegate`, `campaigns`, `campaignsendruntime`,
  `campaigndelivery`, `sending`, `presend`, and `intelligent_retry`;
- load results for cached pre-send, concurrent queue, retry promotion, and
  provider-bound dispatch; and
- credentialed capture-mailbox proof that provider-accepted RFC822 preserves
  normalized MIME/body/semantic hashes, allowing only documented transport
  headers.

Ordinary CI proves offline contracts, not production capacity or provider
acceptance. Keep block rollout closed until the last two evidence classes are
reviewed.
