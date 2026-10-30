# Deterministic Campaign Assurance checks

`campaignchecks` is the offline, deterministic F06/F07/F09/F10/F11 analyzer for
one immutable `campaignartifact.Revision` and one exact
`campaigncompiler.Result`. It does not persist results and does not depend on
the `campaignassurance` lifecycle package.

F06 is the one feature with a half that cannot be deterministic, and it is kept
behind a second entry point rather than folded into `Analyze` — see
[Predicted agent comprehension (F06)](#predicted-agent-comprehension-f06).

## Contract

```go
report := campaignchecks.Analyze(campaignchecks.Input{
    Revision:      revision,
    Compilation:   compiled,
    PolicyVersion: "postwave.campaign-assurance.gate-policy.v1",
    ImageMetadata: brokerReceipts, // optional; already sandboxed metadata only
})
```

`Analyze` uses no clock, randomness, filesystem, browser, DNS, HTTP client, or
other I/O. It never follows an image, action, stylesheet, or schema URL. The
same complete input produces the same sorted findings and fingerprints.

Each `Finding` has the neutral fields needed by
`campaignassurance.FindingInput`: an uppercase code, deterministic source
class, severity/gate flags, dimension, typed block/evidence references,
canonical expected and observed JSON values, explanation, typed remediation,
detector version, and policy version. `Finding.PersistenceFields()` marshals
the finding-owned containers; the assurance worker adds the frozen artifact,
configuration, and extraction identities before persistence.

The adaptation is mechanical:

| Neutral field | `campaignassurance.FindingInput` |
|---|---|
| `Code`, `SourceClass`, `Severity`, `Blocking`, `Overridable`, `Dimension` | copied directly |
| `BlockReferences`, `EvidenceReferences` | canonical JSON arrays returned by `PersistenceFields()` |
| `ExpectedValue`, `ObservedValue` | copied canonical JSON values |
| `Explanation`, `DetectorVersion`, `PolicyVersion` | copied directly |
| `Remediation` | canonical JSON object returned by `PersistenceFields()` |
| `TypedPatch` | canonical object plus `TypedPatchSchemaVersion`, when present |
| run target identity | worker supplies `ArtifactID`, `ConfigurationID`, and optional `ExtractionID` from its frozen target |

## Predicted agent comprehension (F06)

F06 asks whether an AI summariser can faithfully represent this message. Its two
named failure reasons are deliberately not the same kind of check.

`CTA_ONLY_IN_IMAGE` is deterministic and is emitted by `Analyze`. No model is
needed to know that a summariser which cannot see images has no way to convey an
action that exists only as pixels. It fires when the declared primary action —
or, when nothing is declared, every actionable link in the message — carries no
live text and is filled by an image. One live-text action suppresses it;
transactional footer boilerplate (`Unsubscribe`, `View in browser`, preference
and policy links) neither triggers nor suppresses it, because reporting
"unsubscribe" as a message's call to action misrepresents it just as badly as
reporting none.

`SUMMARY_UNSTABLE` cannot be deterministic, so it lives behind an injected
summariser and a second entry point:

```go
stability := campaignchecks.AssessSummaryStability(ctx, input,
    campaignchecks.NewJSONSummarizer(invokeReviewedModel))
```

The message is summarised `SummaryRunCount` (8) times and the 28 pairs of
answers are compared on three dimensions — the one-line summary (share of
content words in common), the primary intent, and the primary action (exact
agreement). Each dimension has its own floor rather than contributing to one
weighted mean, because a mean lets two calm dimensions pay for a violent one:
half the runs naming a different button is the failure a customer cares about
and must not be averaged away. `SummaryVarianceV1` reports run counts, distinct
values, all three agreements and the dimensions that failed, so the result is the
spread rather than one sampled answer.

`AssessSummaryStability` returns a tri-state `Status`, and the third state is
load-bearing. A nil summariser, an over-limit artifact, fewer than two usable
drafts, or any failed run yields `not_assessed` with a
`SUMMARY_STABILITY_NOT_ASSESSED` finding and `agent_summary=unavailable` — never
`pass`. Observed divergence is evidence in its own right, so a partially
answered run can still `fail`; observed agreement across a partial sample is not
evidence of stability, so it cannot pass. Model drafts are returned on the result
for the caller, and never echoed into a finding's observed value.

`Analyze` itself is unchanged by any of this: it makes no model call, performs no
I/O, and still declares `model_comprehension=unavailable`.

## What is checked

- **F06 / predicted agent comprehension:** a call to action that exists only
  inside an image, and — behind an injected summariser only — multi-run summary
  instability with its per-dimension variance.
- **F07 / transport:** strict `multipart/alternative`, exactly two UTF-8
  quoted-printable parts, plain text first and HTML last, decoded part bytes
  exactly equal to the compiler projections, subject parity, CRLF safety, and
  manifest/artifact/receipt hash and version parity.
- **F09 / image-carried meaning:** alt semantics, decorative-image behavior,
  zero-sized images, Fact Contract blocks that point only to images, and
  availability of caller-supplied verified image metadata. Critical facts and
  actions must exist in live text; alt text is not treated as a substitute.
- **F10 / Fact Contract:** closed-schema v1 decoding and validation, exact
  recovery of the core claim, primary action, and every required display fact
  in semantic plain text and visible HTML; block-reference drift; conditional
  scenario omissions; typed-source contradictions; and parity with emitted
  allowlisted JSON-LD.
- **F11 / manipulation:** inline and simple embedded-CSS checks for hidden,
  tiny, transparent, zero-size, clipped, `mso-hide`, and offscreen text;
  zero-width/bidirectional controls; comments and text containing narrow
  high-confidence instruction-like patterns; executable/interactive HTML; and
  numeric-entity obfuscation. Complex or external CSS is reported as
  unavailable and is never fetched.
- **Semantic accessibility:** one visible H1, heading order, informative image
  alt text, CTA labels/destinations, and exactly one visible semantic primary
  action. An unambiguous heading-level repair includes a versioned typed patch;
  applying it must create a new revision.

### Finding-code ownership

`FindingDefinitions()` is the executable, sorted code-to-feature mapping and is
covered by an AST test that fails if a detector adds an uncatalogued code. The
current mapping is:

| PRD feature | Finding codes |
|---|---|
| F06 | `CTA_ONLY_IN_IMAGE`, `SUMMARY_STABILITY_NOT_ASSESSED`, `SUMMARY_UNSTABLE` |
| F07 | `ARTIFACT_RECEIPT_MISMATCH`, `COMPILER_RECEIPT_VERSION_MISMATCH`, `FINDING_LIMIT_EXCEEDED`, `HTML_ANALYSIS_WORK_LIMIT_EXCEEDED`, `HTML_PARSE_FAILED`, `HTML_REPRESENTATION_MISSING`, `HTML_TREE_LIMIT_EXCEEDED`, `INPUT_LIMIT_EXCEEDED`, `MIME_ALTERNATIVE_INVALID`, `MIME_ALTERNATIVE_ORDER_INVALID`, `MIME_LINE_ENDINGS_INVALID`, `MIME_MESSAGE_INVALID`, `MIME_MESSAGE_MISSING`, `MIME_PART_BODY_INVALID`, `MIME_PART_CONTENT_MISMATCH`, `MIME_PART_COUNT_INVALID`, `MIME_PART_HEADERS_INVALID`, `MIME_PART_INVALID`, `MIME_STRUCTURE_RECEIPT_MISMATCH`, `MIME_SUBJECT_MISMATCH`, `MIME_VERSION_INVALID`, `PLAIN_TEXT_ORIGIN_INVALID`, `PLAIN_TEXT_REPRESENTATION_MISSING`, `POLICY_VERSION_INVALID`, `RECEIPT_ENTRY_LIMIT_EXCEEDED`, `REPRESENTATION_HASH_MISMATCH`, `REPRESENTATION_MANIFEST_INVALID`, `SEMANTIC_TREE_INVALID`, `SOURCE_HASH_INVALID`, `VISIBLE_HTML_TEXT_MISSING` |
| F09 | `CRITICAL_IMAGE_INSPECTION_UNAVAILABLE`, `CRITICAL_IMAGE_OCR_RECOVERY_FAILED`, `CTA_ONLY_IN_IMAGE`, `DECORATIVE_IMAGE_ALT_NONEMPTY`, `FACT_MEANING_IMAGE_ONLY`, `FINDING_LIMIT_EXCEEDED`, `IMAGE_ALT_MISSING`, `IMAGE_BROKER_UNAVAILABLE`, `IMAGE_DIMENSION_METADATA_MISMATCH`, `IMAGE_METADATA_INVALID`, `IMAGE_METADATA_LIMIT_EXCEEDED`, `IMAGE_METADATA_SOURCE_MISMATCH`, `IMAGE_OCR_PROMPT_MANIPULATION`, `IMAGE_OCR_UNAVAILABLE`, `IMAGE_TEXT_RECOVERY_UNAVAILABLE`, `INFORMATIVE_IMAGE_ALT_EMPTY`, `INPUT_LIMIT_EXCEEDED`, `POLICY_VERSION_INVALID`, `PRIMARY_ACTION_IMAGE_ONLY`, `ZERO_SIZE_IMAGE` |
| F10 | `CORE_CLAIM_RECOVERY_FAILED`, `CRITICAL_IMAGE_OCR_RECOVERY_FAILED`, `CTA_DESTINATION_MISSING`, `CTA_LABEL_MISSING`, `FACT_CONTRACT_INVALID`, `FACT_CONTRACT_UNAVAILABLE`, `FACT_MEANING_IMAGE_ONLY`, `FACT_REPRESENTATION_DIVERGENCE`, `FACT_SOURCE_BLOCK_DRIFT`, `FACT_SOURCE_BLOCK_NOT_IN_SCENARIO`, `FACT_SOURCE_CONTRACT_CONTRADICTION`, `FACT_STRUCTURED_DATA_CONTRADICTION`, `FINDING_LIMIT_EXCEEDED`, `FORBIDDEN_CLAIM_PRESENT`, `HEADING_EMPTY`, `HEADING_LEVEL_SKIPPED`, `HTML_ANALYSIS_WORK_LIMIT_EXCEEDED`, `HTML_TREE_LIMIT_EXCEEDED`, `IMAGE_TEXT_RECOVERY_UNAVAILABLE`, `INPUT_LIMIT_EXCEEDED`, `POLICY_VERSION_INVALID`, `PRIMARY_ACTION_BLOCK_NOT_IN_SCENARIO`, `PRIMARY_ACTION_CONTRACT_CONTRADICTION`, `PRIMARY_ACTION_IMAGE_ONLY`, `PRIMARY_ACTION_RECOVERY_FAILED`, `PRIMARY_ACTION_SCHEMA_CONTRADICTION`, `RECEIPT_ENTRY_LIMIT_EXCEEDED`, `REQUIRED_FACT_DISPLAY_MISSING`, `SEMANTIC_PRIMARY_ACTION_COUNT_INVALID`, `SEMANTIC_TREE_INVALID`, `SOURCE_HASH_INVALID`, `STRUCTURED_DATA_EMBEDDING_MISMATCH`, `STRUCTURED_DATA_INVALID`, `STRUCTURED_DATA_MANIFEST_MISMATCH`, `STRUCTURED_DATA_SCRIPT_COUNT_INVALID`, `STRUCTURED_DATA_STATUS_MISMATCH`, `STRUCTURED_DATA_TYPE_UNSUPPORTED`, `STRUCTURED_STATUS_EVIDENCE_OVERCLAIM`, `TOP_LEVEL_HEADING_COUNT_INVALID`, `TOP_LEVEL_HEADING_MISSING`, `UNDECLARED_STRUCTURED_DATA`, `VISIBLE_HTML_TEXT_MISSING` |
| F15 | `OFFER_CANONICAL_DISAGREEMENT`, `OFFER_CANONICAL_MISSING` |
| F11 | `COMPILER_PREHEADER_MISSING`, `COMPLEX_CSS_VISIBILITY_UNAVAILABLE`, `EXECUTABLE_SCRIPT_PRESENT`, `EXTERNAL_STYLESHEET_NOT_ANALYZED`, `FINDING_LIMIT_EXCEEDED`, `HIDDEN_PROMPT_MANIPULATION`, `HIDDEN_TEXT_DETECTED`, `HTML_ANALYSIS_WORK_LIMIT_EXCEEDED`, `HTML_ENTITY_OBFUSCATION_PATTERN`, `HTML_TREE_LIMIT_EXCEEDED`, `IMAGE_OCR_PROMPT_MANIPULATION`, `INPUT_LIMIT_EXCEEDED`, `INTERACTIVE_HTML_PRESENT`, `POLICY_VERSION_INVALID`, `PREHEADER_PROVENANCE_INVALID`, `TEXT_OBFUSCATION_CONTROL`, `TINY_TEXT_DETECTED`, `VISIBLE_PROMPT_MANIPULATION_PATTERN`, `ZERO_SIZE_IMAGE` |

F15's two codes are the only ones in this package whose input is a DATABASE
READ rather than the artifact. Resolving a canonical offer answers differently
on two calls with the same message — that is the whole point of a bridge that
names an entity instead of copying a snapshot — so the read happens in the
caller and arrives on `Input.CanonicalOffers` already resolved, keeping `Analyze`
pure. A nil slice means nobody resolved anything and is reported as nothing
assessed, never as agreement.

`OFFER_CANONICAL_MISSING` blocks and `OFFER_CANONICAL_DISAGREEMENT` does not.
A message naming an entity that does not exist makes a promise the product
cannot answer for; two records that merely disagree is often legitimate and
transient (an entity edited after the draft, an offer since sold out), and
blocking there would stop a correct message going out because a field moved.
What matters is that the sender is told, since otherwise the recipient and an
agent are given different answers and neither knows.

The compiler preheader is the only hidden markup allowlisted today. The check
requires one exact `data-postwave-preheader` element, the exact compiler-owned
style, first position in `<body>`, exact frozen preview text, no nested markup
or instruction-like content, bounded length, and matching compiler/transform
hash receipts. Merely copying the marker does not earn the allowlist.

## Deliberate negative capabilities

Reports expose `image_ocr=provided` only when every supplied reviewed-image
receipt has a matching frozen source/artifact/HTML identity, a persisted safe
raster, and valid OCR engine/runtime provenance. Missing, failed, mixed, or
malformed receipts remain explicitly `unavailable`; they never imply success.
`model_comprehension=unavailable`, and that stays true even when a caller merges
an `AssessSummaryStability` result into the same report: those findings carry the
`agent_comprehension` dimension precisely so a reader can tell which half of the
report was computed from bytes and which half from a model. `ImageMetadata` is a hook for metadata
receipts from a separately sandboxed broker; a verified receipt must bind both
the semantic source-URL hash and immutable asset hash, carries no OCR text, and
this package cannot fetch the referenced asset. Findings therefore describe exact
structural recovery, never “what Gemini saw,” inbox summary placement, OCR
recovery, or modeled comprehension.

This source-level HTML analysis is not a claim about client-specific computed
CSS. Unsupported selectors, media queries, and external stylesheets produce an
explicit warning. Observed inbox/client behavior belongs in controlled seed
observations, not in this report.

## Resource envelope

Parsing is capped at 8 MiB HTML, 2 MiB text, 32 MiB MIME, and 1 MiB each for
JSON-LD, the Fact Contract, and receipt JSON. Receipt arrays are capped at
100,000 entries. HTML is capped at 100,000 elements and depth 256; simple CSS
at 256 KiB/2,048 rules; image receipts at 2,048, 4 KiB per metadata string,
64 MiB encoded size, 100,000 pixels per dimension, and 100 million total
pixels; structured data at 20,000 values and depth 64; and reports at 2,048
findings with 32 evidence references each. MIME and subtree reads use bounded
readers/work budgets. An exceeded limit creates a blocking finding; it is
never interpreted as a pass.
