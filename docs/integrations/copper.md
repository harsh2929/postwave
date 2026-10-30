# Copper Native CRM Integration

Last updated: 2026-07-02

## Runtime Status

Copper is native-partial with the local runtime complete and live provider certification pending. Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `copper:` page cursor checkpoints, canonical CRM people/profile mapping, company primary-contact enrichment, opportunity/project/activity event fanout, route-token person/company/opportunity/project/activity webhook ingest with sparse object hydration, CRM sync/webhook run history, local disconnect stops, scheduled retry continuation via `copper_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Managed webhook registration/cleanup proof, provider credential rotation/reconnect proof, data-delete behavior, duplicate/manual callback audit, and live workspace validation remain open before `RuntimeAvailable` promotion.

## Setup

- `provider`: `copper`
- `settings.account_id`: Copper account identifier.
- `credentials_ref`: vault reference containing Copper API credentials.
- Optional: `page_size`, `pipeline_id`, `sync_companies`, `sync_opportunities`, `sync_projects`, `sync_activities`, `default_tags`, `list_ids`, `webhook_route_token`, `copper_webhook_subscription_id`.

Raw API keys and webhook secrets are not accepted in settings.

## Sync Behavior

Empty `/sync` or `/backfill` calls read Copper people through `/people/search`, using page-number pagination sorted by `date_modified`. After people pages drain, the connector advances into `copper:companies:{page}`, `copper:opportunities:{page}`, `copper:projects:{page}`, and `copper:activities:{page}`. Company pages hydrate `GET /people/{primary_contact_id}` and upsert canonical profiles with company evidence. Opportunity pages emit contact-keyed `crm.deal.*` events from `primary_contact_id` or company primary-contact fallback. Project and activity pages resolve their parent or related resource through person, company, opportunity, or project detail hydration before emitting `crm.project.*` and `crm.activity.*` events. The cursor completes at `copper:complete`.

## Webhooks

Copper `new` and `update` notifications for people, companies, opportunities, projects, and activities can be routed to `/api/public/crm-integrations/copper/webhooks/{webhook_route_token}`. The route token resolves a single active Copper integration before tenant context exists, and `copper_webhook_subscription_id` can be configured to reject callbacks for the wrong Copper subscription. Sparse person IDs are hydrated through `GET /people/{id}` before Moosewave writes canonical CRM profiles. Company callbacks hydrate `GET /companies/{id}` plus the primary contact. Opportunity, project, and activity callbacks hydrate the changed object and resolve the related person before writing CRM automation events. Delete callbacks are durably claimed and acknowledged without profile/event mutation until live data-delete semantics are certified.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence for the Copper account, stops local manual and scheduled pulls, and preserves CRM sync history. Copper API-key rotation/revocation, duplicate/manual webhook cleanup, and workflow cleanup remain Copper console/operator actions until a provider cleanup runtime is certified.

## Validation Checklist

- Connect with `account_id` and `credentials_ref`.
- Run empty sync/backfill and confirm people, company-contact, opportunity-event, project-event, activity-event, run-history, and `copper:` cursor behavior.
- Send Copper person, company, opportunity, project, and activity update callbacks through the route-token endpoint and confirm durable idempotency plus sparse object hydration.
- Confirm advertised scopes, sync objects, and webhook topics include only the implemented non-delete route-token runtime.
- Disconnect and confirm manual pulls and callbacks stop for the disconnected row and `provider_cleanup` evidence is persisted.
