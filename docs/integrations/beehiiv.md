# beehiiv Native Foundation

Status: Native / partial; live certification pending.

Moosewave exposes `beehiiv` as a native marketing provider row while preserving the migration cutover tile as `beehiiv-migration`. The native row owns API-key credential-reference setup, publication evidence, row-preserving pause/disconnect, provider-cleanup guidance, `marketing_sync_runs`, and `beehiiv_handoff` delegated API v2 cursor evidence.

## Current Surface

- Catalog slug: `beehiiv`
- Migration slug: `beehiiv-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `publication_id`, `account_id`, `migration_job_id`, `import_cursor`
- Delegated data plane: `beehiiv_migration_api_v2_publications`

The migration credential is validated against its Beehiiv workspace and bound to one available publication. A multi-publication workspace requires an explicit publication ID; the current flow has no chooser.

## Delegated Migration Contract

The API v2 adapter requires `identify:read`, `publications:read`, `subscriptions:read`, `newsletter_lists:read`, `segments:read`, `condition_sets:read`, `automations:read`, `posts:read`, and `custom_fields:read`. It imports cursor-paginated subscribers with collision-safe custom fields/tags, newsletter-list membership tags, premium-membership metadata, and stable source IDs. Authoritative subscriber arrays must be present and non-null, with valid/unique custom-field, list, and tag members, so a malformed expansion cannot erase destination state. Custom-field items must include an explicit value; explicit JSON `null` means intentional removal, while omission or a non-null value that conflicts with its documented kind fails closed. Custom-field definitions and newsletter-list definition/subscription history are source-preserved. It retains segment metadata and captures eligible completed memberships as exact frozen tag-backed snapshots; active condition-set metadata is archived with a completion manifest, while unavailable predicates require rebuild. Automation definitions, email inventory, journey history, and statistics are preserved as `rebuild_review` evidence and are never activated; requested automation stats must contain a valid documented journey and/or aggregate-email object, and missing, incomplete, unknown-only, or malformed core statistics fail closed.

Only past sent `email`/`both` posts become campaign archive entries. Post inventories remain lightweight and each applicable post is expanded individually; requested rendering/stat shapes are fail-closed and optional analytics stay presence-aware. Drafts, scheduled posts, web-only posts, premium tiers, referral milestones, polls/responses, and available post-template metadata are source-preserved for review. Publication websites, Boosts, recommendations, and ad-network settings/history remain rebuild items.

Campaign and source-archive identity verification is fail-closed and capped at 1,000,000 tracked rows per traversal so unusually large history inventories cannot exhaust a worker or be certified after silent deduplication.

Beehiiv timestamps and memberships are not portable channel-consent proof. Premium membership metadata does not migrate Stripe billing ownership or objects.

There is no native webhook/source-event bridge. A final full delta re-reads subscribers and only performs same-job deletion reconciliation after cursor integrity, discovery-bound unique-ID/premium totals, and exact list/segment membership counts are proven. Merged source-identity ownership changes require a still-present tracked ID and locked ledger proof. Source automations must be paused/retired and their final journey state captured before tested destination rebuilds are activated.

## Boundaries

Native webhooks, continuous polling, writeback, cleanup automation, publication selection UI, executable segment-rule translation, executable automation translation, tenant-bound Stripe billing migration, portable consent proof, and live publication certification remain future work.

## Promotion Blockers

- Live-certify API-key lifecycle, workspace/publication binding, pagination, optional endpoint permissions, and rate limits.
- Certify the final full-delta deletion reconciliation and rollback behavior against a real publication.
- Add native webhook/source-event support or certified scheduled polling.
- Add active provider-row scheduler execution and cleanup automation.
- Define and certify a tenant-owned, publication-bound billing handoff before enabling paid-subscription migration.
