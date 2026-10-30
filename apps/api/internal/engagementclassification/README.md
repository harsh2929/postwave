# Engagement classification v2 (Track B F01)

This package owns the shadow-mode `human | machine | unknown` decision layer
over the canonical `subscriber_events` ledger. It does not replace that ledger
and it does not mutate raw events when rules change.

## Production composition

1. Publish or load one exact `engagement_machine_registry_entries` revision.
2. Construct `NewClassifier(DefaultConfig(), registry)` once. The classifier is
   immutable and safe for concurrent use.
3. Construct `IngestHook{Repo, Classifier, AggregateBuilder}`.
4. In each provider adapter, insert `subscriber_events` and obtain its exact
   `(id, at)` partition key.
5. In the same `db.WithTenantWorker` transaction, invoke `IngestHook.Record`
   before report projection, automation fanout, or commit. The hook persists
   the immutable observation and exact-version classification atomically.
6. Keep existing reporting unchanged while the methodology is in `shadow`
   mode. Dual-read from `subscriber_event_classification_shadow_v1` for parity,
   coverage, and unknown-share measurement. In that view only an explicit
   `human` row sets `human_signal=true`; missing rows and `unknown` are never
   compatible with human engagement.

Production composition now installs `Runtime` on the canonical Listmonk path.
When enabled, that event transaction opens with `db.WithTenantWorker`, inserts
`subscriber_events ... RETURNING id, at`, and immediately invokes
`IngestHook.Record` before dedupe binding, report/contact projection, webhook
fanout, or commit. When disabled, Listmonk retains ordinary `db.WithTenant`
scope. `RecordInTx` verifies worker scope and will not self-escalate. Runtime
converts recipient, message, and link identities to tenant/purpose-separated
HMAC-SHA256 commitments before persistence and rejects an observation that
still contains the normalized recipient plaintext. Listmonk has no ordered
request-header capture, so it supplies an empty array with
`OrderedHeadersComplete=false`; it never copies gateway headers or claims
completeness. Missing header, TLS, ASN, delivery, or aggregate evidence widens
`unknown`; it never produces a synthetic human classification.

## Stage 2: the delayed evaluator

Stage 1 classifies on arrival, on the evidence that exists on arrival. For the
first event of a message that is one row — one open, no siblings, no delivery
time — and a single open looks human. Forty identical opens 200ms apart do not,
but none of the other thirty-nine has happened yet.

`RecordInTx` therefore arms `engagement_stage_two_evaluations` in the same
commit that persists the observation: one row per `(tenant, message, stage)`,
`ON CONFLICT DO NOTHING`, due `StageTwoDelay` (60s) after the FIRST observed
event, and a second row due at conversion-window close
(`DefaultStageTwoConversionWindow`, 7 days, matching the documented last-touch
attribution look-back). Because the schedule is keyed on the message and its
`due_at` is made immutable by a database trigger, a message under continuous
traffic re-evaluates twice, not once per event and not on a timer that keeps
sliding out of reach.

`StageTwoWorker` drains due rows. It contains no classification logic: it
derives a stage-scoped methodology identity, claims the existing fenced
`event_reclassification_runs` lease under a request id derived deterministically
from `(tenant, message, stage)`, and calls the same `reclassifyEvent` the
window-based path uses. That determinism *is* the mutual exclusion — two workers
reaching one due message contend for one run row and exactly one wins; the other
reports `LeaseHeldElsewhere` and writes nothing.

Each stage owns its own methodology version so an upgraded or downgraded verdict
is an APPENDED row whose `supersedes_id` points at the verdict it replaces.
Re-running a stage recomputes the identical row and is absorbed by the existing
`(event, version identity)` uniqueness, so a crashed pass replays without
duplicating a verdict and the original decision is never overwritten.

## Reclassification and retention

`Repo.ReclassifyWindow` creates a durable request-idempotent cursor run. Each
new methodology/configuration appends an `event_classifications` row with a
`supersedes_id`; previous decisions and `subscriber_events` remain unchanged.
Each run is claimed by an expiring `(worker_id, lease_token, attempt_count)`
fence. Every evidence append, heartbeat, cursor update, failure, and completion
matches the active unexpired fence. A crashed lease is reclaimable with a new
token and exactly incremented attempt; the old worker can no longer append or
finish. Page replay is safe because an exact event/version/configuration
identity is first-write-wins, and durable `reclassification_run_id` lineage
keeps classified/unchanged counts correct if a crash occurs between the append
and cursor persistence.

Raw observation rows are directly append-only. After `privacy_expiry_at`, only
`Repo.PurgeExpiredObservation` may remove one exact row. The database function
requires tenant-worker classifier scope and writes an immutable hash-only
deletion receipt first. Classifications, rules, conflicts, versions, and the
canonical normalized event survive the purge.

`Runtime.RunRetention` supervises a one-minute-by-default sweep with bounded
tenant pages and bounded per-tenant observation batches. Cross-tenant discovery
uses only the tenant resolver; every evidence read and deletion re-enters a
tenant-worker transaction. Production runtime rejects `RawObjectRef` ingestion,
the sweep skips and reports any legacy object-backed row, and the SQL purge
also refuses it. This preserves the exact object pointer until an exact-version
object deletion adapter and receipt are composed rather than orphaning PII.

## Calibration boundary

`CalibrationCorpus` deliberately separates `controlled_machine`,
`labeled_human`, and diagnostic `correlated_human` inputs. A seed-only corpus
is diagnostic only: `is_seed` is itself an absolute classifier input, so using
it to certify machine recall would be circular. Certifying controlled-machine
examples must exercise non-seed scanner/proxy evidence. `EvaluateCalibration` returns
`insufficient_corpus` until both controlled-machine and labeled-human minimums
are present. Persisted calibration reports contain the hashes for all three
corpus classes, inspectable sorted component-hash lists, the exact policy,
global and per-source certifying versus diagnostic confusion cells, and
confidence bounds; they never contain raw examples.

The production file adapter accepts a closed `manifest.json` plus a bounded
JSONL examples file under `postwave.engagement-calibration-corpus.v2`. Each
manifest declares its governed sampling-unit type and each row commits to one
sampling-unit hash. Duplicate unit hashes across every supplied corpus are
rejected so repeated events from one recipient/message/scanner run cannot be
treated as independent observations. The adapter
verifies both exact-file SHA-256 hashes before evaluation, rejects duplicate or
unknown JSON keys, duplicate example IDs, traversal/symlinks, oversized files,
and raw-email-shaped fields, then evaluates an immutable deep-cloned snapshot.
The command also enforces a 256 MiB aggregate evidence budget before retaining
multiple corpora.

Machine precision is not computed from the controlled-machine versus
labeled-human sample mix. Those corpora are case-control samples, so padding
one side would change naive positive predictive value without changing the
classifier. The policy must instead provide an assumed deployment
machine-event prevalence and the SHA-256 of the governed population manifest
that supports it. Precision is derived from recall, false-positive rate, and
that prevalence. Its lower bound uses Bonferroni-adjusted Wilson component
bounds; recall and false-positive gates use their own Wilson bounds. The
defaults deliberately leave prevalence evidence unset so an operator cannot
accidentally certify against an invented base rate.

`go run ./cmd/engagement-calibrate` loads the exact published registry through
the restricted application role. Repeat `--corpus` for every evidence
directory and supply both `--assumed-machine-prevalence` and
`--prevalence-evidence-sha256`. Add `--persist` only when the content-free v2
receipt should enter the append-only ledger. Exit codes distinguish pass (0),
operational failure (1), invalid evidence/invocation (2), policy failure (3),
and insufficient corpus (4).

Registry v1 was initially seeded with six rows by migration 1934 and extended
in place with another twelve by migration 1976, so its version/config tuple is
not a snapshot-complete provenance key. Its rows retain migration 1976's
over-labelled `ai_summarizer` UA matcher as historical evidence. Migration
2033 publishes the corrected, separately versioned current registry v2 row set
with `R_SELF_DECLARED_AGENT_UA`, the `unknown_bot` subtype, and removes
`anthropic-ai` and `google-extended`, which are absent from current
provider-documented HTTP request user agents. Migration 2035 records and
database-seals v2's exact 18-row whole-snapshot fingerprint. It hash-records
the installation's observed v1 ledger as `legacy_append_ambiguous`; the
historical float-rendered row receipts are noncanonical. V1 is inadmissible for
registry loading, new classification, methodology, calibration, or reach
release. A match is
machine-like request evidence, not identity, inbox summarization, recipient-AI
use, human absence, or prevalence. The live claim boundary and its
calibration/cutover holds are maintained in
[`docs/2026-frontier/engagement-classifier-v2-methodology.md`](../../../../docs/2026-frontier/engagement-classifier-v2-methodology.md).
