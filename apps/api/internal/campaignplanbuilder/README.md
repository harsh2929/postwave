# Frozen campaign plan builder

`campaignplanbuilder` is the fail-closed production handoff from an immutable
semantic revision to complete synthetic Campaign Assurance artifacts. It:

1. strict-decodes `Revision.Variants` with the reviewed
   `postwave.reviewed-semantic-variant.v1` adapter;
2. strict-decodes and canonicalizes `Revision.Locales`;
3. enumerates every variant × locale × branch × fixture coordinate through
   `campaigncoverage`;
4. compiles every coordinate through `campaigncompiler` using caller-supplied,
   deterministic synthetic envelope metadata;
5. proves exact scenario coordinates, included-node parity, source identity,
   and reviewed-document hashes; and
6. binds tracking settings, structured policy, compiler/render versions, and
   the deterministic envelope-factory version into a canonical transform
   manifest; and
7. revalidates the preparing plan's exact coverage and transform identities before calling
   `campaignmaterializer`.

Call `Bundle.PlanInput` to create the intervening `preparing` send plan with
the exact compiler, renderer, coverage, fixture, transform, and policy
identities. The envelope factory is resolved twice per scenario and must return
identical RFC metadata; recipient addresses are restricted to RFC 2606
example/test domains.

The only accepted non-control variant entry is:

```json
{
  "adapter_version": "postwave.reviewed-semantic-variant.v1",
  "id": "00000000-0000-4000-8000-000000000010",
  "subject": "The effective, already inherited subject",
  "document": {
    "schema_version": 2,
    "language": "en-US",
    "direction": "auto",
    "nodes": []
  }
}
```

The semantic document must already be normalized and valid. Historical
`campaign_variants` rows containing `body_html` or `body_mjml` are rejected;
there is no lossy HTML-to-AST guess. An empty variant array means the base
revision is the single `control` variant, stored with a nullable artifact
`variant_id` while its content-addressed scenario retains the `control`
coverage identity.

This package is synthetic-only. Reusable sections and commerce data still need
a versioned, non-consuming resolver before they can enter this path. Actual
recipient compilation remains a separate runtime integration and must repeat
the same compiler under the frozen plan without retaining recipient MIME by
default.

The current `FreezeCurrent` path still replaces inline variants with legacy
`campaign_variants` rows (`subject`, `body_mjml`, `body_html`) when those rows
exist. Those campaigns therefore block here by design until authoring/freeze
can persist the reviewed semantic variant shape above; this package does not
claim P1.5 is production-complete on the legacy A/B path.
