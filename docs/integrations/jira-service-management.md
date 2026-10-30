# Jira Service Management native support integration

> [!CAUTION]
> **Release hold (2026-08-25; historical/source-only).** Current credential, creation/ingest-provisioning, sync, backfill, pause, disconnect, provider-cleanup, and run-history effects are held before admin/provider runtime with `support_integration_runtime_held`. Public callback ingress is separately held before handler/body processing with `support_provider_ingress_held`; callback paths are redacted while edge-log account/token secrecy remains unproven. Any mechanics below preserve historical design evidence; they are not current availability or runnable setup guidance. Catalog exploration only; no support runtime request is sent.

Status: native partial (`native_runtime_complete_live_certification_pending`). Moosewave can pull Jira Service Management Cloud requests and request comments, receive route-tokened Jira issue/comment webhook callbacks, and record operator-managed cleanup evidence. Live Atlassian site certification remains required before full availability.

## Implemented runtime

- Auth: OAuth Bearer credentials from `credentials_ref`; API-token Basic auth is accepted for operator/internal installs.
- Base routing: `https://api.atlassian.com/ex/jira/{cloudId}` by default, or `site_url` / `api_base_url` for direct site and test routing.
- Backfill: `GET /rest/servicedeskapi/request` filtered by `service_desk_id`, optional `project_key`, `organization_id`, and `request_status`.
- Message hydration: `GET /rest/servicedeskapi/request/{issueIdOrKey}/comment` with public and internal comments when the token can see them.
- Webhook ingest: `POST [historical public callback path redacted]`.
- Idempotency: uses `X-Atlassian-Webhook-Identifier` plus event/issue/body hash fallback.
- Retry: honors provider `Retry-After` for scheduled backfill retry cursors.

## Required settings

- `site_id`: Atlassian `cloudId`, direct site host, or Moosewave route label.
- `service_desk_id`: Jira Service Management service desk id.
- `credentials_ref`: Vault reference containing OAuth or API-token credentials.

## Optional settings

- `cloud_id`: Explicit Atlassian cloudId alias.
- `site_url`: Direct Jira site URL for API-token or Connect-style routing.
- `project_key`: Restrict imported requests to a project key prefix.
- `organization_id`: JSM organization filter.
- `request_status`: JSM request status filter.
- `jira_service_management_webhook_id`: Route token for public webhook callbacks.
- `api_base_url`: Test or custom Atlassian API base URL.
- `page_size`: Requests per page, capped at 100.
- `default_email`: Fallback email for controlled queues where Jira hides reporter email.

## Remaining certification work

- Certify OAuth dynamic webhook JWT verification and 30-day refresh behavior in a live Atlassian site.
- Add managed webhook registration, refresh, and cleanup using Jira Cloud dynamic webhooks.
- Add enhanced Jira issue-search backfill for full project issue coverage beyond the request-list endpoint.
- Certify token revocation/cleanup proof and duplicate webhook audit steps.

Official docs:

- https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/
- https://developer.atlassian.com/cloud/jira/service-desk/rest/api-group-request/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- https://developer.atlassian.com/cloud/jira/service-desk/oauth-2-authorization-code-grants-3lo-for-apps/
- https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- https://developer.atlassian.com/cloud/jira/platform/webhooks/
