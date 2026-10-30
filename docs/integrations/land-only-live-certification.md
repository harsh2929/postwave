# Land-only integrations — live certification runbook

This runbook covers live certification for the native **land-only** integration
pullers across five packages:

| Package | Native providers |
|---|---|
| `support_integrations` | zendesk, intercom, gorgias, freshdesk, help-scout, reamaze, front, crisp, kustomer, drift, livechat, zoho-desk, olark, hubspot-service-hub, salesforce-service-cloud, kayako |
| `subscription_integrations` | recharge, aftership, shipstation, skio, chargebee, loop-subscriptions, seal-subscriptions, appstle, bold-subscriptions |
| `review_integrations` | judge-me, yotpo, okendo, loox, trustpilot, stamped, reviews-io, bazaarvoice, powerreviews |
| `loyalty_integrations` | smile, loyaltylion, rivo, referralcandy, friendbuy (pull); growave, marsello (webhook ingest) |
| `analytics_integrations` | posthog, triplewhale, mixpanel, amplitude (outbound); segment, rudderstack (inbound CDP ingest) |

Each package has a `*_livecert_test.go` harness built on `internal/integrations/livecert`,
mirroring `crm_livecert_test.go`. There are three test layers per package:

1. **EvidenceContract** (`Test<Pkg>LiveCertificationEvidenceContract`) — credential-free;
   runs in normal CI. Proves the completeness validator accepts a full synthetic
   evidence set per provider and rejects one with any required check missing.
2. **ReadPaths** (`Test<Pkg>LiveCertificationReadPaths`) — env-gated; exercises
   each provider's first live page through its **real** `SecretsCredentialResolver`
   (fed an env credential JSON) and appends sanitized evidence rows to a JSONL report.
3. **ReportCompleteness** (`Test<Pkg>LiveCertificationReportCompleteness`) — env-gated;
   asserts the recorded report covers every required check per provider.

## Honesty boundary

Passing the read-path slice certifies the **implemented read path** only. It is a
prerequisite for — not a substitute for — flipping `RuntimeStatus` to
`available` in `catalog.go`. Providers whose promotion also depends on managed
OAuth refresh, provider webhooks, or a scheduled worker must land + re-certify
those before promotion. Providers that are still generic ingest-only certify with
webhook-delivery evidence; Freshchat and Tidio now also require their native
support read-path and signed-webhook evidence before promotion.

## Env var schemes

Per package `<PKG>` ∈ { `SUPPORT`, `SUBSCRIPTION`, `REVIEW`, `LOYALTY`, `ANALYTICS` }:

- `<PKG>_LIVE_CERTIFICATION=1` — enable the read-path suite.
- `<PKG>_LIVE_CERTIFICATION_REPORT=/path/to/report.jsonl` — evidence output file.
- `<PKG>_LIVE_CERTIFICATION_VALIDATE_REPORT=1` — enable the completeness gate.
- `<PKG>_LIVE_<PROVIDER>` — the credential JSON for one provider, passed verbatim
  through that provider's real credential resolver. Examples:
  - `SUPPORT_LIVE_ZENDESK='{"subdomain":"acme","email":"ops@acme.com","api_token":"…"}'`
  - `SUBSCRIPTION_LIVE_CHARGEBEE='{"api_key":"…","site":"acme"}'`
  - `REVIEW_LIVE_OKENDO='{"api_key":"…","store_id":"…"}'`
  - `LOYALTY_LIVE_SMILE='{"api_token":"…"}'`
  - `ANALYTICS_LIVE_MIXPANEL='{"username":"…","secret":"…","project_id":"…"}'`
  - Amplitude also needs `ANALYTICS_LIVE_AMPLITUDE_SETTING=<cohort_id>`; PostHog/Mixpanel
    read `project_id` from the credential JSON or `_SETTING`.

(Exact required fields are whatever each provider's `*SecretsCredentialResolver`
+ `BackfillPage` read — see the provider source.)

## Procedure (per package, with real sandbox creds)

```sh
cd apps/api
export SUPPORT_LIVE_CERTIFICATION=1
export SUPPORT_LIVE_CERTIFICATION_REPORT=/tmp/support-cert.jsonl
export SUPPORT_LIVE_ZENDESK='{…}'   # …one per provider being certified
go test ./internal/support_integrations/ -run LiveCertificationReadPaths -v
# then validate the report covers every required check:
export SUPPORT_LIVE_CERTIFICATION_VALIDATE_REPORT=1
go test ./internal/support_integrations/ -run LiveCertificationReportCompleteness -v
```

Manual evidence rows (`manual_disconnect_cleanup`, `manual_reconnect_resume`,
`manual_rate_limit_retry_after`, `manual_credential_rotation`) are witnessed by a
human operator against the real account and appended to the report (same JSONL
shape) before the completeness gate passes.

### Supplemental automated analytics lifecycle proof

`TestAnalyticsFreeLifecycle_DB` can exercise the real analytics repository,
handlers, subscriber sink and provider APIs using disposable tenants in an
explicitly selected, loopback-only `postwave_local_qa_*` database. Enable it with
`ANALYTICS_LIVE_LIFECYCLE=1`, set `ANALYTICS_LIVE_LIFECYCLE_DATABASE_URL`, and
provide the same provider credential variables used by ReadPaths. Set
`ANALYTICS_LIVE_LIFECYCLE_REPORT` to a **separate** evidence file; use a Go subtest
filter to select only providers with accessible free read APIs.

This test records `automated_*` checks for persisted disconnect safety,
checkpoint-preserving reconnect, a controlled Retry-After fault followed by
real-provider recovery, and invalid-authentication rejection followed by
restoring the existing valid credential. It does not revoke or rotate a provider
key, obtain a provider-generated 429, or replace the human-witnessed evidence
above. Its disposable tenants are removed after the test.

For a non-empty profile check, set `<PROVIDER_ENV>_EXPECT_EMAIL`,
`<PROVIDER_ENV>_EXPECT_USER_ID`, `<PROVIDER_ENV>_EXPECT_FIRST_NAME`, and
`<PROVIDER_ENV>_EXPECT_LAST_NAME` (for example, the
`ANALYTICS_LIVE_POSTHOG_*` variables). Use an example-domain fixture with
`qa_fixture: true`. The test verifies the real subscriber row's names, traits,
provider identity and unconfirmed status before recording
`automated_real_profile_mapping`; it then removes the disposable tenant.

For PostHog's optional multi-page proof, set
`ANALYTICS_LIVE_POSTHOG_PAGE_SIZE=1`,
`ANALYTICS_LIVE_POSTHOG_EXPECT_MIN_PAGES=2`, and
`ANALYTICS_LIVE_POSTHOG_EXPECT_PROFILE_COUNT` to the known synthetic profile
count. The run disconnects between pages, resumes the persisted provider cursor,
and verifies completion and unique canonical rows, with a ten-page ceiling.

`TestAmplitudeFreeCSVCanonicalMapping_DB`, enabled by
`ANALYTICS_FREE_CSV_DB=1`, uses the same guarded database URL and separate
lifecycle report. Its fixture is an actual synthetic Free UI export. It records
CSV property/identity mapping and replay/opt-out preservation; it never calls or
certifies Amplitude's paid cohort API. Its disposable tenant is removed.

Analytics ReportCompleteness runs a subtest per provider so one missing evidence
set does not hide the other providers' gaps. Filtering out a deferred provider
does not certify it or satisfy the all-provider gate.

## Promotion

Once a provider's report passes ReportCompleteness (read-path + manual rows) and
any webhook/worker maturity gates are met, flip its `RuntimeStatus` in
`apps/api/internal/integrations/catalog.go` and update the pending allowlist in
`contracts.go`. Until then the providers stay `partial` — native code is shipped
and unit-verified, live certification pending real-account execution.
