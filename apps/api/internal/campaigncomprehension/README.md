# Campaign comprehension contracts

`campaigncomprehension` is the model-independent boundary for **Predicted
Agent Comprehension**. It validates output supplied by a separately governed
analyzer and scores that output against the sender's normalized Fact Contract.
It makes no network or model calls.

This package does **not** observe Gmail, Gemini, Apple Intelligence, Copilot,
Yahoo, or any recipient mailbox. A receipt proves only what a named,
versioned analyzer configuration returned for a frozen artifact. An actual
client capture belongs to the separate **Observed Controlled-Test Summary**
provenance class.

## Extraction v1

`DecodeAndNormalizeV1` accepts at most 128 KiB and exactly one closed JSON
object. It rejects unknown fields, duplicate object keys (including nested
keys), trailing JSON, invalid UTF-8, escaped control/lone-surrogate text,
unbounded nesting, invalid stable references, and evidence IDs outside the
caller's exact allowlist. Required empty collections must be `[]`, not `null`.
`ExtractionJSONSchemaV1` returns the closed Draft 2020-12 contract for an
analyzer's structured-output configuration; the runtime parser remains the
authority for semantic formats and security constraints.

The schema contains:

- a one-line summary;
- primary intent and core claim with evidence IDs;
- one primary action with stable action/block IDs, semantic role, label,
  tracking-stripped canonical URL, and evidence IDs;
- facts with a stable fact ID, closed Fact Contract type, raw value, normalized
  value, typed timezone/currency/unit companion, and evidence IDs;
- unsupported claims and ambiguities, each with evidence.

Normalization is pinned by
`campaign-comprehension-extraction-normalization-v1`: NFKC and collapsed
Unicode whitespace for natural language; lowercase closed enums; sorted stable
references and arrays; canonical plain decimals; RFC 3339 timestamps whose
offset matches an IANA timezone; canonical ISO 4217 codes; and absolute HTTP(S)
URLs without credentials or fragments. Known attribution-only query keys
(`utm_*`, click IDs, and common ESP analytics IDs) are removed before query
sorting. This is not a redirect unwrapper and does not fetch URLs.

The receipt hash is SHA-256 over this canonical, versioned preimage:

```json
{
  "schema_version": 1,
  "normalization_version": "campaign-comprehension-extraction-normalization-v1",
  "extraction": {}
}
```

Persist both `canonical_extraction` and `receipt_hash`; verify the receipt again
before scoring. On reload, use `VerifyExtractionReceiptV1AgainstEvidence` with
the frozen scenario evidence manifest; a content hash is not a substitute for
that binding. The enclosing assurance record must still bind artifact hash,
scenario, analyzer/model/prompt/configuration versions, source class, runtime,
seed, cost, latency, and raw-output retention reference.

## Score v1

`ScoreV1` requires a valid normalized `factcontract.ContractV1`, one required
scenario, and two to 64 declared analyzer configuration IDs. It verifies every
receipt and sorts all output deterministically. The numeric composition is:

```text
0.30 Intent Fidelity
+ 0.20 Primary Action Fidelity
+ 0.25 Entity Recovery
+ 0.25 Analyzer Robustness
```

- Intent Fidelity compares declared intent kind/statement and core claim.
- Primary Action Fidelity requires the stable action ID, owning block ID,
  semantic role, and canonical destination; the label is compared separately.
- Entity Recovery weights facts `critical=5`, `important=3`, and
  `supporting=1`; exact/equivalent/wrong-or-missing credit is `1/.5/0` under
  conservative type-specific rules.
- Analyzer Robustness is mean pairwise agreement across intent, claim, action,
  and every declared fact. A pair involving an absent/failed output contributes
  zero. Two analyzers that omit the same required fact do not earn agreement.

Natural-language “equivalence” in v1 only folds case, Unicode normalization,
spacing, and punctuation. It does not infer synonyms or entailment. Codes are
case-sensitive. Datetimes can receive equivalent credit for the same instant
under a different valid timezone representation; quantity units can receive
equivalent credit for conservative spelling/case differences. Model-provided
self-confidence is neither accepted nor scored.

The overall score is `null` if the Fact Contract is invalid or any required
output is missing, failed, invalid, duplicated, or unexpected. Component and
coverage diagnostics remain visible. If no facts are declared, Entity Recovery
is explicitly omitted and the other declared weights are renormalized.

Unsupported claims, matches to sender-declared forbidden claims, and
undeclared extracted facts are explicit results outside the average. A high
score never cancels a contradiction or deterministic Campaign Assurance
blocker. The predicted threshold remains advisory unless a separately
versioned calibration and gate policy says otherwise.

`AggregateScenariosV1` exposes available range and coverage but withholds its
worst/mean aggregate until every required scenario is complete. The worst
complete scenario is the conservative aggregate, not an average that can hide
a weak required branch.

## Verification

The package includes closed-schema/adversarial unit tests, a canonical receipt
golden fixture, typed scoring and missing-evidence tests, scenario aggregation
tests, and fuzz targets for untrusted JSON and corrupted receipts. Run:

```sh
go test -race -count=1 ./internal/campaigncomprehension
go test -fuzz=FuzzDecodeAndNormalizeV1 -fuzztime=10s ./internal/campaigncomprehension
go test -fuzz=FuzzScoreV1TamperedReceipts -fuzztime=10s ./internal/campaigncomprehension
go vet ./internal/campaigncomprehension
```
