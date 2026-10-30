# Campaign Assurance worker

This package is the leased execution boundary for a durable Campaign Assurance
run. `Worker.Process` accepts only an explicit `(tenant_id, run_id)` command,
claims the repository lease, heartbeats it through finalization, and writes all
evidence through the fenced `campaignassurance.Repo` methods.

Before deterministic analysis it revalidates:

- the claimed run/artifact/configuration/target matrix;
- frozen revision, plan, coverage, compiler, renderer, policy, and fixture
  identities;
- artifact-to-coverage scenario coordinates and semantic document hashes;
- internal tenant-relative object references and expected media types;
- bounded HTML, plain-text, MIME, revision, receipt, and manifest sizes;
- exact SHA-256 identities for HTML, text, MIME, and emitted JSON-LD; and
- RFC 2606-only recipient headers in assurance MIME.

Configuration `deterministic.campaignchecks.v1`, generated with
`NewDeterministicConfiguration`, is locally executable. Its complete result is
explicitly labeled a deterministic structural report. Model comprehension and
provider display remain unmeasured. When an `ImageInspector` is explicitly
injected, the worker derives the reviewed image source set from the already
frozen effective semantic revision and passes exact source/artifact/HTML hashes
to the isolated broker. It validates the returned aggregate and every receipt,
then persists bounded OCR text plus hash-only evidence indexes. Invalid,
missing, failed, or partial OCR receipts stay explicitly unavailable.

Modeled configurations use the closed `ModeledConfigurationV1` contract and
execute only when a reviewed `ModelExecutor` and tenant-scoped raw-output store
are explicitly injected. The interface receives bounded, hash-verified
synthetic artifact representations, a stripped ID/type recovery vocabulary,
the closed Extraction-v1 schema, and exact run/target methodology identities.
It receives no repository, URL fetcher, mailbox client, tool definition,
sender-expected fact values, forbidden claims, or intent answers. The worker
enforces a per-configuration deadline and exact returned provenance.

Every valid raw response is retained under the tenant namespace before its
fenced extraction receipt is written. `campaigncomprehension` then strictly
normalizes the output against an exact scenario evidence allowlist and runs the
pinned score-v1 ensemble rubric. The worker persists normalized extraction
receipts, unsupported/ambiguity indexes, contradiction and fact-recovery
findings, a bounded scenario-score manifest, conservative worst-case aggregate,
range, and agreement. Forbidden-claim contradictions and missed critical facts
remain blocking independently of the numeric score; there is no uncalibrated
numeric threshold.

Missing executors/stores, singleton ensembles, unsupported frozen identities,
invalid Fact Contracts, oversized scenario sets, artifact failures, invalid
outputs, and provenance mismatches never become green. Terminal target failures
produce `error`/`unavailable` receipts; unknown provider/transport failures and
deadline expiry requeue the leased run. Controlled-observation targets remain
`unavailable` because a modeled prediction cannot be relabeled as an observed
inbox surface. Artifact integrity failures likewise remain non-overridable
blocking/unavailable evidence; unverified bytes never reach either analyzer.

`GeminiModelExecutor` is the production provider adapter. It is mounted only
when `POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED=true` and every exact model,
model-version, API-key, pricing-version, token-price, and timeout setting is
present and valid. Its fixed production suite uses three distinct
prompt/order/seed members for `fast` and eight for `full`/`calibration`. The
suite hash binds every prompt, representation order, seed, and the Extraction
v1 schema. Provider tools are omitted, redirects are refused, response bodies
and token usage are bounded, provider error bodies are never reflected, and
the returned provider model version must match the frozen run before an output
can become complete evidence. Token cost is recorded as conservatively rounded
micro-USD using the versioned deployment price table.

`Orchestrator` provides the narrow durable-queue integration surface. A command
is acknowledged only after a terminal/no-op result, released at the repository
retry timestamp after a durable requeue, and left unacknowledged when execution
cannot safely advance the lifecycle. `campaignassurancequeue` implements that
surface with migration 1925, exact tenant/run/request deduplication, leased
visibility, and a second heartbeat so queue ownership remains live alongside
the assurance run lease.

Not implemented here:

- production composition and live certification of the isolated image broker,
  OCR engine, encrypted raster evidence store, and retention sweep;
- controlled Gmail/Apple/Outlook/Yahoo surface capture;
- cross-tenant run enumeration; and
- credentialed live-provider and calibrated-corpus certification for the
  production modeled suite.

Those omissions are deliberate. Their targets remain unavailable rather than
being inferred from deterministic checks.
