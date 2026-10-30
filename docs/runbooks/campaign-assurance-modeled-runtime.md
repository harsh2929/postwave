# Campaign Assurance modeled-runtime runbook

The modeled analyzer produces **Predicted Agent Comprehension**, not an
observed Gmail/Gemini/Apple/Outlook/Yahoo result. It is independently gated from
the deterministic Campaign Assurance runtime and defaults off.

## Process topology and required configuration

Production uses four separate trust boundaries. The public API is a
control-plane process only; it never receives a provider key, a model/image
socket, or an assurance-worker capability.

```text
API -> durable command ledger -> worker -> authenticated UDS -> model sandbox
                                                     model sandbox -> authenticated UDS -> provider gateway -> Gemini HTTPS
```

The processes receive only the following configuration:

| Process | Configuration contract |
|---|---|
| API | `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_RUNTIME`, `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED`, exact model ID/version, pricing version/rates, and gate rollout. It creates/reads durable work but never executes it. |
| Worker | Runtime/modeled flags, DB, exact-version S3/KMS raw-output storage, pricing version/rates, `POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET`, expected sandbox UID, and bounded model timeout. It rejects either Gemini key name at startup. |
| Model sandbox | Two fixed Unix sockets, peer UIDs, pricing identity, timeout, and concurrency. It rejects application, cloud, and provider credentials and installs Linux AF_INET/AF_INET6 seccomp before serving. |
| Provider gateway | Dedicated `POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY`, pricing identity, one fixed Unix socket, sandbox UID, timeout, and concurrency. It is the only process allowed provider HTTPS. `GEMINI_API_KEY` is not a production fallback. |

The model identifier and expected provider-returned model version are frozen by
the API into each configuration/request. The gateway cannot silently replace
them; the sandbox/worker reject a different returned model version as
unavailable evidence. Pricing variables are positive canonical integers and
must be identical in the API, worker, sandbox, and gateway or readiness fails.

An explicitly enabled but incomplete/invalid configuration fails the owning
process at startup. When modeled execution is off, deterministic runs remain
available and modeled/controlled evidence is explicitly unavailable; no
process substitutes a stub result.

## Data and network boundary

- Inputs are synthetic merge-fixture artifacts already frozen, hash-verified,
  bounded, and stored under the tenant object namespace.
- The provider receives subject, semantic plain text, HTML, eligible structured
  data, exact RFC MIME, an ID/type-only recovery vocabulary, allowed evidence
  IDs, and the closed extraction schema. Sender-expected answers and real
  subscriber records are not supplied.
- Email URLs are inert strings. The adapter exposes no tools, search, URL
  context, browsing, code execution, mailbox, or callback.
- Raw provider output is committed to the tenant-associated, versioned,
  encrypted S3 store before a normalized extraction receipt can complete. The
  ledger records the exact object version; abandoned-write reconciliation and
  exact-version retention are supervised independently of run execution.
- HTTP redirects are refused, request/response sizes are bounded, and provider
  error bodies are discarded rather than copied into logs or public receipts.

## Exact reuse and cost containment

- Every executable modeled configuration freezes a positive
  `maximum_cost_microunits`. Run creation multiplies that reviewed worst-case
  price by every modeled target and every permitted attempt. The resulting
  `max_modeled_cost_microunits` is immutable run identity, not an operator knob.
- Before each external call, the worker durably reserves the configuration's
  full worst-case cost. The run row is locked while aggregate headroom is
  checked, so concurrent workers cannot oversubscribe it. Reservations are not
  refunded: a timeout, lease loss, or unknown response may still have incurred
  provider cost. A retry therefore needs fresh reserved headroom.
- Known provider usage is settled once in the immutable invocation ledger.
  Unknown metering is recorded as `charge_unknown` with no fabricated token or
  cost values. Terminal run totals are derived from all-attempt settlements,
  so billed retry work cannot disappear from the final receipt.
- Reuse is tenant-local and exact-hash only. The cache identity binds campaign,
  revision, plan, artifact/scenario, MIME and evidence hashes, configuration,
  model/prompt, normalization/scoring/gate/methodology versions, recovery
  vocabulary, allowed evidence IDs, and extraction schema. Operational run,
  attempt, lease, and provider-request IDs are excluded from semantic identity.
- A candidate must be a complete, directly invoked extraction from a run that
  is still `complete`, with identical frozen provenance and a complete matching
  invocation settlement. Cache-reuse chains, partial/error/unavailable
  results, stale runs, other tenants, and expired raw outputs are rejected.
- Before reuse, the worker reads the retained raw output, enforces its type and
  size bounds, verifies its SHA-256, normalizes it again, and proves the result
  equals the immutable normalized receipt. It then atomically rechecks database
  eligibility and writes a zero-cost `cache_reuse` receipt with direct origin
  ID/hash and original-cost lineage. Object retention must keep the referenced
  bytes available until `raw_output_expires_at`; an unreadable object is a miss,
  never reusable evidence.

Budget exhaustion is reported as modeled unavailability with stable reason
`modeled_cost_budget_exhausted` and finding code
`MODELED_COST_BUDGET_EXHAUSTED`. The provider must not be called for that
target. Operators should investigate configuration-price drift, duplicate
execution, or corrupted historical state; they must not raise a live run's
frozen ceiling.

## Rollout and rollback

1. Keep `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED=false` while validating the
   deterministic worker, object-store readiness, and exact model/pricing IDs.
2. Enable in a non-production tenant and run the versioned adversarial corpus.
   Confirm three calls for `fast`, eight for `full`, raw-output retention,
   token/cost receipts, and no provider-version mismatch.
3. Run the credentialed provider certification outside ordinary CI. Archive
   the corpus manifest, suite hash, model/version, pricing version, result
   hashes, latency/error distribution, and operator identity.
4. Roll out advisory-only. Numeric scores must not block sending until a named
   calibration report approves a threshold and false-block budget.
5. To stop external processing immediately, register a new assurance task with
   `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED=false` on the worker and a new
   API task with the same flag false. Promote both through CloudFormation; do
   not inject or remove secrets in place. The provider gateway may remain
   healthy but receives no work. Existing immutable receipts remain readable;
   new runs stay honest about modeled unavailability.

The canonical container/task render, digest verification, secret distribution,
worker-first startup order, and off → shadow → warn → block promotion are in
[`infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../../infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md).

## Readiness evidence still required

The adapter and offline contract tests do not constitute live-provider
certification. Production promotion still requires a credentialed run against
the pinned model/version, privacy/security review of the deployment region and
provider terms, calibrated corpus results, alert thresholds, and a reviewed
pricing update procedure.
