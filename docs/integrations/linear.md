# Linear native support integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: native partial (`native_runtime_complete_live_certification_pending`). Moosewave can pull Linear issues and bounded comments through GraphQL, receive signed Linear webhooks, sparse-refresh issues, and record operator-managed cleanup evidence. Live workspace certification remains required before full availability.

## Implemented runtime

- Auth: OAuth/API token from `credentials_ref`, sent as `Authorization: Bearer <token>`.
- Backfill: `POST https://api.linear.app/graphql` querying `issues(first, after, filter, includeArchived, orderBy: updatedAt)`.
- Filtering: optional `team_id`.
- Comment hydration: bounded `issue.comments(first: 25)` embedded in the issue page.
- Customer evidence: requester email is resolved from issue creator, customer needs, issue description, assignee, or `default_email`.
- Webhook ingest: `POST [historical public callback path redacted]`.
- Verification: `Linear-Signature` HMAC-SHA256 over the raw request body, plus `Linear-Timestamp` skew checking when present.
- Idempotency: uses `Linear-Delivery` plus event/issue/body hash fallback.
- Retry: honors provider `Retry-After` and Linear reset headers when available.

## Required settings

- `workspace_id`: Linear workspace/organization identifier used for callback routing.
- `credentials_ref`: Vault reference containing OAuth/API credentials.

## Optional settings

- `team_id`: Team filter for issue pulls.
- `linear_webhook_secret_ref`: Vault reference for Linear webhook signing secret.
- `linear_webhook_id`: Optional webhook id to constrain public callback routing.
- `graphql_url` / `api_base_url`: GraphQL endpoint override for test routing.
- `page_size`: Issues per page, capped at 100.
- `default_email`: Fallback requester email for controlled support queues.

## Remaining certification work

- Managed Linear webhook registration and cleanup.
- Full comment pagination beyond the bounded embedded comment page.
- OAuth/app-actor token refresh certification and app deauthorization cleanup proof.
- App-actor writeback certification for support comments/customer needs.
- Duplicate/manual webhook audit, data-delete posture, reconnect proof, and live workspace certification.

Official docs:

- https://linear.app/developers/graphql
- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/developers/pagination
- https://linear.app/developers/rate-limiting
- https://linear.app/developers/webhooks
- https://linear.app/developers/managing-customers
