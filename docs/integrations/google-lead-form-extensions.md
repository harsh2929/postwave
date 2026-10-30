# Google Lead Form Extensions Native Integration

Catalog status: `Native / partial` (`native_runtime_complete_live_certification_pending`).

Google Lead Form Extensions has a Moosewave lead-integration control plane,
canonical ingest path, explicit Google Ads API puller, connect-time history
import, scheduled bounded backfill worker, and operator-managed disconnect
cleanup evidence for lead form submissions. Empty `/sync` and `/backfill`
requests, the opt-out `backfill_on_connect` drain, and the background worker can
pull `lead_form_submission_data` through `GoogleAdsService.Search`, then map
standard and custom lead-form fields into canonical Moosewave submissions.

## Runtime Endpoints

- Unified catalog: `GET /api/v1/integrations/catalog`
- Lead integrations: `POST /api/v1/lead-integrations`
- Manual provider pull or canonical ingest: `POST /api/v1/lead-integrations/{id}/sync`
- Manual provider backfill or canonical backfill: `POST /api/v1/lead-integrations/{id}/backfill`
- Lead runs: `GET /api/v1/lead-integrations/{id}/runs`

## Setup

Create a lead integration with:

- `provider=google-lead-form-extensions`
- `customer_id`
- `lead_form_asset_id`
- `credentials_ref`
- Optional `campaign_id`
- Optional `login_customer_id` when the OAuth identity is a manager/MCC account
- Optional `form_name`, `default_tags`, and `list_id`

Public settings must store references only. The credential secret referenced by
`credentials_ref` must include a Google Ads OAuth `access_token` and
`developer_token`; optional secret fields include `login_customer_id`,
`manager_customer_id`, `mcc_customer_id`, `api_base_url`, and `user_agent`.

## Current Sync Behavior

- The puller calls `POST /v24/customers/{customer_id}/googleAds:search`.
- The request uses `Authorization: Bearer`, `developer-token`, and optional
  `login-customer-id` headers.
- The GAQL query selects `lead_form_submission_data.resource_name`, `id`,
  `asset`, `campaign`, `ad_group`, `ad_group_ad`, `gclid`,
  `lead_form_submission_fields`, `custom_lead_form_submission_fields`, and
  `submission_date_time`.
- The query filters to the configured lead form asset and optional campaign,
  orders by `submission_date_time` then `id`, and uses `LIMIT 1000` so the
  result fits the lead sync row cap.
- The cursor stores `submission_date_time` plus `id` as a durable watermark.
- New connections start a bounded connect-time history import by default when a
  Google Lead Forms backfiller is configured. Set `backfill_on_connect=false` in
  integration settings to opt out.
- The scheduled worker scans connected or errored Google Lead Form Extensions
  rows whose last sync is stale, processes up to 10 pages per tick, records
  scheduled lead sync runs, and resumes from the stored cursor.
- Standard fields use Google's `field_type`/`field_value`; custom fields use
  `question_text`/`field_value`.
- Provider `429` and `5xx` responses are surfaced as retry-aware provider
  errors when `Retry-After` is present. Scheduled failures persist
  `google_lead_forms_retry:` cursors with attempt count, next attempt time,
  status, truncated error text, and the underlying watermark.
- Empty manual `/sync` and `/backfill` requests share the scheduled
  `google_lead_forms_retry:` behavior: not-due retries skip Google Ads calls,
  due retries resume the embedded page-token or watermark cursor, provider pull
  failures persist `BACKFILL_FAILED`, and fully failed local writes persist
  `SYNC_FAILED`.
- Disconnected rows reject manual sync/backfill with
  `409 integration_disconnected`; scheduled continuation skips disconnected
  rows before calling Google Ads, and stale run recording cannot revive the
  disconnected local row.
- Disconnect marks the local row disconnected, preserves run history, and
  returns plus persists `provider_cleanup` evidence with the Google Ads customer,
  lead form asset, credential-ref presence, Moosewave shutdown effects, and the
  operator checklist for OAuth token, developer-token, duplicate/manual CRM
  export, lead form asset permission, and data-delete review.
- Google's API export path is the implemented runtime for this slice, so
  Moosewave does not claim provider webhook ownership or provider CRM-export
  destination management for Google Lead Form Extensions.

## Remaining Before `RuntimeAvailable`

- Live-validate against a real Google Ads customer and lead form asset for OAuth
  scopes, developer-token access level, MCC routing, permissions, 60-day export
  limits, quota behavior, reconnect, disconnect, credential rotation, and
  data-delete evidence.
- Provider-side OAuth revocation, developer-token rotation, and duplicate/manual
  CRM export or webhook destination cleanup remain Google Ads-side actions until
  live certification evidence is collected.

## Official References

- Google Ads REST Search and SearchStream: https://developers.google.com/google-ads/api/rest/common/search
- Google Ads API paging: https://developers.google.com/google-ads/api/docs/reporting/paging
- Google Ads REST auth headers: https://developers.google.com/google-ads/api/rest/auth
- Google Ads API `LeadFormSubmissionData`: https://developers.google.com/google-ads/api/fields/v24/lead_form_submission_data
- Google Ads API `LeadFormSubmissionField`: https://developers.google.com/google-ads/api/reference/rpc/v24/LeadFormSubmissionField
- Google Ads API `CustomLeadFormSubmissionField`: https://developers.google.com/google-ads/api/reference/rpc/v24/CustomLeadFormSubmissionField
- Retrieve leads using the Google Ads API: https://support.google.com/google-ads/answer/12080108
