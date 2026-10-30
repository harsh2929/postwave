# Mailchimp migration source

Status: migration-only adapter. Self-serve promotion requires the live certification gates below.

The migration source is separate from Moosewave's native Mailchimp integration lifecycle. It performs a bounded source read for a cutover, not a transactionally consistent snapshot; it does not provide Mailchimp writeback, webhook subscription management, or continuous synchronization.

## Authentication and scope

Customer jobs connect through Mailchimp OAuth. Mailchimp does not offer the granular read-scope chooser used by some providers: the token follows the authorizing user's Mailchimp role and remains usable until revoked or the user's access changes. Use a user that can read every intended audience and account-wide archive surface.

After unscoped discovery, the operator must select one or more audience IDs. Scoped discovery previews the selection; dry-run persists the authoritative reviewed scope, and commit must repeat it exactly. A changed or omitted commit scope fails closed and requires a new dry-run. The IDs limit audience-bound members and merge data, groups/interests, saved/static segments, signup-form and audience-schema evidence, list-triggered Classic Automations, campaigns, and reports. Templates, landing pages, and ecommerce evidence are account-wide and carry explicit manual-review labels whenever audiences are selected. Other source-archive guidance is either account-global or a non-detected capability gap and is labeled accordingly.

The encrypted source session must still be present when an action starts. OAuth reconnect refreshes the same migration job; it does not create a replacement job or discard the dry-run scope.

## Runtime coverage

- audience members, source status, tags, interests, merge-field attributes, and available consent provenance;
- unsubscribed and cleaned member states mapped conservatively to the destination suppression/status model, with available complaint/abuse report events preserved in campaign history;
- static segment membership and the supported subset of saved-segment predicates;
- editable templates with source-to-destination ID mapping;
- the supported Classic Automation subset (currently `welcomeSeries` without unrepresentable runtime windows) imported as executable runtime records, paused until template references and behavior are reviewed;
- sent campaign archive and available report details;
- selected-audience signup-form and audience-schema evidence;
- account-wide landing-page and ecommerce evidence as draft, paused, or rebuild-review records where exposed.

Duplicate emails across selected audiences are merged deterministically. Source IDs, tags, stricter status, and custom-field conflicts remain visible in the verification report.

## Explicit limitations

- Mailchimp's Marketing API does not expose a general Customer Journey / Automation Flow list or graph export. The adapter therefore emits one generic, non-detected parity-gap warning; it does not enumerate, count, or archive individual Journeys. Operators must inventory Journeys in Mailchimp and attach rebuild or waiver evidence. Journeys are never presented as executable Moosewave automations. Classic workflow types or runtime send windows without a proven Moosewave equivalent also remain manual-review items.
- Saved-segment predicates are executable only when their referenced data is imported and the resulting query can be validated. Mailchimp-only rating, engagement, date, or ecommerce rules otherwise remain manual rebuild items.
- Mailchimp webhooks, Mandrill, provider-side cleanup, social/ads behavior, and live writeback are outside this migration source.
- A discovery warning means inventory may be incomplete. A zero count with a warning is not proof that the source has no records.

## Throttling and resumability

Mailchimp documents a limit of 10 simultaneously processing connections per
API user. Within one migration-service process, all adapter instances share a
conservative 10-request ceiling keyed by the verified Mailchimp account. A
one-way credential/data-center hash is used only until the root account
identity is known, then the live groups are merged. The in-memory ceiling does
not coordinate separate service replicas, so Mailchimp's HTTP 429 remains the
authoritative deployment-wide backstop. The hosted migration honors
`Retry-After` when present and resumes from durable job state; it does not
promise a per-second quota or a particular jitter algorithm.

Every paginated collection must reach its terminal cursor or fail explicitly with a partial verification report; a repeated or inconsistent page is never treated as complete. Resource progress includes subscribers, segments, automations, paid subscriptions, campaign archive, templates, and source archive.

Mailchimp's documented pagination is offset-based; it is not a transactionally consistent account snapshot. Pause audience membership and configuration changes for the reviewed dry-run and commit window. If the source changes, run and approve a fresh dry-run instead of relying on an earlier report.

## Rollback

Rollback is driven by the tenant-scoped imported-resource ledger. Before mutation, it validates exact after-images and ownership for every tracked resource in the job. A later edit, ownership change, missing proof, or ambiguity stops the whole rollback with a conflict. Records created by the job are then removed in reverse dependency order; pre-existing destination records are restored from recorded before-images. Failed or operator-cancelled commits with tracked partial writes may also be cleaned up inside the rollback window.

The source Mailchimp account, post-migration sends, DNS, and external billing systems are untouched. Append-only consent and audit history is retained with compensating rollback records; rollback restores operational destination state rather than erasing compliance evidence.

## Listmonk tenancy boundary

One shared Listmonk subscriber table cannot represent the same email as two independent tenant-owned subscribers. Shared mode is diagnostic/fail-closed only for this adapter: a live Mailchimp commit is refused unless `LISTMONK_TENANT_MODE=dedicated` and `LISTMONK_DEDICATED_TENANT_ID` exactly matches the authenticated migration tenant ID. This exact-match gate prevents a nominally dedicated process from writing for the wrong tenant.

## Release gates

Before enabling self-serve Mailchimp migration, certify in an isolated destination with real OAuth:

1. shared mode rejects live commit without mutation, while dedicated mode accepts it only when `LISTMONK_DEDICATED_TENANT_ID` exactly matches the authenticated tenant and proves independent same-email coexistence;
2. a pre-existing destination subscriber is updated and then restored by rollback;
3. more than 1,000 members/segments/archive rows and more than 10 Classic Automation emails import without truncation;
4. scoped discovery clearly echoes the chosen audience preview, dry-run persists the authoritative selected audience IDs, commit accepts only that exact reviewed scope, and account-wide templates/landing/ecommerce plus other account-global/non-detected source-archive guidance are labeled before commit;
5. a revoked or otherwise invalid credential fails closed, and reconnecting valid credentials preserves the same job and authenticated account identity;
6. imported subscribers, lists/tags, consent, suppressions, templates, and paused Classic Automation runtime records are visible through normal Moosewave product paths.
7. the source is frozen for the reviewed dry-run/commit window, or a new dry-run is approved after any Mailchimp-side change.
