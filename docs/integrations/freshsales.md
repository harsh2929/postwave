# Freshsales Native CRM Integration

Last updated: 2026-07-02

## Runtime Status

Freshsales is native-partial (`native_runtime_complete_live_certification_pending`). Moosewave owns credential references, empty `/sync` and `/backfill` provider pulls, `freshsales:` contact page cursor checkpoints, optional `freshsales:accounts:` account-contact enrichment checkpoints, optional `freshsales:deals:` deal-event cursor checkpoints, optional `freshsales:activities:` sales-activity cursor checkpoints, optional `freshsales:tasks:` task cursor checkpoints, route-token workflow webhook contact ingest, sparse contact hydration, canonical CRM contact/profile/account-context/deal/activity/task-event mapping, CRM sync/webhook run history, local disconnect stops, scheduled retry continuation via `freshsales_retry:` cursors, and operator-managed `provider_cleanup` evidence on disconnect.

Managed workflow registration/cleanup, credential rotation proof, reconnect certification, data-delete behavior, and live workspace validation remain open before full availability.

## Setup

- `provider`: `freshsales`
- `settings.account_domain`: Freshsales account domain.
- `settings.view_id`: Freshsales contact view used by the current puller.
- `credentials_ref`: vault reference containing Freshsales API credentials.
- Optional: `api_base_url`, `page_size`, `account_view_id`, `account_page_size`, `deal_view_id`, `sync_sales_activities`, `activity_page_size`, `sync_tasks`, `task_filter`, `task_page_size`, `sales_pipeline_id`, `default_tags`, `list_ids`, `webhook_route_token`.

Raw API keys and webhook secrets are not accepted in settings.

## Sync Behavior

Empty `/sync` or `/backfill` calls read contacts from `/crm/sales/api/contacts/view/{view_id}` with page pagination. The contact cursor advances as `freshsales:{page}`. Contacts without an email are skipped.

When `account_view_id` is configured, the final contact page continues into `/crm/sales/api/sales_accounts/view/{account_view_id}` using `freshsales:accounts:{page}` cursors. Each sales account row is hydrated through `/crm/sales/api/sales_accounts/{id}?include=contacts,owner,territory,business_type`; account contacts without embedded email are hydrated through `/crm/sales/api/contacts/{id}`. Moosewave upserts one canonical contact per associated account contact email with Freshsales account id, account name, website, owner, territory, business type, and raw provider evidence.

When `deal_view_id` is configured, the final contact page continues into `/crm/sales/api/deals/view/{deal_view_id}` using `freshsales:deals:{page}` cursors. Each deal row is hydrated through `/crm/sales/api/deals/{id}?include=contacts,sales_account,deal_stage`, then Moosewave emits one `crm.deal.*` event per associated contact email. Deal events preserve Freshsales deal id, deal name, amount, stage, sales account, close dates, and raw provider payload. If no deal view is configured, the connector completes at `freshsales:complete` after contacts.

When `sync_sales_activities=true`, the connector continues into `/crm/sales/api/sales_activities` using `freshsales:activities:{page}` cursors after contacts and optional accounts/deals finish. Contact-targeted sales activities hydrate `/crm/sales/api/contacts/{id}` from `targetable_id`; deal-targeted sales activities hydrate `/crm/sales/api/deals/{id}?include=contacts,sales_account,deal_stage`; account-targeted sales activities hydrate `/crm/sales/api/sales_accounts/{id}?include=contacts,owner,territory,business_type`. Moosewave fans out one `crm.activity.completed` event per associated contact email and preserves the activity title, type/outcome IDs, owner, targetable evidence, timing fields, raw activity payload, deal context, and account context where available.

When `sync_tasks=true`, the connector continues into `/crm/sales/api/tasks?filter={task_filter}` using `freshsales:tasks:{filter}:{page}` cursors after contacts, optional accounts/deals, and optional sales activities finish. `task_filter` defaults to `open`; Freshsales-supported values include `open`, `completed`, `overdue`, `due_today`, and `due_tomorrow`. Contact-targeted tasks hydrate `/crm/sales/api/contacts/{id}` from the embedded or top-level targetable id; deal-targeted tasks hydrate `/crm/sales/api/deals/{id}?include=contacts,sales_account,deal_stage`; account-targeted tasks hydrate `/crm/sales/api/sales_accounts/{id}?include=contacts,owner,territory,business_type`. Moosewave fans out one `crm.task.updated` event per associated contact email and preserves title, status, due date, owner, targetable evidence, filter evidence, raw task payload, deal context, and account context where available.

## Workflow Webhooks

Freshsales workflow automations can post contact callbacks to `/api/public/crm-integrations/freshsales/webhooks/{webhook_route_token}`. The route token is an opaque Moosewave setting used for tenant routing before tenant context exists. Freshsales workflow payloads are flexible, so Moosewave accepts a direct `contact` object, a top-level contact-shaped payload, or an ID-only contact callback such as `contact_id`.

For direct contact payloads, Moosewave maps the contact immediately. For ID-only or email-less contact payloads, Moosewave resolves the stored Freshsales API credentials and hydrates the record through `/crm/sales/api/contacts/{id}` before upserting the canonical CRM profile. Each callback is claimed in `crm_webhook_events`, body-checked for idempotency, executed as a `webhook` CRM sync run, and marked processed only after the local profile write succeeds.

Non-contact workflow callbacks, contact delete callbacks, and deal/account/activity/task workflow callbacks are durably claimed and acknowledged as ignored for now. They remain explicit buildout work rather than advertised runtime coverage.

## Disconnect

Disconnect returns and persists `provider_cleanup` evidence for the Freshsales account domain, stops local manual and scheduled contact pulls, and preserves CRM sync history. Freshsales API-key rotation/revocation, duplicate/manual webhook cleanup, and workflow cleanup remain Freshsales console/operator actions until a provider cleanup runtime is certified.

## Validation Checklist

- Connect with `account_domain`, `view_id`, and `credentials_ref`.
- Run empty sync/backfill and confirm canonical contacts, run history, and a `freshsales:` cursor.
- Configure `account_view_id`; confirm the final contact page advances into `freshsales:accounts:1` and account contacts enrich canonical profiles with account evidence.
- Configure `deal_view_id`; confirm the final contact page advances into `freshsales:deals:1` and deal contacts create `crm.deal.updated`/`crm.deal.won`/`crm.deal.lost` events.
- Configure `sync_sales_activities=true`; confirm final account/deal/contact pages advance into `freshsales:activities:1` and contact-, deal-, or account-targeted activities create `crm.activity.completed` events.
- Configure `sync_tasks=true`; confirm final activity/account/deal/contact pages advance into `freshsales:tasks:{filter}:1` and contact-, deal-, or account-targeted tasks create `crm.task.updated` events.
- Configure a Freshsales workflow callback with `webhook_route_token`; confirm direct contact and ID-only callbacks create `webhook` sync runs and update canonical contacts.
- Disconnect and confirm manual pulls stop for the disconnected row and `provider_cleanup` evidence is persisted.
