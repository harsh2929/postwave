# Asana Support native integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: native partial (`native_runtime_complete_live_certification_pending`). Moosewave can pull Asana task-based support workflows, hydrate task stories, receive signed Asana webhooks, and record operator-managed cleanup evidence. Live workspace certification remains required before full availability.

## Implemented runtime

- Auth: OAuth/PAT bearer token from `credentials_ref`.
- Backfill: `GET /projects/{project_gid}/tasks` when `project_id` is configured; otherwise `GET /tasks?workspace={workspace_id}`.
- Message hydration: `GET /tasks/{task_gid}/stories`.
- Requester evidence: creator email, email custom fields, task notes, assignee email, or controlled `default_email`.
- Webhook handshake: echoes `X-Hook-Secret` during Asana webhook creation.
- Webhook verification: `X-Hook-Signature` HMAC-SHA256 over the raw request body.
- Webhook ingest: `POST [historical public callback path redacted]`.
- Retry: honors provider `Retry-After` for scheduled retry cursors.

## Required settings

- `workspace_id`: Asana workspace or organization gid.
- `credentials_ref`: Vault reference containing OAuth/PAT credentials.

## Optional settings

- `project_id`: Support project gid. Recommended for predictable support queue scoping.
- `asana_webhook_secret_ref`: Vault reference for the `X-Hook-Signature` secret returned during webhook creation.
- `asana_webhook_id`: Optional webhook id to constrain signed public callback routing.
- `api_base_url`: Test API base URL override.
- `page_size`: Tasks per page, capped at 100.
- `default_email`: Fallback requester email for controlled support projects.

## Remaining certification work

- Managed webhook creation, secret storage, and cleanup.
- Resource Export parity for very large historical loads.
- Workspace task-search pagination strategy and premium search certification.
- Token rotation/revocation proof, duplicate webhook audit, reconnect proof, data-delete posture, and live workspace certification.

Official docs:

- https://developers.asana.com/docs/authentication
- https://developers.asana.com/docs/oauth
- https://developers.asana.com/reference/gettasksforproject
- https://developers.asana.com/reference/getstoriesfortask
- https://developers.asana.com/docs/pagination
- https://developers.asana.com/docs/rate-limits
- https://developers.asana.com/docs/webhooks-guide
