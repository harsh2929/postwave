# Newsletter template library

Status: the catalog artifact, ingestion path, hosted-preview pipeline,
governance model, discovery API, editable-template lifecycle, durable design
workflow, MCP surfaces, and web/desktop clients are implemented in this
workspace.

This status does **not** prove that any external environment has applied the
migrations, imported the artifact, processed the preview queue, published the
shared catalog, or deployed the current clients. Those are separate,
environment-specific operations with their own evidence.

## Product promise

Moosewave provides a visual newsletter inspiration library without making
third-party source material directly sendable. A person or MCP client can:

1. Search and organize compact catalog records.
2. Open an available Moosewave-hosted desktop or mobile preview, or see an
   explicit metadata-only state.
3. Use a governed reference as inspiration for an original adaptation.
4. Review validation results and immutable generated revisions.
5. Save the exact reviewed revision as an editable Moosewave template, create a
   campaign draft from it, or do both in either order.
6. Safely update, archive, restore, and inspect history for editable templates.

The important distinction is:

- A `reference` is inspiration-only and cannot be edited or sent as if it were
  Moosewave-owned content.
- An `editable` template is Moosewave-authored or the explicit result of the
  durable adaptation/generation workflow. It can be edited through web,
  desktop, REST, SDK, or MCP subject to permissions and concurrency checks.

## Checked-in capture

The repository contains both the deterministic 50-item pilot fixture and the
exhaustive source inventory refreshed on 2026-07-29.

| Material                         |             Verified inventory |
| -------------------------------- | -----------------------------: |
| Exhaustive current records       |                          3,194 |
| Source pages fetched at 50/page  |                             64 |
| Desktop preview candidates       |                          3,194 |
| Mobile preview candidates        |                          1,832 |
| Gzip capture                     |   28,019,693 bytes (26.72 MiB) |
| HTML-free manifest               |     2,732,692 bytes (2.61 MiB) |
| Retained source HTML before gzip | 220,103,072 bytes (209.91 MiB) |
| Records with retained HTML       |                          2,923 |
| Screenshot/metadata-only records |                            271 |
| Preserved 50-item fixture        |     4,731,631 bytes (4.51 MiB) |

The files are:

- `scripts/fixtures/rge-newsletter-catalog.json`
- `scripts/fixtures/rge-newsletter-catalog-full.json.gz`
- `scripts/fixtures/rge-newsletter-catalog-full.manifest.json`

The exhaustive capture is complete relative to the 3,194 unique identities
reported by the source during that run. The refresh added 64 current
identities and pruned two checkpoint identities absent from the final fully
paginated inventory. It does not claim that every identity supplied
reusable HTML: the crawler retains screenshot- and metadata-only fallbacks and
records detail failures and quality warnings. A future refresh must compare
against that run's live total instead of assuming 3,194 remains current.

An integrity normalization on 2026-07-30 restored 41 HTML values affected by a
legacy serializer that inserted indentation after embedded U+2028/U+2029
characters. Every value was deterministically recovered to its original
recorded content hash. The serializer now preserves those characters exactly,
and staging, import, and privileged publication recompute body hashes
fail-closed. The repair preserved all 3,194 identities, their order, harvest
metadata, and unaffected bodies.

The gzip and manifest are operator artifacts. They are not a payload shipped to
a browser, desktop app, or MCP client.

## Delivery and hosting

Clients receive compact catalog metadata from the API and request one selected
record at a time. Full HTML/MJML is omitted from catalog pages.

Preview images are fetched asynchronously by a bounded provider-aware worker,
inspected, content-addressed, and stored in Moosewave-controlled object storage.
The renderable `preview_assets` projection exposes immutable URLs under the
configured Moosewave asset origin. Catalog records can still carry
`source_url`, `thumbnail_url`, and source screenshot metadata as provenance;
web and desktop treat those fields as inert for preview rendering and never
make a provider URL a browser fallback. A legacy thumbnail is renderable only
if it already passes the exact Moosewave asset-origin check.

The preview projection supports `desktop`, `mobile`, and `card` variants:

- A complete private import plans 3,194 desktop, 1,832 mobile, and 3,194 card
  jobs: 8,220 preview-job rows before platform publication aliases.
- Missing mobile art falls back deliberately in the client rather than
  producing a broken image.
- Content hashes deduplicate identical image bytes.
- Card aliases may reuse an existing desktop blob.
- A refresh keeps the last-known-good hosted blob while replacement work is
  pending.
- If an upstream asset disappears, a retained hosted image can be reported as
  `source_missing` without silently returning to the upstream URL.
- Failed or unavailable hosted assets fail closed and produce an explicit
  preview-unavailable state.

The final hosted-preview footprint cannot be inferred from source-candidate
counts. It must be measured after a real worker run because formats,
deduplication, aliases, and failures affect stored bytes. See
`docs/runbooks/newsletter-template-catalog.md` for the production queries and
operational procedure.

The 28,019,693-byte gzip and 2,732,692-byte manifest are private operator
artifacts, not public CDN assets. Import expands the retained logical HTML into
database rows: one complete tenant import represents 220,103,072 logical HTML
bytes, and publishing the same inventory while preserving staging rows can
represent 440,206,144 logical HTML bytes. Actual database storage must be
measured because row metadata, indexes, revisions, audit data, and PostgreSQL
TOAST compression change the physical total.

The hosted-preview worker runs only with durable S3 or R2 storage. It restricts
fetches to the configured provider/host/path, rechecks DNS and redirects,
rejects non-public addresses, enforces a 10 MiB image cap, fully decodes and
sanitizes PNG/JPEG/GIF/WebP, and stores content-addressed immutable blobs.
Implementation in the workspace is not production qualification: a deployed
environment still needs a private bucket/public CDN configuration (or approved
R2 public origin), queue steady-state evidence, stored-byte and egress
measurement, CDN/header validation, and web/desktop origin configuration.

## Governance and publication

Import is tenant-scoped and idempotent on:

```text
tenant_id + source_provider + source_external_id
```

Every external import is server-stamped as:

```text
template_kind = reference
review_status = pending
source_license_status = personal-use-unreviewed
reference_direct_use_allowed = false
```

The importer ignores caller attempts to promote governance state. A pending
reference can be visible for review, but authoritative capabilities prevent
direct edit, clone, use, or campaign creation. Rejected references are excluded
from discovery.

Review decisions are immutable, actor-attributed receipts bound to the source
content hash and recorded license state. A changed source hash invalidates the
previous decision. Review may allow an original adaptation; it does not rewrite
the source license or make captured third-party HTML Moosewave-owned.

Platform publication is a separate privileged lane:

- `apps/api/cmd/catalogpublish` supports explicit dry-run, review, publish, and
  refresh behavior.
- Publication requires the complete HTML-free inventory manifest, selects its
  exact unique provider identities, and refuses partial or mismatched staging
  imports.
- Publication copies approved references into the shared platform catalog,
  appends review/publication audit evidence, and queues or aliases hosted
  previews.
- Published references remain adaptation-only; direct source use is forced
  off.
- The runtime `postwave_app` database role cannot execute publication or
  unpublication functions.
- Unpublication changes visibility immediately but preserves source rows,
  hosted blobs, review receipts, and append-only audit history.
- A refresh reports shared identities absent from the new manifest and refuses
  to publish around them unless the operator explicitly requests audited stale
  reconciliation. Private staging rows remain preserved and are never counted
  as current inventory.

Importing 3,194 current rows into one tenant is therefore not the same as
publishing a 3,194-item shared library.

## Catalog discovery

The canonical search endpoint returns at most 100 compact rows and includes
facets for goals, categories, providers, industries, styles, layouts, and tags.
It supports text, ownership/provider, kind, favorite, featured, active/archive,
and sort filters.

The tag suggestion facet is deliberately bounded to the 100 most prevalent
human-facing tags, ranked by count and then value; system tags are excluded.
This bounds every paginated search response even when source-brand tags are
high-cardinality. It does not restrict filtering: a valid tag remains usable in
search or a saved search even when it is not in the compact suggestion list.

Pagination uses an opaque keyset cursor bound to:

- tenant;
- acting user;
- normalized filters;
- archive state; and
- sort order.

The client must return `next_cursor` unchanged with the same query. A cursor
cannot be replayed across users, tenants, or a changed filter/sort, and a newly
inserted row ahead of the current position does not duplicate an item on the
next page. Numeric `page` remains a deprecated compatibility path.

Additional discovery state is user-private:

- Recents are bounded, newest-first, and upsert one view counter per template.
  A user can clear one item or all history idempotently.
- Compare resolves two to four unique IDs or slugs in requested order and does
  not persist the comparison.
- Named collections retain an exact order for up to 100 template IDs.
  Replacing membership is atomic and an exact retry preserves `updated_at`.
- Saved searches persist filters and sort, not a cursor or page position, so
  running one always starts from a valid current boundary.
- Favorites, recents, collections, and saved searches are scoped to the
  authenticated user and protected by tenant row-level security.

## Editable-template lifecycle

Editable tenant templates have a monotonic `version`, a strong `etag`, and
immutable revision snapshots.

Update, archive, restore, and the deprecated delete alias require the exact
current ETag in `If-Match`:

- Missing, weak, wildcard, or multiple tokens fail with a precondition error.
- A stale ETag fails instead of overwriting another web, desktop, or MCP edit.
- A successful mutation returns a fresh ETag for the next operation.
- Archive is recoverable and makes the item read-only.
- Restore creates another lifecycle revision and makes the template editable
  again.
- The delete compatibility route is a safe archive alias; it does not destroy
  content or revision history.
- External references cannot enter this lifecycle through the ordinary
  authoring endpoints.

The revision list is compact; fetching one version returns its immutable full
snapshot. Historical ETags are evidence, not valid preconditions for mutating
the current representation.

## Durable generate and adapt workflow

The durable workflow replaces the legacy pattern of accepting caller-supplied
generated HTML.

1. Start `generate` from a brief, or `adapt` from one governed source plus up
   to two additional references.
2. The server stores the normalized request and queues a design job.
3. Web, desktop, SDK, and MCP poll the durable design ID. A client can resume
   the same session after refresh or app restart.
4. The worker generates, sanitizes, renders where needed, and records an
   immutable revision with a SHA-256 `output_hash`.
5. Validation reports pass/warn/fail checks for structure, executable content,
   preview text, meaningful image alternatives, link destinations,
   unsubscribe/preferences and compliance footer coverage, color contrast, and
   inbox-clipping risk.
6. Refinement names an exact `base_revision` and creates a new immutable
   revision. It never edits history in place.
7. Save and campaign creation accept only `design_id + revision + output_hash`.
   They do not accept caller HTML.

Every design mutation—create, refine, retry, archive, save, and create
campaign—requires an `Idempotency-Key`. An exact retry returns the prior result
and marks the response with `Idempotent-Replayed: true`; reusing the key for a
different request fails safely.

Save and campaign creation are independent outcomes. A user can save first and
then create a draft, create a draft first and then save, or perform only one.
Each outcome is committed once for the selected revision. Creating a campaign
never sends or schedules it.

Important failure states are explicit:

- A generator outage leaves a recoverable failed job rather than copying
  reference HTML into an editable template.
- A failed job can be retried from its stored request.
- A busy job cannot be refined or archived.
- A stale base revision returns a conflict and requires refresh.
- A mismatched output hash returns a precondition failure.
- A validation or MJML-rendering failure cannot be committed.
- An ambiguous client/network result can be retried with the same idempotency
  key.
- An archived design session cannot be changed.

## Web and desktop experience

Both clients use server-projected capabilities as the authority for which
actions are available.

The web library provides keyboard-navigable Inspiration, My templates, and
Saved tabs; URL-persisted search/filter/sort state; loaded-versus-total
pagination; active/archived views; truthful bulk archive/restore; and explicit
empty, retry, permission, and preview-unavailable states. Reference cards offer
**Make it mine** rather than direct edit/use. Editable-template mutations use
the returned ETag and explain concurrent-edit failures.

The durable web review keeps the selected revision visible, offers
desktop/mobile and light/dark preview, human-readable validation results,
revision comparison and refinement, retry/archive controls, and separate
**Save exact revision as template** and **Create campaign draft** outcomes.
Successful handoffs remain visible so the second outcome is still available.

The desktop Templates surface provides compact paginated browsing,
loaded-versus-total status, safe refresh/reset behavior, hosted preview
fallbacks, favorites and filters, and a detail slideover governed by the same
capabilities. Its durable design wizard persists and resumes jobs, exposes
validation and immutable revision history, supports refinement/retry/archive,
and binds save/campaign actions to the reviewed revision and hash.

Neither client treats a thumbnail as reusable email source, silently promotes
a reference, or starts a send.

## MCP and SDK contract

Moosewave exposes the same product model through both the TypeScript MCP server
and the native API MCP surface. Tool names differ between distributions, so
clients should discover the connected server's tool manifest instead of
hard-coding a tool count.

The implemented MCP capability groups cover:

- compact search, single-item fetch, compare, recents, collections, and saved
  searches;
- create/update plus ETag-bound archive/restore and immutable revision reads
  for editable templates;
- durable generate/adapt, poll, revision history, refine, retry, archive, exact
  save, and exact campaign-draft creation.

MCP can therefore edit an `editable` template. It cannot edit a third-party
`reference` in place. The correct agent flow is:

```text
search → get reference → start adaptation → poll/review/refine
       → save exact revision → get returned editable template + ETag
       → update/archive/restore with that ETag
```

The agent may create a campaign draft directly from the same reviewed design
revision without saving first. Bulk scrape/import and shared-catalog
publication remain operator workflows, not ordinary MCP tools.

Compact MCP search results can include source and thumbnail provenance. Those
URLs are evidence, not permission to fetch or reuse source content and not a
preview fallback. An MCP client should inspect `preview_assets` and server
capabilities, fetch one selected record, and follow the durable adaptation flow
above.

## Import and environment rollout

The exhaustive importer can load a reviewed `.json` or `.json.gz` artifact
with `--import-catalog` without contacting the source again. Before making an
HTTP request, it requires the exact adjacent sidecar and verifies completion,
exhaustive pagination/count invariants, provider and unique identities,
per-template hash linkage, filename, byte size, and artifact SHA-256. It then
streams the gzip artifact and sends sequential batches of no more than 100
records and 7,500,000 encoded bytes, below the API's 8 MiB decoder bound. It
fails on a missing or mismatched sidecar, an incomplete capture, non-2xx
responses, malformed responses, or any reported item failure. A corrected
rerun safely revisits earlier successful batches through the stable import
identity.

Incomplete progress lives in a deterministic sibling checkpoint and never
overwrites the canonical artifact/manifest pair. `--resume` prefers that
checkpoint and falls back to the canonical artifact only when it is absent.
Final publication stages and verifies both files, promotes them together as
closely as the filesystem permits, verifies the canonical bundle again, and
removes the checkpoint. A true refresh of already captured content should be
written to a new output path without `--resume`, then verified and reviewed
before rollout.

An environment is ready only when there is evidence for all applicable steps:

1. Required migrations applied.
2. Artifact hash and exhaustive-count checks passed.
3. Import completed with zero failed items and unique source count matched.
4. Review decisions recorded.
5. Privileged publication completed, if a shared catalog is intended.
6. Hosted preview queue reached a reviewed steady state and stored bytes were
   measured.
7. API, workers, MCP servers, web, and desktop versions deployed together.
8. Search, preview, adapt, resume, refine, exact save, exact campaign creation,
   ETag conflict, archive, restore, permissions, and empty/failure states
   passed smoke testing.

Use `docs/runbooks/newsletter-template-catalog.md` for exact import,
publication, preview monitoring, refresh, and takedown commands.

## Rights and safety boundary

`personal-use-unreviewed` and `pending` are unresolved markers, not permission
to redistribute, publish, sell, or send source material. Technical scanning
does not establish ownership, originality, accessibility, deliverability,
factual accuracy, or legal clearance.

Import enqueues source screenshots immediately, and an enabled durable preview
worker copies them to the configured public asset origin. Therefore the right
to fetch and host preview images must be cleared before importing this
unreviewed catalog into such an environment—not merely before shared
publication. An isolated personal prototype should keep the import private and
the durable hosted-preview worker disabled unless that hosting right is already
established.

Before production sharing or adaptation, also review copy, brands, pixels,
tracking parameters, external links, footer language, unsubscribe and
preferences behavior, accessibility, email-client rendering, and the allowed
derivative-use policy. Keep source refresh, takedown, unpublication, blob
retention, and audit-retention procedures operational after launch.
