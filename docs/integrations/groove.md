# Groove Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: Native / partial (`native_runtime_complete_live_certification_pending`)

Groove now has a provider-owned REST runtime rather than only the generic support webhook-ingest fallback. The implementation uses Groove REST v1 for tickets/messages and route-token webhooks for sparse refresh. GraphQL v2 parity remains open.

## Implemented

- Bearer-token authentication from `credentials_ref`.
- REST base URL `https://api.groovehq.com/v1`, overridable by `api_base_url`.
- Paged ticket backfill through `GET /tickets` with `page` and `per_page`.
- Optional ticket filters: `state`, `folder_id`/`folder`, and `customer`.
- Per-ticket message hydration through `GET /tickets/{ticket_number}/messages`.
- Customer email extraction from Groove customer links for canonical support profiles.
- Public webhook route:
  - `POST [historical public callback path redacted]`
- Strict route-token webhook lookup by `mailbox_id` and stored `groove_webhook_id`.
- Sparse webhook refresh by ticket number.
- Durable webhook delivery claiming and replay suppression.
- Scheduled retry cursor support with provider `Retry-After` preservation.

## Settings

Required:

- `mailbox_id`
- `credentials_ref`

Optional:

- `folder_id`
- `state`
- `customer`
- `groove_webhook_id`
- `api_base_url`
- `page_size`
- `message_page_size`

Credential secret JSON:

```json
{
  "access_token": "groove-api-token"
}
```

## Webhook Security

Groove REST webhook docs document `event` and `url`, but do not document a signature header, verification algorithm, delivery ID, retry schedule, or timeout. GraphQL webhook objects expose `signingEnabled`, but the checked official docs did not include verification instructions.

Because of that, the native route requires an operator-generated `groove_webhook_id` route token in the callback URL. Do not expose a bare mailbox-only Groove public webhook route.

## Current Limits

- REST v1 is documented by Groove as legacy/no longer actively developed.
- GraphQL v2 conversations/events parity is not implemented yet.
- Broad historical export-assisted backfill is not implemented; Groove's UI export flow remains operator-managed.
- Managed webhook registration/cleanup is not automated.
- Live organization certification, API-token rotation/revocation proof, duplicate/manual webhook audit, reconnect certification, and data-delete posture remain open.

## Official Docs Checked

- REST overview/auth/endpoints/errors: https://doc.groovehq.com/
- REST tickets: https://doc.groovehq.com/tickets#listing-tickets
- REST messages: https://doc.groovehq.com/messages#listing-all-messages
- REST customers: https://doc.groovehq.com/customers#listing-all-customers
- REST webhooks: https://doc.groovehq.com/webhooks#creating-a-webhook
- GraphQL overview/auth/pagination: https://developer.groovehq.com/graphql/overview/start/
- GraphQL conversations/events: https://developer.groovehq.com/graphql/references/queries/#conversations
- GraphQL webhooks: https://developer.groovehq.com/graphql/references/mutations/#webhookcreate
- Export help: https://help.groovehq.com/help/export-your-groove-conversations
