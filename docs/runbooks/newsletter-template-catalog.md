# Newsletter template catalog operations

This runbook covers the tenant import, review, shared-catalog publication,
hosted preview processing, verification, refresh, and takedown paths for the
newsletter inspiration library.

The source artifact is never delivered wholesale to a browser or MCP client.
Moosewave serves compact catalog metadata from the API, sanitized preview images
from Moosewave-controlled object storage/CDN, and one selected record at a time.
External references are inspiration-only. A user must generate or adapt a
reviewed revision before Moosewave will save an editable template or open a
campaign draft.

Each upstream collection is captured, imported, reviewed, refreshed, and
reconciled as a separate provider bundle. Do not append Aura rows to the Really
Good Emails artifact: after publication the API and MCP search layer combine
providers, while provider-scoped manifests prevent one source refresh from
unpublishing another source.

## Measured footprint

### Really Good Emails

The exhaustive inventory refreshed on 2026-07-29 contains 3,194 current
records. The refresh added 64 identities and pruned two checkpoint identities
that were no longer present in the fully paginated source inventory:

| Material                          |                                Measured value |
| --------------------------------- | --------------------------------------------: |
| Complete gzip capture             |                  28,019,693 bytes (26.72 MiB) |
| HTML-free manifest                |                    2,732,692 bytes (2.61 MiB) |
| Validated source HTML before gzip |                220,103,072 bytes (209.91 MiB) |
| Records with retained HTML        |                                         2,923 |
| Screenshot/metadata-only records  |                                           271 |
| Preserved 50-item fixture         |                    4,731,631 bytes (4.51 MiB) |
| Hosted previews                   | Measure after the worker reaches steady state |

The gzip SHA-256 is
`a2fd0f76a28b5739f24dc2514cc4f34d9036fe5537ec49631d7470cd96118384`;
the manifest file SHA-256 is
`3bcff6098bd5d0933ec6d1f6b08864b2698ef6996759f5c758fed8ec791237f9`.

The capture has 3,194 desktop preview candidates and 1,832 mobile candidates.
Import also creates 3,194 card jobs from the desktop candidate, for 8,220
preview-job rows before any platform publication aliases. Do not estimate
storage as `8,220 × source image size`: blob hashes deduplicate identical bytes
and card aliases may reuse a desktop object.

Use these production measurements after a run:

```sql
SELECT status, variant, count(*)
  FROM campaign_template_preview_assets
 GROUP BY status, variant
 ORDER BY variant, status;

SELECT count(*) AS unique_blobs,
       COALESCE(sum(size_bytes), 0) AS stored_bytes
  FROM campaign_template_preview_blobs;

SELECT source_provider,
       CASE WHEN tenant_id IS NULL THEN 'platform' ELSE 'tenant' END AS scope,
       count(*) AS records,
       COALESCE(sum(octet_length(body_html)), 0) AS logical_html_bytes
  FROM campaign_templates
 WHERE source_provider IN ('really_good_emails', 'aura_build')
 GROUP BY source_provider, scope
 ORDER BY source_provider, scope;

SELECT pg_total_relation_size('campaign_templates') AS template_table_bytes,
       pg_total_relation_size('campaign_template_preview_assets')
         AS preview_job_table_bytes,
       pg_total_relation_size('campaign_template_preview_blobs')
         AS preview_blob_table_bytes;
```

Object-store/CDN usage is the hosted blob total plus normal versioning,
replication, cache, and request overhead. The source gzip and manifest are
private operator artifacts; clients do not download them and they should not be
placed on the public preview CDN.

The 220,103,072-byte HTML figure is logical body payload, not a prediction of
PostgreSQL disk usage. A complete tenant import stores that logical payload
once; shared publication copies it into platform rows, so retaining both sets
can represent 440,206,144 logical HTML bytes before row metadata, indexes,
revision/audit data, and PostgreSQL TOAST compression. Record relation-size
baselines before import and publication and compare them afterward.

The 2026-07-30 integrity normalization restored 41 HTML strings that an older
pretty-printer had indented after embedded U+2028/U+2029 characters. All 41
were deterministically recovered to their original recorded content hashes;
catalog identities, order, bodies unrelated to that defect, harvest metadata,
and the 3,194 count remained unchanged.

### Aura

The exhaustive Aura capture refreshed on 2026-08-03 contains every public,
featured HTML and React template record readable through Aura's own public
catalog client. Aura is a web-template source, not an email-template source, so
the capture stores metadata and allowlisted preview URLs only. All 7,863
`body_html`/`body_mjml` values are empty and all records remain non-send-ready.

| Material                                  |             Measured value |
| ----------------------------------------- | -------------------------: |
| Complete gzip capture                     | 2,577,530 bytes (2.46 MiB) |
| HTML-free manifest                        | 6,812,570 bytes (6.50 MiB) |
| Preserved 50-item fixture                 | 298,126 bytes (291.14 KiB) |
| Preserved 50-item manifest                |   45,795 bytes (44.72 KiB) |
| Public featured records                   |                      7,863 |
| HTML / React records                      |                7,759 / 104 |
| Aura default-grid / below-grid records    |              5,376 / 2,487 |
| Free / Aura Pro / creator-paid references |          7,197 / 531 / 135 |
| Allowlisted / legacy-host previews        |                7,863 / 288 |
| Captured source-code bytes                |                          0 |

The exhaustive gzip SHA-256 is
`9b2dc4c66672451a63178fab374fc273c40aa859bbe09b05eda1e5140ce659f4`;
the manifest file SHA-256 is
`261fa38be981422c90a3ef1702cb7c8776e8418b44e7b708df514ae0ea5550f9`.
Published beside the 3,194 RGE references, this yields 11,057 provider-scoped
catalog identities before tenant-owned editable templates.
Aura's default **All** grid applies a 50-view threshold. Moosewave intentionally
retains the additional 2,487 public featured references because this artifact's
declared capture scope is exhaustive; `source_metadata.aura_visibility`
distinguishes them. The recorded 5,304 pulse-eligible count also matches Aura's
Free/Pro counters plus its stricter 1,000-view paid counter.

Aura import queues desktop and card jobs only, for at most 15,726 preview-job
rows before publication aliases. Its 320/800/1600 images are resolution
variants, not evidence of distinct mobile layouts. The 288 legacy-host URLs are
kept as observed provenance, but the worker canonicalizes that exact legacy
host to Aura's working primary storage host before fetching.

## Required identities and configuration

Keep these credentials separate:

- `POSTWAVE_API_TOKEN`: tenant API key with `write:campaigns`; used only by the
  bounded importer.
- `POSTWAVE_CATALOG_DATABASE_URL`: privileged migration/catalog-operator
  database URL; never fall back to the runtime application's `DATABASE_URL`.
- Preview object-store credentials and the public asset base URL required by
  the configured Moosewave blob store.
- `NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL`: the exact HTTPS origin used by web
  preview CSP and hosted preview URLs.
- `VITE_POSTWAVE_ASSETS_BASE_URL`: the same exact origin compiled into the
  desktop client.

The Aura capture normally discovers the browser-visible public anonymous key
from Aura's same-origin application bundle. `AURA_PUBLIC_ANON_KEY` may pin that
same public `anon` project key for an operator run; the CLI rejects tokens for a
different project and authenticated/service roles. Never provide an
authenticated Aura credential to the scraper.

The runtime `postwave_app` role is explicitly unable to execute shared-catalog
publication or unpublication functions.

The hosted-preview worker starts only with durable S3 or R2 asset storage. The
AWS path keeps the bucket private, writes with SSE-KMS, and serves immutable
objects through the configured HTTPS CDN; the R2 path requires an explicit
public delivery origin in production. A local filesystem asset store does not
start this worker.

`personal-use-unreviewed` is an unresolved data marker, not a hosting license.
Import immediately enqueues source preview candidates, so importing into an
environment with the durable preview worker enabled can copy screenshots into
the public asset origin before shared-catalog publication. Obtain the right to
fetch and host those preview assets first, or keep the prototype in an isolated
local/development environment with hosted previews disabled and accept the
metadata-only state. Production sharing and adaptation still require the
separate review and publication gates below.

## 1. Validate the checked-in capture

```sh
gzip -cd scripts/fixtures/rge-newsletter-catalog-full.json.gz \
  | jq -e '
      .harvest.mode == "exhaustive" and
      .harvest.complete == true and
      .harvest.pagination_exhausted == true and
      (.harvest.template_count == .harvest.source_total_at_capture) and
      (.harvest.template_count == 3194) and
      (.harvest.template_count == (.templates | length)) and
      ([.templates[].source_external_id] | unique | length) ==
        (.templates | length)
    '

jq -e '
  .artifact.encoding == "gzip" and
  (.artifact.bytes == 28019693) and
  (.artifact.content_hash ==
    "sha256:a2fd0f76a28b5739f24dc2514cc4f34d9036fe5537ec49631d7470cd96118384") and
  all(.templates[]; ((has("body_html") or has("body_mjml")) | not))
' scripts/fixtures/rge-newsletter-catalog-full.manifest.json

gzip -cd scripts/fixtures/aura-template-catalog-full.json.gz \
  | jq -e '
      .source.provider == "aura_build" and
      .harvest.mode == "exhaustive" and
      .harvest.complete == true and
      .harvest.pagination_exhausted == true and
      .harvest.template_count == 7863 and
      .harvest.source_total_at_capture == 7863 and
      .harvest.source_counts == {"html": 7759, "react": 104} and
      .harvest.previews.allowlisted == 7863 and
      .harvest.source_code_collected == 0 and
      all(.templates[];
        .source_provider == "aura_build" and
        .body_html == "" and
        .body_mjml == "" and
        .adaptation_policy.send_ready == false)
    '

jq -e '
  .source.provider == "aura_build" and
  .artifact.encoding == "gzip" and
  .artifact.bytes == 2577530 and
  .artifact.content_hash ==
    "sha256:9b2dc4c66672451a63178fab374fc273c40aa859bbe09b05eda1e5140ce659f4" and
  (.templates | length) == 7863 and
  all(.templates[]; ((has("body_html") or has("body_mjml")) | not))
' scripts/fixtures/aura-template-catalog-full.manifest.json
```

For a new live capture, compare each manifest to that run's reported source
total; do not carry 3,194 or 7,863 forward as permanent constants. Refresh Aura
with:

```sh
node scripts/aura-template-ingest.mjs --all \
  --out scripts/fixtures/aura-template-catalog-full.json.gz
```

The ingest command publishes a completed capture as one verified bundle. It
first stages both files, verifies the staged artifact against its sidecar,
promotes them with adjacent atomic renames, and verifies the canonical pair
again. The sidecar is therefore the fail-closed guard during the unavoidable
two-file rename window.

## 2. Import into one staging tenant

Apply migrations first, then run the bounded importer against the normal API.
Import the exact reviewed artifact without contacting the source again:

Migration `1833_campaign_template_atomic_reference_refresh` replaces the two
legacy reference-refresh functions with one database-verified, atomic
body/hash writer. It revokes the application role's access to the split
writers so an older API instance fails closed. For a rolling deployment,
drain every pre-1833 API/import worker before applying this migration, then
start only the new binary. The same drain is required before an application
rollback; do not restore the split grants. Confirm the fresh-schema rehearsal
and the concurrent import body/hash test before enabling catalog refresh
traffic.

```sh
export POSTWAVE_API_URL="https://api.example.com"
export POSTWAVE_API_TOKEN="<tenant-scoped write:campaigns token>"

node scripts/rge-newsletter-ingest.mjs \
  --import-catalog scripts/fixtures/rge-newsletter-catalog-full.json.gz \
  --postwave-api-url "$POSTWAVE_API_URL"

node scripts/aura-template-ingest.mjs \
  --import-catalog scripts/fixtures/aura-template-catalog-full.json.gz \
  --postwave-api-url "$POSTWAVE_API_URL"
```

The CLI uses sequential batches of at most 100 items and 7,500,000 encoded
bytes, below the API's 8 MiB limit. It fails if a batch is non-2xx, malformed,
or reports any failed item. Before the first HTTP request, it requires the
adjacent manifest path derived from the artifact name and verifies:

- catalog and manifest schema, provider, completion, and count invariants;
- exhaustive pagination and equality between retained count and captured
  source total;
- unique and exactly linked catalog IDs, slugs, provider/external IDs, and
  per-template content hashes, including recomputing each hash from the stored
  `body_html`; and
- the artifact filename, encoding, byte size, and SHA-256 digest.

A missing, stale, renamed, incomplete, or edited artifact/manifest pair cannot
be imported. Upsert identity is:

```text
tenant_id + source_provider + source_external_id
```

Rerunning the same artifact updates current records instead of duplicating
them. The import remains private and pending; it does not publish anything into
the shared gallery.

Use `--all --resume` only for recovery or deliberate inventory expansion. The
command writes incomplete progress to the deterministic sibling
`rge-newsletter-catalog-full.checkpoint.json.gz`; it never replaces the
canonical artifact or its manifest. Resume prefers that checkpoint and falls
back to the canonical artifact only when the checkpoint is absent. A
successfully staged and verified final bundle removes the checkpoint.

Aura's metadata-only capture is small enough to rerun from the public catalog
and has no resumable checkpoint mode. Its completed artifact still receives the
same atomic bundle/manifest verification before it can be imported.

For a true content refresh of existing identities, capture to a new output path
without `--resume`, then verify, review, and promote that new bundle. Do not
make deployment depend on a live re-scrape.

## 3. Verify before review

Substitute the staging tenant UUID:

```sql
SELECT source_provider,
       count(*) AS imported,
       count(DISTINCT source_external_id) AS unique_sources,
       count(*) FILTER (WHERE template_kind = 'reference') AS references,
       count(*) FILTER (WHERE review_status = 'pending') AS pending
  FROM campaign_templates
 WHERE tenant_id = '<tenant-uuid>'::uuid
   AND source_provider IN ('really_good_emails', 'aura_build')
 GROUP BY source_provider
 ORDER BY source_provider;
```

All four per-provider counts must match the corresponding capture (3,194 RGE;
7,863 Aura for the checked-in bundles) before any bulk review.
Review capture warnings, quarantined active content, missing previews, source
changes, and the rights/adaptation decision outside this command.

For Aura, public visibility, `free`, `aura-pro`, and `creator-paid` are access
metadata, not redistribution licenses. Do not approve shared hosting or an
adaptation solely because the source record or image is publicly readable.
Preserve creator attribution and the canonical Aura URL, review the applicable
rights separately, and never ingest source code exposed for a paid/Pro record.

## 4. Dry-run the privileged publication lane

```sh
export POSTWAVE_CATALOG_DATABASE_URL="<catalog-operator database URL>"

(cd apps/api && go run ./cmd/catalogpublish \
  --tenant "<tenant-uuid>" \
  --provider really_good_emails \
  --inventory-manifest ../../scripts/fixtures/rge-newsletter-catalog-full.manifest.json \
  --expected-count 3194 \
  --actor "catalog-review-2026-07" \
  --note "Reviewed for adaptation-only inspiration; direct source use remains disabled." \
  --dry-run)

(cd apps/api && go run ./cmd/catalogpublish \
  --tenant "<tenant-uuid>" \
  --provider aura_build \
  --inventory-manifest ../../scripts/fixtures/aura-template-catalog-full.manifest.json \
  --expected-count 7863 \
  --actor "aura-catalog-review-2026-08" \
  --note "Reviewed as web-design inspiration requiring an original email-safe rebuild." \
  --dry-run)
```

The command validates the manifest as a complete, HTML-free, provider-matched
inventory, selects exactly those source identities, and refuses missing,
duplicate, unexpected, or count-mismatched rows. Private staging rows that
have disappeared from the source do not count. It also recomputes each staging
row's `body_html` hash and requires both the database declaration and manifest
hash to match before review or publication. The dry run reports how many
current records need adaptation review or publication and lists every active
shared reference absent from the manifest. It does not mutate either set.

## 5. Append review receipts and publish

These flags are intentionally explicit. Run them only after the recorded
review:

```sh
(cd apps/api && go run ./cmd/catalogpublish \
  --tenant "<tenant-uuid>" \
  --provider really_good_emails \
  --inventory-manifest ../../scripts/fixtures/rge-newsletter-catalog-full.manifest.json \
  --expected-count 3194 \
  --actor "catalog-review-2026-07" \
  --note "Reviewed for adaptation-only inspiration; direct source use remains disabled." \
  --approve-adaptation \
  --publish \
  --reconcile-stale)

(cd apps/api && go run ./cmd/catalogpublish \
  --tenant "<tenant-uuid>" \
  --provider aura_build \
  --inventory-manifest ../../scripts/fixtures/aura-template-catalog-full.manifest.json \
  --expected-count 7863 \
  --actor "aura-catalog-review-2026-08" \
  --note "Reviewed as web-design inspiration requiring an original email-safe rebuild." \
  --approve-adaptation \
  --publish \
  --reconcile-stale)
```

Publication copies each approved source into a platform reference, appends a
platform review receipt and publication audit event, and copies or queues
hosted preview aliases. It always forces `reference_direct_use_allowed=false`.
Captured third-party HTML is never made directly sendable. If the dry run
reported stale shared references, publication refuses to proceed unless the
operator explicitly supplies `--reconcile-stale`; reconciliation invokes the
audited privileged unpublish function for those exact platform rows. Stale
private staging imports remain preserved as audit evidence.

## 6. Monitor previews and readiness

Check job state until queued/running work reaches a stable result:

```sql
SELECT variant, status, count(*)
  FROM campaign_template_preview_assets
 GROUP BY variant, status
 ORDER BY variant, status;

SELECT source_provider, variant, last_error, count(*)
  FROM campaign_template_preview_assets
 WHERE status = 'failed'
 GROUP BY source_provider, variant, last_error
 ORDER BY count(*) DESC
 LIMIT 50;
```

Clients fail closed when a hosted asset is unavailable; they do not render the
upstream image URL. A refresh retains the last-known-good hosted blob while a
new fetch is queued.

The canonical renderable preview data is `preview_assets[].url`. Search and
detail records deliberately retain `source_url`, `thumbnail_url`, and source
metadata as provenance, and MCP may return those fields as inert evidence. Web
and desktop accept a preview URL only when it is under their exact configured
Moosewave asset origin; the sole compatibility exception is a legacy
`thumbnail_url` that already passes that same-origin check. Never bind provider
provenance URLs directly to an image, iframe, CSS URL, or prefetch.

The worker accepts only pre-enqueued provider-bound image paths: Really Good
Emails on its exact S3 host and `/emails/` prefix, or Aura on its exact public
Supabase project host and the `preview-images`/`chat-thumbnails` object
prefixes. Aura permits only an optional decimal `t` cache-buster and
canonicalizes its one exact legacy project host; sibling buckets, transform
endpoints, arbitrary subdomains, and cross-provider redirects fail closed. The
worker revalidates redirects and DNS, rejects non-public addresses, caps each
fetch at 10 MiB, accepts only
PNG/JPEG/GIF/WebP, fully decodes and strips non-rendering metadata, hashes the
sanitized bytes, and stores one content-addressed blob. That is the implemented
ingest boundary; production qualification still requires a real object-store
run, reviewed queue outcomes, CDN/header checks, byte measurements, and client
smoke tests.

## 7. Product smoke test

Verify all of the following with a non-operator tenant:

1. Search returns at most 100 compact rows (24 by default), never the entire
   source catalog or body HTML/MJML. It may return upstream provenance fields,
   but the preview renderer uses only a valid Moosewave-hosted
   `preview_assets[].url`.
2. Desktop/mobile preview switching has a useful fallback when a mobile asset
   is absent.
3. A shared reference offers **Adapt**, not direct edit/use.
4. Generate/adapt creates a durable queued design and survives page/app
   restart.
5. Failed generation explains the error and a retry reuses the saved request.
6. Refine adds an immutable revision; stale revision/hash saves return a
   conflict instead of silently saving different output.
7. Saving a reusable template and opening a campaign can happen in either
   order, once each.
8. A campaign is still a draft; no send or schedule happens implicitly.
9. Web, desktop, REST, TypeScript SDK, and MCP expose the same lifecycle.
10. Keyboard-only and screen-reader use covers picker, preview mode, revision
    history, validation issues, retry, save, and campaign handoff.

The local qualification run must use the normal REST/SDK routes and database
worker, not the screenshot demo server. Record evidence that:

- replaying design creation with one idempotency key returns one design;
- refinement produces a new immutable revision and output hash;
- save commits that exact revision/hash to one editable template;
- campaign creation commits the same exact revision/hash to one draft;
- replaying either commit returns the original resource; and
- the resulting campaign remains `draft`.

It is acceptable to use a deterministic local generator stub to test Moosewave's
workflow boundary, but label that result as a workflow qualification. A
production launch still requires the configured model provider and S3/R2/CDN
preview pipeline to pass their own environment checks.

## Refresh

Capture/import is idempotent and provider-scoped. A changed content hash invalidates the source
review grant, so refresh publication requires a current review receipt. The
publication command uses the new manifest as the authoritative current
identity set for that exact provider, updates only missing, stale, or unpublished platform copies,
unpublishes disappeared shared identities only with explicit
`--reconcile-stale`, and appends the corresponding audit events.

Interrupted RGE runs leave only the sibling checkpoint. Do not rename a checkpoint
into place or manufacture a manifest for it: `harvest.complete=false` is
deliberately non-importable. Resume the capture and let the command stage,
verify, and publish the completed artifact/manifest pair.

Aura capture has no checkpoint mode. A bounded, failed, count-drifting, or
partially paginated exhaustive run exits before bundle promotion; rerun it from
the public catalog. Never use an Aura manifest to reconcile RGE identities or
vice versa.

Keep the previous source artifact and manifest until the refresh is verified,
then apply the project retention policy. Never overwrite or delete append-only
review/publication evidence.

## Unpublish and incident containment

For a single shared reference, resolve the exact platform template UUID with a
read-only query, then invoke the privileged function:

```sql
SELECT campaign_template_unpublish_reference(
  '<platform-template-uuid>'::uuid,
  'catalog-incident-operator',
  'Reason and incident/takedown reference'
);
```

Unpublication is immediate at the RLS visibility boundary and append-only in
the publication log. It does not destroy source rows, hosted blobs, review
receipts, or audit evidence. Blob deletion, if later required, is a separate
retention/privacy operation and must identify exact unreferenced blobs first.

For a provider-wide incident, stop scheduled refresh/import work, disable the
preview worker's provider allowlist entry, enumerate exact affected platform
IDs, and run a reviewed bulk unpublish transaction. Do not delete templates or
rewrite review/publication history.
