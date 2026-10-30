# Campaign assurance scenario coverage

`campaigncoverage` freezes the finite set of semantic messages that must pass
Campaign Assurance. It is a pure API-owned domain package: it reads one
immutable `campaignartifact.Revision` plus typed active
`semanticemail.DocumentV2` variants and does not read subscribers, segments,
mailboxes, databases, clocks, randomness, or network services.

## Frozen axes

The enumerator emits one scenario for every:

```text
active variant × canonical locale × generated synthetic fixture
```

Every fixture resolves exactly one conditional branch. That branch is a
separate content-addressed coordinate on the scenario (`branch_key`), so the
manifest records the effective:

```text
variant × locale × reachable branch × fixture
```

matrix without inventing impossible branch/fixture combinations. The
enumerator exhausts the Cartesian product of finite condition-equivalence
classes across the document: missing/present for presence-only slots, and
present-empty/every authored comparison value/a synthetic non-match for
equality slots. This is complete for v2's unary predicates without enumerating
arbitrary strings. Every condition-bearing node also receives an all-true
inclusion proof and a proof for each independently reachable false edge while
its peers remain true. Redundant or impossible edges are recorded as
unreachable; an impossible critical/fact-bearing inclusion branch is a hard
error.

Fact Contract block references, semantic fact/date/money/deadline/offer/
location/product nodes, primary actions, and structured-data source nodes are
treated as fact-bearing. For every active variant and locale, the manifest
must carry a compiled witness that includes each such block. Personalization
slots inside those blocks must have a non-empty synthetic value or an authored
fallback. Failure is returned as a stable, RFC 6901-addressed diagnostic such
as `assurance_branch_uncovered`, `contract_block_missing`, or
`critical_slot_uncovered`; no partial manifest is returned.

## Synthetic fixtures and privacy

The fixture suite is code-owned and version-pinned as
`postwave.campaign-assurance.synthetic-fixtures.v1`. It generates baseline,
missing-optional, Unicode, RTL, long-value, and branch-witness profiles from
slot semantic classes. There is no recipient, subscriber, email-address, phone,
or external-customer field in the input or manifest contracts.

Equality literals must sometimes be copied from authored semantic conditions
to make a branch reachable. The boundary rejects values that resemble
non-reserved email addresses or telephone numbers, controls, invalid UTF-8, or
values above the fixture bound. Reserved example domains remain available for
deliberately synthetic test data. This package must never be adapted by passing
real merge maps into fixtures; dispatch uses real recipient values later under
the frozen plan and retains only the required hashes/provenance.

## Identity and verification

Scenario IDs, fixture IDs, branch keys, and requirement IDs are full SHA-256
content addresses with versioned prefixes. The closed manifest additionally
binds:

- the immutable revision source hash;
- normalized Fact Contract and original revision-variant hashes;
- typed variant document hashes;
- fixture-set, scenario-set, and whole-coverage hashes; and
- one deterministic witness for every reachable proof obligation.

`Manifest.JSON` returns canonical JSON. `DecodeManifest` rejects unknown
fields, trailing or non-canonical JSON, stale hashes, identity collisions,
duplicate axes, incomplete products, cross-variant references, unsafe fixture
values, and mismatched witness coordinates. Persist its bytes directly as
`campaignartifact.PlanInput.CoverageManifest`; use `CoverageHash` as the
coverage identity in assurance receipts.

## Bounds

The v1 behavior is fail-closed at 16 variants, 32 locales, 256 slots, 2,048
conditions, 2,048 fixtures, 4,096 scenarios, 16,384 proof requirements, one
million scenario-node evaluations, 4,096 diagnostics, and a 32 MiB decoded
manifest. These constants are part of the versioned contract. Changing them can
change an accepted scenario set and therefore requires version review.

## Adapter contract

When `Input.Variants` is empty, the revision's semantic node array becomes the
single `control` variant. Otherwise, `Input.Variants` must be the complete
active semantic variant set; the package intentionally does not guess how
legacy `campaign_variants.body_html` or the historical free-form
`campaigns.variants` JSON maps onto a semantic document. The caller must use a
reviewed, non-consuming resolver to produce typed documents and must verify
that set against the frozen `Revision.Variants`. Both the original declaration
hash and typed variant-set hash are recorded so that adapter certification can
detect drift.

Typical usage:

```go
manifest, diagnostics := campaigncoverage.Enumerate(campaigncoverage.Input{
    Revision: frozenRevision,
    Variants: activeTypedVariants,
})
if diagnostics.HasErrors() {
    // Block with ASSURANCE_BRANCH_UNCOVERED or the more specific diagnostic.
}
coverageJSON, err := manifest.JSON()
compilerInputs, err := manifest.CompilationScenarios()
```

The package does not compile MIME or persist plans. Scenario compilation here
uses `semanticemail.CompileV2` only as a non-consuming proof that every frozen
coordinate resolves; the canonical campaign compiler consumes defensive slot
maps from `CompilationScenarios` and binds its artifact hashes to each returned
scenario coordinate.
