# Salesforce Service Cloud Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Last updated: 2026-07-02

## Runtime Status

Salesforce Service Cloud remains `Native / partial` in the catalog, but the unified connector contract now reports `native_runtime_complete_live_certification_pending`. Moosewave owns credential references, shared Salesforce managed OAuth credential envelopes when `crm:salesforce:*` refs are used, proactive and one-shot reactive access-token refresh, empty `/sync` and `/backfill` provider pulls, scheduled continuation, `salesforce-service-cloud:` cursor checkpoints, `salesforce_service_cloud_retry:` retry cursors, canonical Case ticket/profile/event mapping, Case owner/queue routing evidence, optional queue-owner filtering, CaseComment support-message mapping for each fetched Case page, operator-managed CDC/Pub/Sub relay ingest with sparse Case refresh, durable webhook idempotency, support sync run history, and persisted operator-managed cleanup readiness evidence on disconnect.

Managed Salesforce CDC/Pub/Sub subscription provisioning and cleanup, provider-side relay deletion, credential rotation proof beyond shared refresh, reconnect certification, data-delete posture, and live org validation remain open.

## Setup

- `provider`: `salesforce-service-cloud`
- `settings.instance_url`: Salesforce instance URL.
- `credentials_ref`: vault reference containing JSON with `access_token` and `instance_url`, or a managed `crm:salesforce:*` credential ref created by the Salesforce connected-app OAuth flow.
- Optional: `api_version`, `case_record_type_id` to constrain Case SOQL reads, `case_queue_id` to constrain Case reads to a Salesforce Case owner/queue, `salesforce_service_cloud_webhook_secret_ref` for the CDC relay shared secret, `salesforce_service_cloud_webhook_id` for strict relay routing, `default_tags`.

Raw access tokens and webhook secrets are not accepted in integration settings.

## Sync Behavior

Empty `/sync` or `/backfill` calls run a SOQL Case query through `/services/data/{version}/query`, selecting Case fields plus `Contact.Email`, `Contact.Name`, `OwnerId`, and `Owner.Name`. When `case_record_type_id` is configured, the Case query adds a `RecordTypeId` filter. When `case_queue_id` is configured, the Case query adds an `OwnerId` filter so operators can scope pulls to a Salesforce Case queue. Case owner evidence lands on the support ticket as assignee, owner ID/name, and inferred owner type (`queue` for `00G...` IDs, `user` for `005...` IDs). For the returned Case page, Moosewave runs a bounded `CaseComment` SOQL query over the fetched Case IDs and maps comments into canonical support messages with Salesforce Case/CaseComment evidence. The cursor stores Salesforce `nextRecordsUrl` as `salesforce-service-cloud:{path}` and completes at `salesforce-service-cloud:complete`. Cases without a contact email are skipped because canonical support sinks require an email identity.

Scheduled continuation resumes stale connected/error rows, records scheduled support sync runs, and stores retry evidence in `salesforce_service_cloud_retry:` cursors. Salesforce `Retry-After` headers on provider failures are preserved in the retry cursor timing.

Managed `crm:salesforce:*` credential refs share the Salesforce CRM encrypted credential store. When `refresh_token`, `client_id`, `client_secret`, and `expires_at` are present, Service Cloud refreshes the access token before expiry and persists the refreshed token envelope. If Salesforce returns `401` / `INVALID_SESSION_ID` on the Case or CaseComment query, Service Cloud performs one reactive refresh and retries that SOQL call.

## CDC Relay Ingest

Salesforce Change Data Capture and Pub/Sub delivery is operator-managed. A Salesforce subscriber or relay can POST decoded Case CDC envelopes to `[historical public callback path redacted]`, using the Salesforce instance host in `{instance_url}`; Moosewave normalizes that host against the stored `settings.instance_url`. When `webhook_id` is supplied in the query string or relay headers, the route requires an exact `salesforce_service_cloud_webhook_id` match; otherwise only unscoped rows can receive unscoped relay events.

The relay authenticates with `Authorization: Bearer <secret>`, `X-Webhook-Secret`, or `X-Salesforce-Relay-Secret`, resolved from `salesforce_service_cloud_webhook_secret_ref` or compatible webhook secret refs. The handler accepts common CDC envelope shapes with `payload.ChangeEventHeader.recordIds`, claims deliveries durably with the CDC replay/event id, then sparse-refreshes the Case through SOQL before writing canonical support tickets, profiles, messages, and events. Sparse refreshes honor the configured `case_record_type_id` and `case_queue_id`; a Case that no longer exists is marked processed and ignored.

This endpoint does not create, own, or delete Salesforce CDC channels, Platform Events, Pub/Sub subscribers, connected apps, or relay infrastructure.

Reference docs checked for this boundary:

- Salesforce Change Data Capture `ChangeEventHeader` fields: https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_event_fields_header.htm
- Salesforce Change Event message structure: https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_message_structure.htm
- Salesforce Pub/Sub API event durability and replay IDs: https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html
- Salesforce Pub/Sub API gRPC event/payload model: https://developer.salesforce.com/docs/platform/pub-sub-api/guide/grpc-api.html

## Validation Checklist

- Connect with `instance_url` and `credentials_ref`.
- Run empty sync/backfill and confirm support tickets, Case owner/queue evidence, CaseComment support messages, profile upserts, events, run history, and a `salesforce-service-cloud:` cursor.
- Configure `case_queue_id` and confirm the Case SOQL includes the expected `OwnerId` filter.
- Expire a managed `crm:salesforce:*` access token and confirm Service Cloud refreshes it before SOQL; replay an `INVALID_SESSION_ID` response and confirm one retry with the fresh bearer token.
- Send a CDC relay payload with a matching shared secret and confirm `run_mode=webhook`, `salesforce-service-cloud-cdc:` cursor evidence, durable replay suppression, sparse Case refresh, CaseComment messages, and strict relay id routing.
- Simulate a transient provider failure and confirm a retry cursor is stored and later resumes the embedded cursor.
- Disconnect and confirm local pulls stop while operator-managed cleanup evidence is returned and saved without raw credential values.
