# Customer.io Native Foundation

Status: Native provider-row foundation with delegated migration handoff; not a native Customer.io data plane.

Moosewave exposes `customerio` as a native marketing-provider row while preserving the migration source as `customerio-migration`. The distinction is deliberate:

- the native row owns credential-reference configuration, region/workspace evidence, pause/disconnect state, provider-cleanup guidance, `marketing_sync_runs`, and delegated handoff evidence; and
- the migration adapter performs the read-only, review-gated Customer.io App API import described in [`customerio-migration.md`](./customerio-migration.md).

Neither surface currently claims Track API writeback, Customer.io event ingestion, native webhooks, an incremental profile change feed, provider-side cleanup automation, or live workspace certification.

## Current Native Surface

- Catalog slug: `customerio`
- Migration slug: `customerio-migration`
- Setup API: `/api/v1/marketing-integrations`
- Required setting: `credentials_ref`
- Optional settings: `region`, `workspace_id`, `migration_job_id`, `import_cursor`
- Delegated data plane: `customerio_migration_app_api`

Use a Customer.io **App API key**, not a Track API site ID/key. `region` must identify the US or EU App API origin, and `workspace_id` should match the exact workspace selected by the migration job. The migration service itself validates `/v1/workspaces` and cryptographically binds its session to region plus workspace; the native row is handoff metadata and must not be treated as equivalent authentication proof.

## Delegated Migration Coverage

The delegated adapter can import email-addressable profiles under immutable `cio_id`, frozen segment and subscription-topic membership, reusable Design Studio emails with non-empty exact source HTML, and eligible sent email one-time sends as immutable campaign history. It preserves subscription-center topic and channel-type preferences, campaign/automation actions, API broadcasts, transactional definitions, raw newsletter body/layout plus every variant, no-HTML Design Studio records, topic definitions, ESP suppressions, sender-specific SMS/WhatsApp `/v1/optouts`, object-type metadata, and ecosystem gap checklists as non-executable source evidence.

Important boundaries remain:

- Customer.io profiles can share an email, and profiles without email are valid. Destination email deduplication does not erase the need to reconcile every `cio_id`.
- Global unsubscribe, subscription-center topics, subscription-center channel-type preferences, ESP suppressions, and sender-specific SMS/WhatsApp `/v1/optouts` have different meanings. Email enablement requires global subscribed state, a subscribed/default email channel, and the applicable subscribed/default topic. `/v1/optouts` does not determine email eligibility, and preserved evidence does not itself establish portable consent.
- Dynamic segment predicates are not exposed; enumerated membership is a frozen snapshot.
- Customer.io Campaigns/Automations and API Broadcasts are workflow definitions, not one-time-send history. They require rebuild/test/retirement and are never activated automatically.
- Only sent email `/newsletters` records with at least one explicit `language=""` default and provably composable source HTML become campaign archive. The lowest stable content ID in a multi-default/A-B set is the representative, all variants remain evidence, and the representative choice is warned explicitly. A missing explicit default or invalid language metadata fails closed; translations are never silently selected. Missing/empty layouts use the exact source body with a warning, while a non-empty layout must contain exactly one `{{content}}` slot. This is source composition, not provider rendering: Liquid, CSS preprocessing, assets, and per-recipient rendering are not executed.
- Design Studio HTML is exact source content, not provider-rendered output. Components, Liquid, global styles/assets, transformers, and localized variants require destination validation; no-HTML definitions remain rebuild evidence.
- Customer.io provides no complete incremental change feed for this contract. Every migration delta is a full snapshot.

Native `/sync` and `/backfill` record partial provider-row runs and return `customerio_handoff:` cursor evidence. They do not independently fetch Customer.io profiles or prove migration completion, shadow parity, rollback readiness, or cutover acceptance.

## Disconnect

`DELETE /api/v1/marketing-integrations/{id}` marks the provider row disconnected, rejects further native sync/backfill, preserves run evidence, and stores operator cleanup guidance. It does not revoke the App API key or clean Customer.io state.

Operators remain responsible for:

- rotating or revoking the dedicated App API key after the rollback plan permits it;
- confirming the exact US/EU workspace and removing any obsolete account/service credential access;
- pausing or retiring source automations, broadcasts, transactional triggers, forms, webhooks, and Data Pipelines;
- auditing duplicate source/destination integrations, senders, domains, IP pools, and channel credentials; and
- retaining or exporting required historical reports, objects, relationships, activities, and delivery evidence before source access ends.

## Promotion Blockers

Do not promote this foundation to a native Customer.io integration until all of the following are implemented and certified:

- a managed, secret-resolving App API credential lifecycle with exact US/EU workspace identity and rotation/revocation tests;
- an explicit polling/webhook design that does not pretend Customer.io exposes a complete profile deletion/change feed;
- Track/Pipelines writeback, if desired, with distinct credential types, consent gates, idempotency, and source-of-truth ownership;
- active scheduler execution, durable replay, monitoring, and managed cleanup for provider rows;
- parity across profile, audience, preference, suppression, workflow, object, channel, and ecosystem dependencies; and
- live region/workspace, throttling, reconnect, disconnect, data-delete, rollback, and credential-cleanup certification.
