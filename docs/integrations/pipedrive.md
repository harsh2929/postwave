# Pipedrive CRM Native Integration

Status: Native / partial (`native_runtime_complete_live_certification_pending`).

Moosewave currently owns Pipedrive CRM OAuth install/start/callback, `/users/me` install identity capture, encrypted refresh-token storage, automatic access-token refresh for managed OAuth refs, vendor-side refresh-token revocation on disconnect, Basic-authenticated Pipedrive uninstall callbacks, Persons, Deals, Organizations, and Activities import/backfill, scheduled bounded backfill continuation with Retry-After retry cursors, integration-scoped body-checked webhook idempotency, strict webhook route identity checks, row-preserving disconnect evidence, and optional Moosewave-managed person/deal/organization/activity webhooks. The local native runtime is complete; live Pipedrive certification remains open before this connector can be marked fully runtime-available.

## Setup

OAuth install requires:

- `PIPEDRIVE_OAUTH_CLIENT_ID`
- `PIPEDRIVE_OAUTH_CLIENT_SECRET`
- `PIPEDRIVE_OAUTH_REDIRECT_URL`, or `POSTWAVE_PUBLIC_BASE_URL` so Moosewave can derive `/api/v1/crm/pipedrive/oauth/callback`
- Optional `PIPEDRIVE_OAUTH_BASE_URL`, `PIPEDRIVE_OAUTH_SCOPES`, and `PIPEDRIVE_OAUTH_SUCCESS_REDIRECT`

Start the browser install flow from an authenticated admin session:

```text
GET /api/v1/crm/pipedrive/oauth/start?company_domain=example&name=Pipedrive%20example
```

Useful query settings are persisted into the integration state: `company_domain`, `sync_deals`, `sync_organizations`, `sync_activities`, `limit`, deal/organization/activity filters, `pipeline_id`, `default_tags`, `list_ids`, `manage_webhooks`, and `webhook_events`.

On callback, Moosewave exchanges the code at Pipedrive's OAuth token endpoint, reads `GET /api/v1/users/me` to persist Pipedrive `user_id`, `company_id`, company domain, and company/user evidence, stores the OAuth token payload in `crm_credential_secrets` under a managed `crm:pipedrive:*` credential ref, and creates/updates the CRM integration. Managed refs are refreshed and rewritten before provider calls when their access token is near expiry.

Manual credential-reference setup remains supported:

1. Create or use a Pipedrive API token, or provision OAuth token metadata for an app install.
2. Store the token payload in the existing Moosewave credential vault and use only the returned `credentials_ref` in CRM integration settings.
3. Create the CRM integration with:

```json
{
  "provider": "pipedrive",
  "settings": {
    "company_domain": "example",
    "credentials_ref": "cred_pipedrive_api_token",
    "limit": 100,
    "default_tags": "sales,crm",
    "sync_deals": true
  }
}
```

Supported credential secret examples:

```json
{
  "api_token": "pd-api-token",
  "webhook_username": "postwave",
  "webhook_password": "provider-generated-secret"
}
```

```json
{
  "access_token": "oauth-access-token",
  "refresh_token": "oauth-refresh-token",
  "client_id": "pipedrive-client-id",
  "client_secret": "pipedrive-client-secret",
  "api_domain": "https://example.pipedrive.com",
  "expires_at": "2026-06-19T12:00:00Z",
  "webhook_username": "postwave",
  "webhook_password": "provider-generated-secret"
}
```

Optional settings:

- `api_base_url`: overrides the default `https://{company_domain}.pipedrive.com` routing for tests or special routing.
- `limit`: Persons/deals/organizations/activities per API page; defaults to 100 and is capped at 500.
- `sync_deals`: set to `false` to skip Deals.
- `deal_status`, `deal_filter_id`, `deal_updated_since`, `pipeline_id`: optional Deals API filters.
- `sync_organizations`: set to `false` to skip Organizations/account enrichment.
- `organization_filter_id`, `organization_updated_since`: optional Organizations API filters.
- `sync_activities`: set to `false` to skip Activities/task event fanout.
- `activity_filter_id`, `activity_updated_since`, `activity_done`: optional Activities API filters.
- `default_tags`: comma-separated or array of Moosewave tags to stamp onto synced people.
- `list_ids`: optional Moosewave list IDs to stamp onto synced people.
- `manage_webhooks`: set to `true` to register Moosewave-owned person/deal/organization/activity webhooks.
- `webhook_events`: optional comma-separated or array event list; defaults to `create/change/delete` for `person`, `deal`, `organization`, and `activity`.

## Sync And Backfill

Manual sync/backfill can use an empty payload:

```json
{}
```

Moosewave pulls one Pipedrive page per request:

- First `GET /api/v2/persons`.
- Then `GET /api/v2/deals` when Persons are exhausted and `sync_deals` is not false.
- Then `GET /api/v2/organizations` when `sync_organizations` is not false.
- Then `GET /api/v2/activities` when `sync_activities` is not false.
- `api_token` query auth for API-token refs, or `Authorization: Bearer <token>` for OAuth access-token refs.
- `limit` and opaque `cursor` query parameters.
- Durable `pipedrive:` cursor checkpoints across the Persons-to-Deals-to-Organizations-to-Activities boundary.

The scheduled `PipedriveBackfillWorker` enumerates due connected/error integrations, scans a widened candidate window so not-due retry cursors do not starve due work behind them, processes a bounded number of provider pages per tick, records scheduled CRM sync runs, and stores durable `pipedrive_retry:` cursors with attempt count, next attempt time, provider object/cursor, status, and truncated error evidence when provider calls or sync writes fail.

Manual empty `/sync` and `/backfill` requests understand the same `pipedrive_retry:` cursors: not-due retry cursors return the stored cursor without calling Pipedrive, due retry cursors resume the underlying object cursor, provider errors record a failed run with fresh retry metadata, and fully failed local sink writes store a `SYNC_FAILED` retry cursor for the pre-fetch cursor instead of advancing past a page that did not land locally.

Manual and scheduled provider pulls re-check the integration row before provider calls and again before local sink writes. If an operator disconnects the Pipedrive row while a provider page is in flight, Moosewave stops before writing contacts/events or advancing the sync cursor.

Persons are mapped into canonical CRM contacts with `pipedrive://person/{id}` source IDs, normalized email/name/phone/company/lifecycle fields, Pipedrive person metadata, raw person evidence, optional default list IDs, and default `pipedrive` / `pipedrive-person` tags.

Deals are mapped into canonical CRM events with `pipedrive://deal/{id}` source IDs and `crm.deal.created`, `crm.deal.updated`, `crm.deal.open`, `crm.deal.won`, `crm.deal.lost`, or `crm.deal.deleted` event names when the deal payload includes an email-bearing person.

Organizations are used for identity-safe account enrichment. When an organization payload includes an email-bearing person relation, Moosewave updates that subscriber profile with organization/company evidence, raw Pipedrive organization data, organization IDs, deal-count evidence, default list IDs, and `pipedrive-organization` tagging. Organization rows without an email-bearing relation still advance cursor/run history but do not create orphan profiles.

Activities are mapped into canonical CRM events with `pipedrive://activity/{id}` source IDs and `crm.activity.created`, `crm.activity.updated`, `crm.activity.completed`, or `crm.activity.deleted` event names when the activity payload includes an attendee/person email. Activity rows without identity evidence still advance cursor/run history but do not create orphan events.

## Webhooks

When `manage_webhooks=true`, Moosewave reconciles managed Pipedrive webhooks with:

- `GET /api/v1/webhooks`
- `POST /api/v1/webhooks`
- `DELETE /api/v1/webhooks/{id}` on disconnect cleanup

The callback URL is:

```text
https://<postwave-public-host>/api/public/crm-integrations/pipedrive/webhooks
```

Pipedrive general webhooks support Basic Auth rather than an HMAC signature, so Moosewave requires `webhook_username` and `webhook_password` in the credential secret and verifies every delivery with constant-time Basic Auth comparison. After auth, Moosewave resolves only a single connected/active integration for the stored webhook ID and validates payload `meta.company_id`, `meta.user_id`, and `meta.host` against the install metadata when those fields are present. Mismatches fail closed before a delivery claim is written.

Deliveries are claimed in `crm_webhook_events` by `(tenant_id, integration_id, provider, webhook_id)` plus a body hash. A replay of the same delivery body is idempotent, while a reused delivery ID with a different body returns a `409 webhook_body_mismatch`. Webhook sync failures mark the durable claim failed and return `503 webhook_sync_failed` so providers can retry instead of falsely acknowledging a dropped payload.

Currently handled webhook objects:

- Person create/change: maps to canonical contact upsert.
- Person delete: maps to `crm.person.deleted`.
- Deal create/change/delete: maps to canonical deal events when the payload contains a person email.
- Organization create/change: maps to profile/company enrichment when the payload contains a person email.
- Organization delete: maps to `crm.organization.deleted` when the payload contains a person email.
- Activity create/change/delete: maps to canonical activity events when the payload contains attendee/person email.

Disconnect cleanup deletes Moosewave-owned webhook registrations, revokes managed OAuth refresh tokens with `POST https://oauth.pipedrive.com/oauth/revoke`, deletes local managed `crm:pipedrive:*` credential envelopes, and only then marks the local integration row `disconnected` with persisted `provider_cleanup` evidence. If local managed credential deletion fails, the disconnect is not finalized. Cleanup uses stored `pipedrive_webhook_ids` as ownership evidence and falls back to endpoint/topic matches for older rows, so webhook event reconfiguration does not strand previously managed subscriptions. API-token revocation and duplicate/manual webhook cleanup may still require Pipedrive admin action until live certification is complete.

## OAuth Notes

`PipedriveOAuthClient` exchanges authorization codes, refreshes access tokens, and revokes refresh tokens against Pipedrive's OAuth endpoints using Basic client authentication. It also reads `/api/v1/users/me` after OAuth install so Moosewave can identify provider uninstall callbacks by Pipedrive `client_id`, `company_id`, and `user_id`. Runtime credential resolution accepts `access_token`, `refresh_token`, `client_id`, `client_secret`, `expires_at`, `expires_in`, `scope`, and `api_domain` from external credential secrets or Moosewave-managed encrypted `crm:pipedrive:*` refs. If the OAuth callback stores a managed credential but later webhook registration or integration upsert fails, Moosewave rolls back the newly stored `crm:pipedrive:*` secret and any managed webhooks created during that callback attempt.

Pipedrive-originated uninstall callbacks are accepted on:

```text
DELETE /api/v1/crm/pipedrive/oauth/callback
```

The callback must use Pipedrive's documented Basic Auth with the app `client_id` and `client_secret`, and the JSON body must include `client_id`, `company_id`, and `user_id`. Moosewave resolves the install through the narrow `crm_integrations_pipedrive_oauth_uninstall_lookup` RLS policy, fails closed if that route is ambiguous, deletes the managed credential envelope before finalizing local disconnect, and records normal `provider_cleanup` evidence with OAuth revocation marked skipped as `provider_uninstall_callback`.

## Remaining Native Work

- Live certification against a real Pipedrive sandbox/company account for API-token and OAuth auth, refresh-token rotation, pagination, custom fields, rate limits, managed webhooks, reconnect, disconnect cleanup, token revocation, Pipedrive-originated uninstall callback behavior, and data-delete behavior.
- Runbook and opt-in live harness: `docs/integrations/pipedrive-live-certification.md`.

## Official Docs Checked

- Pipedrive API reference: https://developers.pipedrive.com/docs/api/v1
- Persons API: https://developers.pipedrive.com/docs/api/v1/Persons
- Deals API: https://developers.pipedrive.com/docs/api/v1/Deals
- Organizations API: https://developers.pipedrive.com/docs/api/v1/Organizations
- Activities API: https://developers.pipedrive.com/docs/api/v1/Activities
- OAuth API: https://developers.pipedrive.com/docs/api/v1/Oauth
- Getting user data: https://pipedrive.readme.io/docs/marketplace-getting-user-data
- App uninstallation and token revocation: https://pipedrive.readme.io/docs/app-uninstallation
- Scopes: https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations
- Webhooks API: https://developers.pipedrive.com/docs/api/v1/Webhooks
- Webhooks guide: https://pipedrive.readme.io/docs/guide-for-webhooks
