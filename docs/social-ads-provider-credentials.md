# Social Publishing And Ads Provider Credentials

Date: May 27, 2026

Scope: provider credentials needed for the Mailchimp-parity social publishing, social reports, Google remarketing, and Meta ads surfaces. Do not paste secrets into this file.

## Current Wiring

Moosewave now has a real provider boundary for:

- Facebook Page publishing through Meta Graph API.
- Instagram Business/Creator media publishing through Meta Graph API.
- Meta Ads credential readiness.
- Google Ads OAuth/developer-token validation for remarketing/ad sync.
- Google Ads Customer Match audience destinations through credential references,
  targeted-ads consent gating, and an opt-in Data Manager API upload path.

The app fails closed. If credentials are missing, `/api/mailchimp/3.0/growth/channels` reports the missing variables and live publish requests return a blocked/provider-required state instead of pretending to publish.

## Meta Credentials

Environment variables:

| Variable | Purpose |
| --- | --- |
| `META_GRAPH_BASE_URL` | Defaults to `https://graph.facebook.com`. Override only for tests. |
| `META_GRAPH_VERSION` | Defaults to `v24.0`. Keep current with Meta Graph API releases. |
| `META_PAGE_ID` | Facebook Page ID used for Page publishing. |
| `META_PAGE_ACCESS_TOKEN` | Page access token with Page publishing permissions. |
| `META_INSTAGRAM_BUSINESS_ACCOUNT_ID` | Instagram Business/Creator account connected to the Facebook Page. |
| `META_AD_ACCOUNT_ID` | Meta ad account for future ads buying/report sync. |
| `META_ADS_ACCESS_TOKEN` | Token with Marketing API access for future ads buying/report sync. |

Implemented publish flows:

- Facebook text/link posts use the Page feed endpoint.
- Facebook image posts use the Page photos endpoint with a public image URL.
- Instagram image posts use the two-step media container then `media_publish` flow and require a public media URL.

Operational notes:

- Instagram publishing cannot publish text-only posts. A public image URL is required for the current implementation.
- The code intentionally stores provider IDs and provider status, but never stores the token in campaign metadata.
- Per-tenant OAuth/token storage is now modeled through `social_provider_connections` and exposed through `/api/mailchimp/3.0/provider-connections`. Credentials are envelope-encrypted at rest; campaign/social/ad metadata stores only provider IDs, statuses, and credential references.

Official references:

- Meta Pages API posts: https://developers.facebook.com/docs/pages-api/posts/
- Meta Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing/
- Meta Marketing APIs: https://developers.facebook.com/docs/marketing-apis/

## Google Ads Credentials

Environment variables:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_ADS_API_BASE_URL` | Defaults to `https://googleads.googleapis.com`. Override only for tests. |
| `GOOGLE_ADS_API_VERSION` | Defaults to `v24`. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Required Google Ads API developer token. |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client ID. |
| `GOOGLE_ADS_CLIENT_SECRET` | OAuth client secret. |
| `GOOGLE_ADS_REFRESH_TOKEN` | Refresh token for the authorized Google Ads user. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional manager account ID for MCC access; use digits without hyphens. |
| `GOOGLE_ADS_CUSTOMER_ID` | Target customer account ID for future campaign/audience mutations. |
| `GOOGLE_OAUTH_TOKEN_URL` | Defaults to `https://www.googleapis.com/oauth2/v3/token`. |

Implemented validation flow:

1. Exchange the refresh token for an access token.
2. Call `customers:listAccessibleCustomers`.
3. Send the access token in `Authorization: Bearer ...`.
4. Send `developer-token` on the request.
5. Send `login-customer-id` only when configured.

This validates that the provided credentials can reach Google Ads. Live campaign/ad mutation remains intentionally gated behind the ads mutation worker so we do not accidentally spend money from a compatibility endpoint.

Audience destination note:

- Google Ads Customer Match destination config must store only
  `credential_ref`/`credentials_ref`, `customer_id`, `user_list_id`, consent
  values, transport selection, and terms acknowledgement.
- `customer_match_transport=data_manager` uses a resolved OAuth access token for
  Data Manager `audienceMembers:ingest`; raw tokens and provider host overrides
  are rejected from public destination config.
- Existing eligible Google Ads API Customer Match uploads can still use the
  legacy `OfflineUserDataJobService` shape, but developer-token hydration and
  the full job lifecycle remain gated until live certification.

Official references:

- Google Ads OAuth overview: https://developers.google.com/google-ads/api/docs/oauth/overview
- Google Ads REST authorization headers: https://developers.google.com/google-ads/api/rest/auth
- Google Data Manager Customer Match: https://developers.google.com/data-manager/api/devguides/audiences/google-ads/customer-match
