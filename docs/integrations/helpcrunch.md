# HelpCrunch Native Support Integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: Native / partial (`native_runtime_complete_live_certification_pending`)

HelpCrunch now has a provider-owned REST runtime rather than only the generic support webhook-ingest fallback. The implementation uses HelpCrunch REST v1 for chats/messages and verifies official HMAC-SHA1 webhook signatures.

## Implemented

- Bearer Public API key authentication from `credentials_ref`.
- REST base URL `https://api.helpcrunch.com/v1`, overridable by `api_base_url`.
- Offset/limit chat backfill through `GET /chats`.
- Optional filters: `application_id`/`widget_id` and `status`.
- Per-chat message hydration through `GET /chats/{chat_id}/messages`.
- Customer email/name mapping to canonical support profiles.
- Public signed webhook routes:
  - `POST [historical public callback path redacted]`
  - `POST [historical public callback path redacted]`
- `X-HelpCrunch-Signature` verification using HMAC-SHA1 over the raw body with the configured signing key.
- Sparse webhook refresh by HelpCrunch chat id.
- Durable webhook delivery claiming using the provider event id/body hash for retry suppression.
- Scheduled retry cursor support with provider `Retry-After` preservation when returned.

## Settings

Required:

- `organization_id`
- `credentials_ref`

Optional:

- `widget_id`
- `application_id`
- `status`
- `sort`
- `order`
- `helpcrunch_webhook_signing_key_ref`
- `helpcrunch_webhook_secret_ref`
- `helpcrunch_webhook_id`
- `webhook_secret_ref`
- `webhook_signature_ref`
- `api_base_url`
- `limit`
- `page_size`
- `message_limit`
- `message_page_size`

Credential secret JSON:

```json
{
  "api_key": "helpcrunch-public-api-key"
}
```

Webhook signing key secret:

```text
helpcrunch-http-webhook-signing-key
```

## Current Limits

- HelpCrunch caps REST list calls at 100 rows and documents a default 120 requests/minute limit.
- Official docs document `429 too_many_requests`, but do not document a `Retry-After` header contract.
- There is no global message list endpoint; broad history requires paging chats and then paging messages per chat.
- Provider-side webhook registration/cleanup remains certified operator-managed unless a future provider API pass proves a managed lifecycle path.
- Live organization certification, high-volume throttling behavior, Public API key rotation/revocation proof, duplicate/manual webhook audit, reconnect certification, and data-delete posture remain open before full availability.

## Official Docs Checked

- API setup/auth/rate limits: https://docs.helpcrunch.com/en/rest-api-v1/api-setup-v1
- Customers: https://docs.helpcrunch.com/en/rest-api-v1/customers-v1
- Chats: https://docs.helpcrunch.com/en/rest-api-v1/chats-v1
- Messages: https://docs.helpcrunch.com/en/rest-api-v1/messages-v1
- Webhook setup: https://docs.helpcrunch.com/en/webhooks/setting-up-webhooks
- Signature verification: https://docs.helpcrunch.com/en/webhooks/how-to-verify-help-crunch-webhook-signatures
