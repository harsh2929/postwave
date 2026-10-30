# Pipedrive Live Certification

Use this checklist before promoting Pipedrive from `RuntimePartial` to `RuntimeAvailable`.

The local native runtime is complete enough to certify: OAuth install identity, managed refresh, provider-side refresh-token revocation, Pipedrive-originated uninstall callbacks, Persons/Deals/Organizations/Activities backfill, scheduled retry cursors, managed webhook registration/cleanup, and local disconnect cleanup are implemented. The remaining gate is evidence from a real Pipedrive sandbox/company.

## Test Harness

The opt-in Go live tests live in:

```text
apps/api/internal/crm_integrations/pipedrive_live_test.go
```

They are skipped unless `PIPEDRIVE_LIVE_CERTIFICATION=1` is set.

Set `PIPEDRIVE_LIVE_CERTIFICATION_REPORT=/path/to/pipedrive-live-certification.jsonl` on any run to append sanitized pass evidence. Report rows include the provider, check name, timestamp, and non-secret details such as object counts, cursor presence, user/company ID presence, refresh success, revocation success, and webhook subscription counts.

After automated and manual checks are recorded, validate report completeness:

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION_VALIDATE_REPORT=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
go test -count=1 -run 'TestPipedriveLiveCertificationReportCompleteness' ./internal/crm_integrations
```

Read-only API-token certification:

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
PIPEDRIVE_COMPANY_DOMAIN=example \
PIPEDRIVE_API_TOKEN=... \
go test -count=1 -run 'TestPipedriveLiveCertificationBackfillReadPaths' ./internal/crm_integrations
```

Read-only OAuth Bearer certification:

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
PIPEDRIVE_API_BASE_URL=https://example.pipedrive.com \
PIPEDRIVE_ACCESS_TOKEN=... \
go test -count=1 -run 'TestPipedriveLiveCertificationBackfillReadPaths' ./internal/crm_integrations
```

OAuth identity and refresh certification:

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION=1 \
PIPEDRIVE_LIVE_OAUTH=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
PIPEDRIVE_CLIENT_ID=... \
PIPEDRIVE_CLIENT_SECRET=... \
PIPEDRIVE_REFRESH_TOKEN=... \
go test -count=1 -run 'TestPipedriveLiveCertificationOAuthIdentityAndRefresh' ./internal/crm_integrations
```

OAuth revocation certification requires a disposable refresh token. The test intentionally does not revoke `PIPEDRIVE_REFRESH_TOKEN`.

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION=1 \
PIPEDRIVE_LIVE_REVOKE=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
PIPEDRIVE_CLIENT_ID=... \
PIPEDRIVE_CLIENT_SECRET=... \
PIPEDRIVE_LIVE_REVOKE_REFRESH_TOKEN=... \
go test -count=1 -run 'TestPipedriveLiveCertificationOAuthRevocation' ./internal/crm_integrations
```

Managed webhook registration/cleanup certification mutates the Pipedrive sandbox. Use a disposable public test endpoint because cleanup deletes matching Moosewave-owned webhook subscriptions for that endpoint/topics.

```sh
cd apps/api
PIPEDRIVE_LIVE_CERTIFICATION=1 \
PIPEDRIVE_LIVE_WEBHOOKS=1 \
PIPEDRIVE_LIVE_CERTIFICATION_REPORT=../../artifacts/pipedrive-live-certification.jsonl \
PIPEDRIVE_COMPANY_DOMAIN=example \
PIPEDRIVE_API_TOKEN=... \
PIPEDRIVE_WEBHOOK_USERNAME=postwave \
PIPEDRIVE_WEBHOOK_PASSWORD=... \
PIPEDRIVE_LIVE_WEBHOOK_BASE_URL=https://pipedrive-cert.example.com \
go test -count=1 -run 'TestPipedriveLiveCertificationManagedWebhooks' ./internal/crm_integrations
```

## Required Evidence

- Backfill read paths pass for `persons`, `deals`, `organizations`, and `activities` with cursor/page behavior.
- OAuth `/users/me` returns stable `user_id` and `company_id` evidence.
- OAuth refresh returns a new access token and, when Pipedrive rotates it, refresh-token rotation is persisted by the managed runtime in a full app install.
- Disposable refresh-token revocation succeeds through `POST https://oauth.pipedrive.com/oauth/revoke`.
- Managed webhook registration creates or reuses the configured person/deal/organization/activity topics, then cleanup deletes the Moosewave-owned subscriptions.
- A real app uninstall sends the documented Basic-authenticated `DELETE /api/v1/crm/pipedrive/oauth/callback` payload and the local integration transitions away from connected with its managed credential envelope removed.
- Moosewave disconnect deletes managed webhooks before OAuth revocation and local credential deletion.
- Reconnect produces a new managed `crm:pipedrive:*` credential ref and resumes sync from the expected cursor boundary.
- Data-delete/privacy behavior is validated with person/deal/organization/activity evidence and no orphan profiles from identity-free rows.

The completeness verifier requires these automated check names in the JSONL report:

- `api_token_backfill_persons`
- `api_token_backfill_deals`
- `api_token_backfill_organizations`
- `api_token_backfill_activities`
- `oauth_backfill_persons`
- `oauth_backfill_deals`
- `oauth_backfill_organizations`
- `oauth_backfill_activities`
- `oauth_users_me`
- `oauth_refresh`
- `oauth_refresh_token_revocation`
- `managed_webhook_reconcile`
- `managed_webhook_cleanup`
- `manual_webhook_basic_auth_delivery`

It also requires manual evidence rows for the provider behaviors that cannot be safely proven by the opt-in live tests alone:

```json
{"provider":"pipedrive","check":"manual_webhook_basic_auth_delivery","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"Pipedrive delivered a person/deal/organization/activity webhook using the configured Basic Auth credentials and Moosewave accepted only matching credentials"}}
{"provider":"pipedrive","check":"manual_custom_fields_mapping","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"sandbox_company":"example","notes":"custom person/deal fields present in raw evidence and preserved in Moosewave metadata"}}
{"provider":"pipedrive","check":"manual_rate_limit_retry_after","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"429/Retry-After behavior observed or provider quota response reviewed against stored pipedrive_retry cursor behavior"}}
{"provider":"pipedrive","check":"manual_oauth_uninstall_callback","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"Pipedrive sent Basic-authenticated DELETE callback and Moosewave disconnected the matching install"}}
{"provider":"pipedrive","check":"manual_postwave_disconnect_cleanup","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"Moosewave disconnect deleted managed webhooks before revoking the refresh token and deleting local credential envelope"}}
{"provider":"pipedrive","check":"manual_reconnect_resume","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"Reconnect produced a new managed credential ref and sync resumed from expected cursor boundary"}}
{"provider":"pipedrive","check":"manual_data_delete_behavior","status":"passed","recorded_at":"2026-06-19T00:00:00Z","details":{"notes":"person/deal/organization/activity delete evidence produced no orphan profiles from identity-free rows"}}
```

## Promotion Rule

Keep catalog status at `Native / partial` and contract depth at `native_runtime_complete_live_certification_pending` until the completeness verifier passes against a dated sandbox/company evidence report. Only then promote the connector to `RuntimeAvailable`.
