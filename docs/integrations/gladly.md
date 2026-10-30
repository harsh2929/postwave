# Gladly Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: Native / partial (`native_runtime_complete_live_certification_pending`)

Gladly now has a provider-owned local runtime rather than only the generic support webhook-ingest fallback. The implemented slice has credential-reference setup, customer-scoped REST hydration, recent Events polling, authenticated webhook sparse refresh, scheduled retry cursors, durable webhook idempotency, run history, and operator-managed disconnect cleanup evidence. RuntimeAvailable promotion still requires live Gladly organization certification and the provider/operator cleanup proof listed below.

## Implemented

- API-token Basic auth using an API User email plus API token from `credentials_ref`.
- Organization routing through `organization_domain`, for example `acme.gladly.com`; legacy `organization_id` remains accepted as an alias.
- Customer-scoped backfill from configured `customer_id`, `customer_ids`, `gladly_customer_id`, or `gladly_customer_ids`.
- Customer profile hydration through `GET /api/v1/customer-profiles/{customerId}`.
- Conversation discovery through `GET /api/v1/customers/{customerId}/conversations`.
- Message hydration through `GET /api/v1/conversations/{conversationId}/items`, preserving `Gladly-Limited-Data` evidence when Gladly caps results.
- Optional task event mapping through `GET /api/v1/customers/{customerId}/tasks?status=OPEN|CLOSED` when `include_tasks=true`.
- Recent sparse hydration through `GET /api/v1/events` with `startAt`, optional `endAt`, and repeated `entities` query params.
- Public webhook route:
  - `POST [historical public callback path redacted]`
  - `POST [historical public callback path redacted]`
- Webhook authentication via Gladly's documented Basic Authentication or static header-token options.
- Durable webhook delivery claiming and sparse refresh by `conversationId`, `customerId`, or `taskId`.
- Scheduled retry cursor support with provider `Retry-After` preservation.

## Settings

Required:

- `organization_domain`
- `credentials_ref`

Optional:

- `organization_id`
- `customer_id`
- `customer_ids`
- `gladly_customer_id`
- `gladly_customer_ids`
- `gladly_webhook_token_ref`
- `gladly_webhook_secret_ref`
- `webhook_auth_ref`
- `gladly_webhook_id`
- `api_base_url`
- `event_entities`
- `event_window_minutes`
- `start_at`
- `end_at`
- `include_tasks`

Credential secret JSON:

```json
{
  "email": "api-user@example.com",
  "api_token": "gladly-api-token",
  "organization_domain": "acme.gladly.com"
}
```

## Current Limits

- Gladly's public REST API is customer-scoped for conversation history; this runtime does not claim a broad historical organization export.
- The Events API is recent-only and must use a `startAt` within the last 24 hours.
- Conversation item endpoints are capped by Gladly; capped responses are preserved as `gladly_limited_items` evidence.
- Managed webhook registration/cleanup is not yet automated.
- Live organization certification, API-token rotation/revocation proof, duplicate/manual webhook audit, reconnect certification, and data-delete posture remain open.

## Official Docs Checked

- Gladly REST API: https://developer.gladly.com/rest/
- Events API: https://developer.gladly.com/rest/#tag/Events/paths/~1api~1v1~1events/get
- Securing webhooks: https://developer.gladly.com/rest/#section/Securing-Webhooks
- Create webhook: https://developer.gladly.com/rest/#operation/createWebhook
- API tokens and webhooks: https://help.gladly.com/docs/generate-api-tokens-and-create-webhooks
