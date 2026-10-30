# ClickUp Support native integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: native partial (`native_runtime_complete_live_certification_pending`). Moosewave can pull ClickUp task-based support workflows, hydrate task comments, receive signed ClickUp webhooks, and record operator-managed cleanup evidence. Live workspace certification remains required before full availability.

## Implemented runtime

- Auth: personal token or OAuth bearer token from `credentials_ref`.
- Backfill: `GET /list/{list_id}/task` when `list_id` is configured; otherwise `GET /team/{workspace_id}/task`.
- Comment hydration: `GET /task/{task_id}/comment`.
- Requester evidence: creator email, email custom fields, task text/description, assignee email, or controlled `default_email`.
- Webhook verification: `X-Signature` HMAC-SHA256 over the raw request body.
- Webhook ingest: `POST [historical public callback path redacted]`.
- Retry: honors `Retry-After` when present and ClickUp `X-RateLimit-Reset` reset timing.

## Required settings

- `workspace_id`: ClickUp workspace/team id.
- `credentials_ref`: Vault reference containing personal token or OAuth credentials.

## Optional settings

- `list_id`: Support list id. Recommended for predictable queue scoping.
- `clickup_webhook_secret_ref`: Vault reference for the webhook signing secret returned by ClickUp webhook creation.
- `clickup_webhook_id`: Optional webhook id to constrain signed public callback routing.
- `api_base_url`: Test API base URL override.
- `order_by`: Optional task ordering field, default `updated`.
- `date_updated_gt`: Optional updated-after epoch milliseconds filter.
- `default_email`: Fallback requester email for controlled support lists.

## Remaining certification work

- Managed webhook registration and cleanup.
- Full task-comment pagination using `start` and `start_id`.
- Hierarchy discovery across Spaces/Folders/Lists for workspace-wide installs.
- OAuth token cleanup proof, duplicate webhook audit, reconnect proof, data-delete posture, and live workspace certification.

Official docs:

- https://developer.clickup.com/docs/authentication
- https://developer.clickup.com/reference/gettasks
- https://developer.clickup.com/reference/getfilteredteamtasks
- https://developer.clickup.com/reference/gettaskcomments
- https://developer.clickup.com/docs/task-comments-pagination
- https://developer.clickup.com/docs/rate-limits
- https://developer.clickup.com/docs/webhooks
- https://developer.clickup.com/docs/webhooksignature
