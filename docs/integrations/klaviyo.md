# Klaviyo Native Integration

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave exposes `klaviyo` as a separate native runtime-complete row so operators can track managed Klaviyo work without changing the migration tile's guarantees. The native row now has a first-party `marketing_integrations` control plane for credential-reference-only setup, managed public-app OAuth install with PKCE, encrypted token storage, token refresh/revoke, row-preserving pause/disconnect, provider-cleanup guidance plus local acknowledgement, durable `marketing_sync_runs`, durable `marketing_webhook_events`, native JSON:API profile/list/segment/source-event pulls, signed Klaviyo system-webhook receipt, managed Klaviyo Webhooks API subscription reconciliation/cleanup for allowlisted credentials, versioned `klaviyo_native:` cursor evidence, scheduled provider-row polling, and no-create integration-writeback for existing-profile property updates, list adds, and custom events. OAuth live certification, Webhooks API live allowlist certification, writeback live certification, provider-side cleanup certification, and live account certification remain open.

The migration-to-live surface remains `klaviyo-migration`; see `docs/integrations/klaviyo-migration.md` for cutover operations.

## Current Surface

- Catalog slug: `klaviyo`
- Badge: `Native`
- Runtime status: `partial`
- Setup surface: `/api/v1/marketing-integrations` (UI entry remains `/integrations`)
- Lifecycle actions: `connect/start`, `oauth/availability`, `oauth/start`, `oauth/callback`, `sync`, `backfill`, `pause`, `disconnect`, `provider-cleanup/acknowledge`
- Native lifecycle API: `/api/v1/marketing-integrations/*`
- Native data-plane runtime: `/api/v1/marketing-integrations/{id}/sync`, `/backfill`, and `/api/public/marketing-integrations/klaviyo/webhooks/{token}`
- Native writeback runtime: `/api/v1/integration-writeback/*` with provider `klaviyo`
- Migration-to-live runtime: `/api/v1/migrations/klaviyo/*`

## Setup

Create a native Klaviyo provider row with a credential reference, or start the managed OAuth install flow.

```http
POST /api/v1/marketing-integrations
```

Required field:

- `provider=klaviyo`
- `credentials_ref`

Optional public settings include `account_id`, `revision`, `profile_cursor`, `source_event_cursor`, `source_event_high_watermark`, `klaviyo_webhook_token`, `klaviyo_webhook_secret_ref`, `klaviyo_webhook_id`, `klaviyo_webhook_topics`, `klaviyo_webhook_endpoint`, `klaviyo_webhook_managed_by_postwave`, and legacy compatibility fields such as `migration_job_id` or `source_event_job_id`. Raw Klaviyo private API keys, access tokens, refresh tokens, client secrets, and webhook secrets are rejected from `settings` and `credentials_ref`.

The native puller resolves the credential reference through the shared secret resolver or the encrypted `marketing_credential_secrets` store, validates `/accounts`, sends `Authorization: Klaviyo-API-Key ...` for private-key refs or `Authorization: Bearer ...` for managed OAuth refs, and pins the Klaviyo API `revision` header to `2026-04-15`.

## Managed OAuth

Klaviyo public-app install is exposed through:

```http
GET /api/v1/marketing-integrations/klaviyo/oauth/availability
GET /api/v1/marketing-integrations/klaviyo/oauth/start
GET /api/v1/marketing-integrations/klaviyo/oauth/callback
```

Configure `KLAVIYO_OAUTH_CLIENT_ID`, `KLAVIYO_OAUTH_CLIENT_SECRET`, and either `KLAVIYO_OAUTH_REDIRECT_URL` or `POSTWAVE_PUBLIC_BASE_URL`. Optional overrides are `KLAVIYO_OAUTH_BASE_URL`, `KLAVIYO_OAUTH_AUTHORIZE_URL`, `KLAVIYO_OAUTH_SUCCESS_REDIRECT`, and `KLAVIYO_OAUTH_SCOPES`.

`/oauth/start` creates a single-use hashed state row with a PKCE verifier, redirects to Klaviyo's authorize endpoint with `code_challenge_method=S256`, and carries optional setup settings such as webhook topic/secret refs. `/oauth/callback` exchanges the authorization code through Klaviyo's token endpoint using HTTP Basic client auth, stores access/refresh tokens in an encrypted `marketing:klaviyo:*` credential envelope, and upserts the native provider row. The resolver refreshes expiring managed OAuth access tokens and persists the refreshed envelope.

## Backfill And Source Events

Native sync/backfill records provider-row run history:

```http
POST /api/v1/marketing-integrations/{id}/sync
POST /api/v1/marketing-integrations/{id}/backfill
GET /api/v1/marketing-integrations/{id}/runs
```

Backfill pulls Klaviyo profiles plus list/segment discovery through the native provider row, records `completed` or `failed` `marketing_sync_runs`, and persists a versioned `klaviyo_native:` cursor with profile cursor and phase evidence. Sync pulls changed-profile source events with source-event cursor and high-watermark evidence. Scheduled Klaviyo worker ticks enumerate stale connected/error rows and continue those native provider-row pulls without requiring a manual request.

## Signed System Webhooks

Klaviyo system-webhook deliveries can now land on the native provider row:

```http
POST /api/public/marketing-integrations/klaviyo/webhooks/{klaviyo_webhook_token}
```

Configure `settings.klaviyo_webhook_token` with an opaque route token and `settings.klaviyo_webhook_secret_ref` with a vault reference containing the Klaviyo webhook `secret_key`. The receiver verifies `Klaviyo-Signature` with HMAC-SHA256 over the raw body followed by `Klaviyo-Timestamp`, enforces timestamp freshness, requires the `Klaviyo-Webhook-Id` header to match `meta.klaviyo_webhook_id`, checks `meta.klaviyo_account_id` against `settings.account_id` when configured, and stores integration-scoped delivery claims in `marketing_webhook_events`.

Accepted deliveries record webhook-mode `marketing_sync_runs` with bounded evidence for topics, event IDs, profile IDs, metric IDs, body SHA-256, provider timestamp, and payload version. Webhook deliveries do not advance the `klaviyo_native:` polling cursor, so scheduled source-event polling can continue independently.

When `klaviyo_webhook_topics` and `klaviyo_webhook_secret_ref` are present, create/reconnect can reconcile a provider-side Klaviyo Webhooks API subscription with `POST/PATCH /api/webhooks`, store `klaviyo_webhook_id`, endpoint, topics, token, and verification evidence, and roll back a newly-created provider webhook if local row persistence fails. Disconnect attempts `DELETE /api/webhooks/{id}` for Moosewave-managed subscriptions and persists managed provider-cleanup evidence before marking the row disconnected.

Klaviyo currently gates the Webhooks API to Advanced KDP customers and app partners. Moosewave now has local create/update/delete automation and unit coverage for the documented API shape, but Webhooks API live allowlist certification, OAuth live certification, and live webhook delivery certification remain open until allowlisted Klaviyo credentials and account evidence are available.

## Native Writeback

Klaviyo writeback uses the existing reverse-ETL surface:

```http
POST /api/v1/integration-writeback/targets
POST /api/v1/integration-writeback/targets/{id}/run
GET /api/v1/integration-writeback/targets/{id}/runs
```

Create a target with `provider=klaviyo`, a vault-backed or managed `marketing:klaviyo:*` `credentials_ref`, `source_list_id` or `source_segment_id`, optional `field_map` / `trait_field_map`, and provider-specific settings:

- `list_id` or `klaviyo_list_id`: add matched Klaviyo profiles to this list with `POST /api/lists/{id}/relationships/profiles`.
- `event_name` or `klaviyo_event_name`: create a custom Klaviyo event for each matched profile with `POST /api/events`.
- `tags_property` or `klaviyo_tags_property`: write Moosewave target tags into a custom Klaviyo profile property.
- `event_properties` or `klaviyo_event_properties`: static custom event properties added to each event payload.
- `revision` / `klaviyo_revision` and `api_base_url` / `klaviyo_api_base_url`: override the default `2026-04-15` revision or API root for tests/live certification.

The adapter resolves the credential ref through the shared secret resolver or managed marketing credential store, sends Klaviyo JSON:API `revision` and `Authorization` headers, finds existing profiles by email through `GET /api/profiles`, updates custom properties through `PATCH /api/profiles/{id}`, optionally adds matched profile IDs to a list, and optionally emits custom events addressed by Klaviyo profile ID. Missing profiles are skipped instead of created, so writeback preserves Moosewave's no-create reverse-ETL contract.

Live Klaviyo account certification still needs to prove profile lookup filters, profile update payloads, list membership behavior, event acceptance, rate-limit/`Retry-After` behavior, and provider-side cleanup posture.

The migration dry-run and commit flow still exists as the separate cutover surface:

```http
POST /api/v1/migrations/klaviyo/dry-run
POST /api/v1/migrations/klaviyo/commit
```

The migration surface can import broader cutover objects:

- Email-addressable profiles using the primary address exposed by stable Get Profiles, with the available primary-address subscription, consent, custom-property, and predictive fields.
- Enumerated list and dynamic-segment membership snapshots as tag-backed destination segments after validated list-level suppressions are excluded. Counts/tags are the send-targetable projection; no separate raw Klaviyo membership count is exposed. Nullable source names use deterministic `Klaviyo list <id>` / `Klaviyo segment <id>` display fallbacks. Dynamic predicates are retained as evidence, not translated into live predicates.
- Renderable HTML templates; structured-only templates become rebuild records.
- Sent email campaigns as immutable campaign-archive evidence. Sent messages must have content definitions or import fails closed. Campaign tag relationships retain provider IDs, not hydrated names/groups. Reporting API metrics and per-recipient activity are not imported. Sent SMS and mobile-push campaign records are non-executable source-archive evidence; draft, scheduled, cancelled, and other non-sent campaigns become rebuild records, with nullable message definitions explicitly marked for content/settings recovery or retirement.
- Flow definitions and graph evidence for manual rebuild review. A nullable flow definition preserves metadata but is not rebuild-complete and requires provider-export recovery or retirement. No Klaviyo flow is activated automatically.
- Forms and discovered rebuild records as source-archive tasks, plus eight unconditional `source_total=1` static checklist rows for commerce, reviews, service, CDP, Multi-Email Profiles, omni-channel, deliverability, and marketplace work. Those checklist rows do not prove source inventory.

The migration adapter pins revision `2026-07-15`. This is intentionally independent of the native puller and writeback revision defaults documented above. Profile inventory and changed-profile polling request `subscriptions,predictive_analytics` and are throttled below that field's stricter 10 requests/second and 150 requests/minute profile-read tier.

Klaviyo reports, SMS identities/consent/runtime, and ecommerce data do not migrate. Stable Get Profiles exposes only a Multi-Email Profile's primary address, so secondary addresses and independent per-address consent/suppression do not import and profile/consent counts do not prove identity/consent parity. The migration preserves one `klaviyo_multi_email_profiles` source-archive/manual-review record; reconcile it through a provider export or retained Klaviyo access and bind the evidence to both consent/suppression and ecosystem-dependency review. Sent SMS or mobile-push campaigns can be retained only as non-executable source-archive evidence, never as campaign-archive rows or destination channel runtime.

Legacy migration-source changed-profile polling is still available for cutover jobs:

```http
POST /api/v1/migrations/sources/klaviyo/source-events
GET /api/v1/migrations/{job_id}/source-events
DELETE /api/v1/migrations/{job_id}/source-events
```

Client helpers expose the migration source-event controls through the
TypeScript SDK (`pw.migrations.startSourceEvents`, `sourceEvents`,
`stopSourceEvents`), Python SDK (`start_source_events`, `source_events`,
`stop_source_events`), web migration helper, and CLI:

```sh
postwave migrate source-events start klaviyo job_123 --interval-seconds 900
postwave migrate source-events status job_123
postwave migrate source-events stop job_123
```

The monitor polls profiles with `filter=greater-than(updated,...)`, `sort=updated`, JSON:API page cursors, and canonical profile upsert events. Each changed-profile event uses `klaviyo:profile:{profile_id}:{updated}` when the provider supplies an `updated` timestamp, and carries bounded payload evidence for `profile_id`, `email`, raw provider `updated`, `event_type=profile_changed`, and the pinned API revision so repeated changes to the same profile do not collapse into one event.

Changed-profile polling does not prove deletions, profiles that lost email addresses, secondary Multi-Email Profile identities, independent per-address consent, or current list/segment membership. It also fails closed before destination writes when a stable profile ID moves from email A to B while the prior source-owned A identity is active; run the full-snapshot/final delta to materialize B and disable A before replay resumes. Freeze source changes and run a final full-snapshot delta, fresh verification/shadow checks, Multi-Email Profile manual reconciliation, and complete flow rebuild/retirement review before cutover. A completed initial import is not Klaviyo cutover certification.

## Disconnect

Disconnecting the native foundation marks the `marketing_integrations` row `disconnected`, rejects further native sync/backfill, stops token-routed webhook resolution for that row, preserves run/webhook/import/source-event audit evidence, and persists provider-cleanup guidance in `settings.provider_cleanup`. When the row carries Moosewave-managed Klaviyo webhook evidence, disconnect calls the Klaviyo Webhooks API delete endpoint first and records deleted/already-absent/skipped cleanup status. When the row uses a managed `marketing:klaviyo:*` OAuth credential, disconnect revokes access/refresh tokens through Klaviyo's revoke endpoint before deleting the local encrypted credential envelope.

```http
DELETE /api/v1/marketing-integrations/{id}
```

After the operator completes Klaviyo-side checklist work, Moosewave can record a local attestation against the persisted cleanup evidence:

```http
POST /api/v1/marketing-integrations/{id}/provider-cleanup/acknowledge
```

Supported `completed_actions` keys are `private_api_key_revoked_or_rotated`, `managed_oauth_revocation_reviewed`, `managed_webhook_cleanup_reviewed`, `manual_or_duplicate_webhooks_audited`, `writeback_targets_or_list_memberships_reviewed`, and `provider_console_cleanup_reviewed_no_action_due`. The endpoint also accepts `notes` and `acknowledged_by`, stores `status=operator_acknowledged`, `acknowledged_at`, optional `completed_actions`, and optional `operator_notes`, and does not call Klaviyo APIs.

Klaviyo private API-key revocation, provider-side writeback cleanup, duplicate/manual integration audits, and live OAuth cleanup evidence remain Klaviyo account/operator actions until provider-side cleanup certification lands.

## Promotion Blockers

- Live-certify OAuth public-app install, token refresh, token revocation, reconnect, and disconnect against a real Klaviyo account.
- Live-certify managed Klaviyo Webhooks API create/update/delete, signed delivery, and cleanup behavior against an allowlisted Klaviyo account.
- Live-certify Klaviyo writeback for existing-profile property updates, list adds, custom events, rate-limit handling, and no-create behavior against a real account.
- Live-certify pagination, API revision behavior, rate limits, `Retry-After`, source-event polling, reconnect, disconnect, and data-delete handling against a real Klaviyo account.

## Official References

- Klaviyo authentication: https://developers.klaviyo.com/en/docs/authenticate_
- Klaviyo OAuth setup: https://developers.klaviyo.com/en/docs/set_up_oauth
- Klaviyo API overview: https://developers.klaviyo.com/en/reference/api_overview
- Klaviyo profiles API: https://developers.klaviyo.com/en/reference/profiles_api_overview
- Klaviyo get profiles: https://developers.klaviyo.com/en/reference/get_profiles
- Klaviyo update profile: https://developers.klaviyo.com/en/reference/update_profile
- Klaviyo add profiles to list: https://developers.klaviyo.com/en/reference/add_profiles_to_list
- Klaviyo create event: https://developers.klaviyo.com/en/reference/create_event
- Klaviyo events API: https://developers.klaviyo.com/en/reference/events_api_overview
- Klaviyo Webhooks API: https://developers.klaviyo.com/en/reference/webhooks_api_overview
- Klaviyo system webhooks: https://developers.klaviyo.com/en/docs/working_with_system_webhooks
