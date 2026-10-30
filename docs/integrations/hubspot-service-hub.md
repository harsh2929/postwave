# HubSpot Service Hub Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-02

## Runtime Status

HubSpot Service Hub remains `Native / partial` in the catalog, but the unified connector contract now reports `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, OAuth/Bearer Tickets REST backfill, optional ticket pipeline filtering, signed app-webhook ticket ingest for scoped and app-level target URLs, sparse ticket refresh, contact association lookup, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `hubspot-service-hub:` after-cursor checkpoints, `hubspot_service_hub_retry:` retry cursors, canonical support ticket/profile/event mapping, support sync run history, and persisted operator-managed `provider_cleanup` readiness evidence on disconnect.

Managed HubSpot Service Hub webhook registration/cleanup, credential rotation proof, reconnect certification, and live portal validation remain open.

## Setup

Create the support integration with:

- `provider`: `hubspot-service-hub`
- `settings.portal_id`: HubSpot portal identifier for ownership and cleanup evidence.
- `credentials_ref`: vault reference containing a bearer token or JSON with `access_token`, `token`, or `api_key`.

Optional settings:

- `api_base_url`: test or regional API host override.
- `page_size`: ticket page size.
- `pipeline_id`: optional HubSpot ticket pipeline filter. Backfill and webhook sparse refresh skip tickets whose `hs_pipeline` does not match.
- `hubspot_service_hub_webhook_secret_ref`: vault reference for the HubSpot app client secret used by v3 webhook signature verification. Production may also provide the app secret through server configuration.
- `hubspot_webhook_id`: optional webhook identifier retained for cleanup evidence.

Raw tokens and webhook secrets are not accepted in public integration settings.

## Sync Behavior

An empty `/sync` or `/backfill` request pulls `GET /crm/v3/objects/tickets` with ticket properties, including `hs_pipeline`, and `associations=contacts`, then resolves associated contact email/name through `GET /crm/v3/objects/contacts/{id}`. When `pipeline_id` is configured, tickets outside that HubSpot pipeline are skipped before landing. Tickets with contact email evidence map to canonical support tickets, profile upserts, and support events. Cursors use `hubspot-service-hub:{after}` and complete at `hubspot-service-hub:complete`.

Scheduled continuation scans stale connected/error rows, runs bounded pages, records scheduled support sync runs, and stores `hubspot_service_hub_retry:` cursors with retry timing, attempt count, status, error evidence, and the embedded HubSpot cursor.

## Webhook Behavior

HubSpot Service Hub app webhooks can route either to `[historical public callback path redacted]` for manually scoped targets or to `[historical public callback path redacted]` for HubSpot app-level target URLs. The app-level route derives the portal from the webhook batch `portalId` before signature verification, then verifies the signature with the resolved row secret before processing. Batches with no portal id or multiple portal ids are rejected. The route resolves the active support row by `portal_id` or compatible portal aliases and, when supplied, an exact `hubspot_service_hub_webhook_id`/`hubspot_webhook_id`/`provider_webhook_id`/`webhook_id` match. Unscoped rows only match unscoped deliveries.

The runtime verifies HubSpot v3 signatures with the app client secret, confirms each event `portalId` matches the route, claims each `eventId` through durable support webhook idempotency, and handles landed-data ticket subscriptions for `ticket.creation` and `ticket.propertyChange`. HubSpot webhook payloads only carry object ids, so the handler refreshes `GET /crm/v3/objects/tickets/{id}?associations=contacts`, then resolves associated contact email/name through `GET /crm/v3/objects/contacts/{id}` before writing canonical support tickets, profiles, and events. When `pipeline_id` is configured, sparse refreshes outside that pipeline are ignored after recording the webhook cursor. `ticket.deletion` callbacks are accepted for signature and replay safety, but they are not advertised as a landed canonical event until support ticket tombstones are implemented.

Provider `Retry-After` values from refresh failures are returned to HubSpot and reused by scheduled retry cursor creation.

## Disconnect And Cleanup

Disconnect marks the local row disconnected, stops manual and scheduled pulls, preserves support run history, and returns plus persists `settings.provider_cleanup` readiness evidence. HubSpot-side OAuth/token rotation or revocation, webhook deletion, duplicate callback audit, and live cleanup proof remain operator-managed.

## Validation Checklist

- Connect with `portal_id` and a vault credential token.
- Run an empty sync and confirm contact association lookup, tickets, profile upserts, event tracking, run history, and a `hubspot-service-hub:` cursor.
- Configure `pipeline_id` and confirm backfill plus sparse webhook refresh skip tickets from other HubSpot pipelines.
- Send signed HubSpot ticket webhooks to both the scoped `{portal_id}` route and the app-level route, and confirm sparse ticket refresh, contact lookup, profile/event writes, run history, portal mismatch rejection, and durable replay suppression.
- Force a transient provider failure and confirm a `hubspot_service_hub_retry:` cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm provider cleanup evidence is saved without raw credential or webhook-secret values.
- Live-certify HubSpot Service Hub ticket paging, webhooks, reconnect, disconnect, credential rotation, and data-delete behavior before promotion.
