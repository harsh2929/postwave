# @postwave/cli

The official Moosewave command-line interface. Drive migrations, run
deliverability diagnostics, generate voice-trained sequences, manage
subscribers and forms — all from your terminal or a CI pipeline.

## Install

```sh
npm i -g @postwave/cli
```

Verify with `postwave --version`.

## Authenticate

```sh
postwave login
```

This opens your browser, asks you to confirm in the dashboard, and stores
an API key locally at `~/.config/postwave/credentials.json` (mode `0600`).

You can also skip the browser flow entirely:

```sh
postwave login --api-key pw_xxx
# or
export POSTWAVE_API_KEY=pw_xxx
```

Run `postwave whoami` to confirm the active tenant + email, and
`postwave logout` to clear the stored credential.

## Command reference

| Command                                                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postwave login`                                                                  | Browser-based or `--api-key` authentication.                                                                                                                                                                                                                                                                                                                                                  |
| `postwave logout`                                                                 | Remove stored credentials.                                                                                                                                                                                                                                                                                                                                                                    |
| `postwave whoami`                                                                 | Show active tenant + user.                                                                                                                                                                                                                                                                                                                                                                    |
| `postwave init`                                                                   | Interactive new-tenant onboarding.                                                                                                                                                                                                                                                                                                                                                            |
| `postwave migrate <source>`                                                       | Run a migration (supports `--dry-run`, `--commit`, `--rollback`; Beehiiv uses `--source-api-key` plus `--publication-id`; HubSpot uses a private-app `--source-api-key` plus an optional numeric Hub ID in `--source-account-id`; Klaviyo uses an optional `--source-account-id`; Customer.io uses `--source-api-key`, optional numeric `--source-account-id`, and `--source-region us\|eu`). |
| `postwave diagnose <campaign-id>`                                                 | Pretty-printed Diagnostician output.                                                                                                                                                                                                                                                                                                                                                          |
| `postwave sequences {list, generate, regenerate}`                                 | Sequence operations.                                                                                                                                                                                                                                                                                                                                                                          |
| `postwave templates {list, get}`                                                  | Template browsing.                                                                                                                                                                                                                                                                                                                                                                            |
| `postwave subscribers {list, search, suppress}`                                   | Subscriber operations.                                                                                                                                                                                                                                                                                                                                                                        |
| `postwave forms {list, create}`                                                   | Form operations.                                                                                                                                                                                                                                                                                                                                                                              |
| `postwave inbox {report, predict, reputation, auth}`                              | Deliverability suite.                                                                                                                                                                                                                                                                                                                                                                         |
| `postwave assurance {run, get, findings, override, apply, cancel}`                | Run and inspect Predicted Agent Comprehension over an exact frozen campaign plan, record a governed finding decision, or explicitly apply one server-stored deterministic patch as a new revision under an exact strong `If-Match`.                                                                                                                                                           |
| `postwave automation {trigger, pause, resume}`                                    | Automation control.                                                                                                                                                                                                                                                                                                                                                                           |
| `postwave migrate source-events ...`                                              | Start, inspect, or stop incremental source-event polling for migration-to-live jobs such as ActiveCampaign, HubSpot, or Klaviyo. The stop command accepts `--post-pilot-cleanup` only after durable cleanup authorization; for HubSpot, require `source_session_cleared: true` before rollback and external token rotation/revocation.                                                        |
| `postwave integrations catalog`                                                   | Search the unified integrations catalog.                                                                                                                                                                                                                                                                                                                                                      |
| `postwave integrations connections`                                               | Show installed connector state and health.                                                                                                                                                                                                                                                                                                                                                    |
| `postwave integrations {coverage, stacks, readiness}`                             | Measure parity coverage and claim readiness against the integrations plan.                                                                                                                                                                                                                                                                                                                    |
| `postwave integrations recipes`                                                   | Search Zapier, webhook, API, and partner bridge recipes.                                                                                                                                                                                                                                                                                                                                      |
| `postwave integrations {detail, contract, health} <slug>`                         | Inspect setup, ownership, lifecycle, and monitoring details.                                                                                                                                                                                                                                                                                                                                  |
| `postwave integrations {connect-start, sync, backfill, pause, disconnect} <slug>` | Run connector lifecycle actions.                                                                                                                                                                                                                                                                                                                                                              |
| `postwave integrations native ...`                                                | Operate supported native-managed families by concrete connection ID. Support provider discovery and minimized list/detail reads remain available; support lifecycle/run effects fail locally with `support_integration_runtime_held` and send no HTTP request.                                                                                                                                |
| `postwave integrations audiences ...`                                             | Operate first-party Meta, Google Ads, TikTok, LinkedIn, and Snap audience destinations.                                                                                                                                                                                                                                                                                                       |
| `postwave integrations chat ...`                                                  | Operate Slack, Discord, and Teams incoming-webhook notification integrations.                                                                                                                                                                                                                                                                                                                 |
| `postwave sms ...`                                                                | **Source candidate; HOLD / NO-GO for customer traffic.** Names exist for draft/configuration modeling, but dispatch, scheduling, A2P, hosted callbacks/clicks, financial/MMS evidence, auto-replies, and private reports are structurally held. Installed immutable-package parity is not certified.                                                                                          |
| `postwave push suppressions {list, add, remove, bulk-import, bulk-remove}`         | Exact-admin tenant-customer APNs/FCM/Web suppression-authority registry. Private token material is file-only; removals require reviewed compare-and-swap versions. This is not operator Expo-device management or evidence of live delivery.                                                                                                                                            |
| `postwave developer-marketplace ...`                                              | Operate marketplace apps, OAuth clients, test accounts, listings, installs, app webhooks, partner profiles, review, OAuth runtime, and audit logs.                                                                                                                                                                                                                                            |
| `postwave api-keys ...` / `webhooks ...` / `inbound-webhooks ...`                 | Operate first-party developer integration primitives: scoped API keys, outbound webhooks, and inbound ingest endpoints.                                                                                                                                                                                                                                                                       |

Add `--output json|table|yaml` to most read commands.

## Examples

```sh
# Dry-run a Mailchimp migration
postwave migrate mailchimp --dry-run

# Beehiiv binds one exact publication. The dry-run preserves frozen
# segment/list snapshots, automation rebuild evidence, sent-post history, and
# premium metadata; it does not migrate Stripe billing objects or continuity.
postwave migrate beehiiv --source-api-key "$BEEHIIV_API_KEY" \
  --publication-id "$BEEHIIV_PUBLICATION_ID" --dry-run

# `--commit` completes only the reviewed initial import. Finish source-
# automation retirement, the frozen final delta, strict shadow/pilot checks,
# billing handoff, and evidence capture in the web app. MCP distribution is a
# release-held source candidate and is not a runnable lifecycle path.

# Bind a HubSpot private-app token to one numeric Hub ID. The initial import is
# not cutover approval.
postwave migrate hubspot --source-api-key "$HUBSPOT_PRIVATE_APP_TOKEN" \
  --source-account-id "$HUBSPOT_HUB_ID" --dry-run

# Track ActiveCampaign changed-contact events during a migration-to-live window
postwave migrate source-events start activecampaign job_123 --interval-seconds 900

# Keep HubSpot changed-contact polling active for at least seven continuous days.
# It does not detect standalone list/preference changes, hard deletions, or
# loss/change of an email address. Freeze changes and run the final full
# snapshot to make identities, list/subscription tags, exact preferences, and
# conservative current-email eligibility authoritative before the
# scope/shadow/rollback/pilot gates. The projection is not exact HubSpot
# sendability parity.
postwave migrate source-events start hubspot job_123 --interval-seconds 900

# Track Klaviyo changed-profile events during a migration-to-live window
postwave migrate source-events start klaviyo job_123 --interval-seconds 900
postwave migrate source-events status job_123
postwave migrate source-events stop job_123

# After HubSpot strict pilot acceptance and durable
# hubspot_post_pilot_cleanup evidence only. Verify source_session_cleared=true,
# then roll back and rotate/revoke the private app token.
postwave migrate source-events stop job_123 --post-pilot-cleanup

# Diagnose the most recent campaign
postwave diagnose cmp_2026_05_01_a

# Predict inbox placement for a draft you have on disk
postwave inbox predict --file ./draft.html

# Find managed commerce foundations and inspect Shopify health
postwave integrations catalog --category ecommerce --badge native
postwave integrations health shopify

# Track parity coverage from CI
postwave integrations coverage --output json
postwave integrations readiness --output json

# Find the native Typeform lead capture recipe
postwave integrations recipes --source typeform --available

# Operate a native-managed HubSpot foundation
postwave integrations native providers crm
postwave integrations native sync crm conn_123 \
  --payload '{"contacts":[{"email":"ada@example.com"}]}'
postwave integrations native runs crm conn_123 --limit 10
postwave integrations native ingest lead lead_123 --payload '{"email":"ada@example.com","source_id":"evt_1"}'

# Operate first-party ad audience destinations
postwave integrations audiences providers
postwave integrations audiences readiness meta --config '{"audience_id":"aud_123"}'
postwave integrations audiences sync aud_123

# Operate Slack/Discord/Teams notification integrations
postwave integrations chat create discord \
  --url https://discord.com/api/webhooks/123/token \
  --events subscriber.created,campaign.sent \
  --channel-hint "#growth"

# Inspect source-candidate SMS command names only. Do not configure a customer
# provider, phone audience, A2P request, callback, test, or campaign.
postwave sms --help

# Exact-admin suppression roster operations are bounded state controls, not
# dispatch availability or consent grants. Phone-filtered reads use the JSON
# body-query route, never a URL. Preserve nextCursor and pass it explicitly.
postwave sms suppressions list --limit 100 --tenant-uuid 00000000-0000-0000-0000-000000000001
postwave sms suppressions list --phone +12025550101
postwave sms suppressions add --phone +12025550101
postwave sms suppressions remove 33333333-3333-4333-8333-333333333333 --yes \
  --tenant-uuid 00000000-0000-0000-0000-000000000001

# Exact-admin tenant-customer push authority. This is an APNs/FCM/Web registry,
# not operator Expo-device management. List output exposes only 16-hex
# fingerprints; copy nextCursor unchanged to request another revision-snapshot
# page. snapshotAt is observation metadata, not a row timestamp cutoff.
postwave push suppressions list \
  --tenant-uuid 00000000-0000-0000-0000-000000000001 \
  --platform fcm --limit 50

# Prepare this mode-0600 file through a private secret workflow. It must contain
# only the exact token bytes with no trailing newline.
# Raw tokens are never accepted in argv or echoed in command output.
postwave push suppressions add \
  --tenant-uuid 00000000-0000-0000-0000-000000000001 \
  --platform fcm --token-file ./customer-push-token.secret

# Only a reviewed reversible manual/dashboard row can be removed. The exact row
# version is the compare-and-swap guard; inspect stillSuppressed in the receipt
# and keep the token held when another independent authority remains.
postwave push suppressions remove aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  --tenant-uuid 00000000-0000-0000-0000-000000000001 \
  --expected-version 3 --yes

# Bulk payloads are private strict JSON files (1–100 items). Import items hold
# device_token/platform; removal items hold id/expected_version. Both operations
# are atomic, and the CLI never accepts token values as command-line arguments.
postwave push suppressions bulk-import \
  --tenant-uuid 00000000-0000-0000-0000-000000000001 \
  --payload-file ./customer-push-holds.private.json
postwave push suppressions bulk-remove \
  --tenant-uuid 00000000-0000-0000-0000-000000000001 \
  --payload-file ./reviewed-push-removals.json --yes

# Customer push runtime, audience materialization, APNs/FCM providers, and
# automatic provider feedback remain HOLD / NO-GO. Web is registry-only; these
# records do not prove that a live send excluded or processed anything.

# Current effect boundaries include:
# sms_reply_dispatch_release_held
# sms_campaign_dispatch_release_held
# sms_broadcast_dispatch_release_held
# sms_a2p_registration_release_held
# sms_provider_callback_release_held
# sms_evidence_read_release_held

# Operate the developer marketplace runtime
postwave developer-marketplace apps create \
  --payload '{"name":"Inventory Sync","app_type":"public","distribution":"marketplace","status":"draft","scopes":["read:subscribers"],"redirect_uris":["https://partner.example/callback"],"api_revisions":["2026-05-29"],"webhook_topics":["profile.created"],"test_mode":true}'
postwave developer-marketplace oauth-clients create app_123 \
  --payload '{"redirect_uris":["https://partner.example/callback"],"scopes":["read:subscribers"]}'
postwave developer-marketplace apps monitoring app_123
postwave developer-marketplace review queue \
  --review-secret "$POSTWAVE_MARKETPLACE_REVIEW_SECRET" \
  --kind app

# Operate developer integration primitives
postwave api-keys create \
  --label "Warehouse sync" \
  --scopes read:subscribers,read:reports \
  --sandbox-only false
postwave webhooks create \
  --url https://example.com/postwave/webhook \
  --events subscriber.added,campaign.sent
postwave webhooks deliveries wh_123
postwave webhooks replay delivery_123 --idempotency-key replay-job-42
postwave webhooks rotate wh_123 --grace-minutes 1440
postwave inbound-webhooks create --name "Typeform leads"
postwave inbound-webhooks events inbound_123
postwave inbound-webhooks replay inbound_123 42 \
  --idempotency-key inbound-replay-job-42

# Create first-party commerce and warehouse connections
postwave integrations native create commerce \
  --provider bigcommerce \
  --shop-domain store-123 \
  --credential-ref vault://commerce/bigcommerce \
  --config '{"store_hash":"abc123"}'

postwave integrations native create warehouse \
  --provider snowflake \
  --name "Snowflake prod" \
  --credential-ref vault://warehouse/snowflake \
  --direction export \
  --objects profiles,events,catalog \
  --cadence daily \
  --backfill-days 365 \
  --config '{"account":"acct","warehouse":"COMPUTE_WH","database":"POSTWAVE","schema":"PUBLIC"}'
```

## Environment variables

| Var                  | Default                    | Purpose                                      |
| -------------------- | -------------------------- | -------------------------------------------- |
| `POSTWAVE_API_KEY`   | —                          | Bypass stored credential.                    |
| `POSTWAVE_BASE_URL`  | `https://api.moosewave.com` | API base; overridable for staging.           |
| `POSTWAVE_TENANT_ID` | —                          | Tenant slug when not encoded in the API key. |

## Development

The CLI ships with a small set of authoring tools that complement the
dashboard for people who live in the terminal.

### `postwave dev`

Starts a local preview server that compiles `*.email.tsx` and `*.mjml`
files in your current directory into email-safe HTML and renders them in
a browser UI with hot-reload.

```sh
postwave dev
postwave dev --port 5173 --no-browser
```

Defaults:

- Port `4321` (or `POSTWAVE_DEV_PORT`).
- Watches the cwd recursively for `*.email.tsx` and `*.mjml`.
- Auto-opens `http://localhost:<port>/` unless `--no-browser` is set.

The UI shows a file list, a desktop/mobile preview iframe with
dark-mode toggle, an auto-detected variables form (driven by
`{{ .Field }}` placeholders in the HTML), a persona switcher, a
debounced subject co-pilot (3 ranked suggestions with predicted
placement bars), and a "Send test to me" button that goes through
`pw.campaigns.sendTest`.

> Loading `.email.tsx` files requires `tsx` to be installed in your
> project (`npm i -D tsx`). The CLI prints a clear error if it is
> missing.

### `postwave logs tail`

Streams live email events from `pw.events.stream(...)` straight to
your terminal, pretty-printed with chalk. Ctrl-C to stop.

```sh
postwave logs tail
postwave logs tail --filter event_type=opened
postwave logs tail --filter campaign=cmp_2026_05_01_a
```

`--filter` may be repeated. Supported keys: `event_type`, `campaign`
(alias `campaign_id`). Any other `key=value` filter is matched
client-side against the event record.

### `postwave integrations`

Inspects and operates the unified integrations facade used by the
dashboard. Catalog rows keep the same honesty badges as the public UI:
`native`, `partner`, `zapier`, `webhook`, `api_sdk`, `migration_only`,
and `planned`.

```sh
postwave integrations catalog --query HubSpot
postwave integrations connections
postwave integrations detail shopify --output json
postwave integrations contract meta-ads
postwave integrations sync shopify
postwave integrations disconnect hubspot
```

Coverage commands are meant for release gates and roadmap reviews:

```sh
postwave integrations coverage
postwave integrations stacks --output yaml
postwave integrations readiness --output json
```

Recipe commands expose one-click bridge paths for platforms that are not
yet native-managed:

```sh
postwave integrations recipes --provider Zapier --available
postwave integrations recipe typeform-leads-inbound-webhook
postwave integrations apply-recipe typeform-leads-inbound-webhook
```

Native managed commands operate concrete connection IDs after setup. Data
families import canonical rows when supplied, and providers with configured
native pullers can also accept empty sync/backfill requests with an optional
cursor. Analytics provider pulls are currently available for PostHog, Triple
Whale, Mixpanel, and Amplitude; other analytics providers require canonical
`profiles` or `events` and fail closed with the server's `payload_required`
response. Warehouse uses object selections and server-managed cursors.
Families are `commerce`, `crm`, `lead`, `reviews`, `loyalty`,
`subscriptions`, `support`, `analytics`, `marketing`, and `warehouse`:

```sh
postwave integrations native providers crm
postwave integrations native list crm
postwave integrations native create crm \
  --provider hubspot \
  --name "HubSpot production" \
  --credential-ref vault://crm/hubspot \
  --config '{"portal_id":"123456"}'

postwave integrations native get crm conn_123
postwave integrations native sync crm conn_123 \
  --payload '{"contacts":[{"email":"ada@example.com"}]}'
postwave integrations native backfill crm conn_123 \
  --payload '{"events":[{"email":"ada@example.com","event_name":"Deal Stage Changed"}]}' \
  --cursor 2026-06-01T00:00:00Z
postwave integrations native runs crm conn_123 --limit 10
postwave integrations native pause crm conn_123
postwave integrations native disconnect crm conn_123

postwave integrations native ingest lead lead_123 --payload '{"email":"ada@example.com","source_id":"evt_1"}'
```

Support provider discovery is static, and support connection list/detail reads
are minimized stored projections. `native list support` accepts `--limit 1..100`
(server default `50`) and an opaque `--cursor`. Table output always writes the
verified `page.has_more` state and a safe `page.next_cursor` continuation value
to stderr. Every output mode first validates the bounded tenant envelope,
minimized rows, ordering, and pagination metadata; malformed or terminal-unsafe
responses exit nonzero without writing stdout. `--output json` preserves the
complete verified response envelope. Support
create, sync, backfill, ingest, pause, disconnect, and run-history commands fail
locally with `support_integration_runtime_held` and send no HTTP request.

CRM and lead sync/backfill commands import canonical rows when supplied.
Configured native pullers also support empty provider-managed pulls for the
provider slices that expose them through their runtime contract.

Commerce create commands use provider settings plus a vault reference;
raw credential JSON is rejected by the commerce and warehouse CLI paths:

```sh
postwave integrations native providers commerce
postwave integrations native create commerce \
  --provider bigcommerce \
  --shop-domain store-123 \
  --credential-ref vault://commerce/bigcommerce \
  --config '{"store_hash":"abc123"}'

postwave integrations native sync commerce commerce_123 \
  --payload '{"orders":[{"source_id":"order_1","customer_email":"buyer@example.com","total_cents":2500}]}'
postwave integrations native backfill commerce commerce_123 \
  --payload '{"products":[{"source_id":"prod_1","title":"Desk lamp","price_cents":4900}]}'
postwave integrations native pause commerce commerce_123
postwave integrations native disconnect commerce commerce_123
```

Commerce sync/backfill imports canonical rows when supplied. Configured native
commerce pullers also support empty provider-managed pulls with optional
cursors for providers whose runtime contract exposes them.

Warehouse connections expose connection runs through the same native
command family:

```sh
postwave integrations native providers warehouse
postwave integrations native create warehouse \
  --provider snowflake \
  --name "Snowflake prod" \
  --credential-ref vault://warehouse/snowflake \
  --direction export \
  --objects profiles,events,catalog \
  --cadence daily \
  --backfill-days 365 \
  --config '{"account":"acct","warehouse":"COMPUTE_WH","database":"POSTWAVE","schema":"PUBLIC"}'

postwave integrations native sync warehouse warehouse_123 --objects profiles,events
postwave integrations native backfill warehouse warehouse_123 --objects profiles,events
postwave integrations native runs warehouse warehouse_123 --limit 10
postwave integrations native pause warehouse warehouse_123
postwave integrations native disconnect warehouse warehouse_123
```

Warehouse run cursors and metrics are server-managed. Use connection
`backfill_days`, `import_prefix`, `input_uri`, or `--payload import_rows` for
warehouse-specific execution input.

Ad audience destinations are readiness-gated first-party foundations for Meta,
Google Ads, TikTok, LinkedIn, and Snap. Public config stores credential
references; readiness reports `credential_resolution_required` until the
trusted resolver hydrates provider tokens for live delivery:

```sh
postwave integrations audiences providers
postwave integrations audiences create \
  --provider meta \
  --list-id list_123 \
  --external-audience-id aud_123 \
  --config '{"credentials_ref":"vault://ads/meta","audience_id":"aud_123"}'

postwave integrations audiences readiness meta \
  --config '{"credentials_ref":"vault://ads/meta","audience_id":"aud_123"}'
postwave integrations audiences preview aud_123
postwave integrations audiences sync aud_123
postwave integrations audiences jobs aud_123
postwave integrations audiences disconnect aud_123
```

Chat notification integrations share one command family for Slack,
Discord, and Teams:

```sh
postwave integrations chat list discord
postwave integrations chat create teams \
  --url https://tenant.webhook.office.com/webhookb2/... \
  --events subscriber.created,campaign.sent \
  --channel-hint "Growth alerts"
postwave integrations chat update teams teams_123 --enabled false
postwave integrations chat delete teams teams_123
```

### `postwave segments from-text`

Compiles a natural-language description into a segment AST via
`pw.segments.compileFromNaturalLanguage(text)`, pretty-prints it,
asks for confirmation, and saves it.

```sh
postwave segments from-text --query "premium VC subscribers in NYC"
echo "people who opened in the last 7 days" | postwave segments from-text --yes
postwave segments from-text --query "..." --name "premium-vc-nyc"
```

The segment name comes from `--name`, the server's `suggested_name`,
or an auto-slug of the query.

### `postwave.test-personas.yaml`

Optional file at the project root, used by `postwave dev` to populate
the persona switcher. If absent, a single default persona is used.

```yaml
personas:
  - name: VC Marc
    email: marc@example.com
    custom_fields:
      first_name: Marc
      tier: premium
  - name: Free user
    email: free@example.com
    custom_fields:
      first_name: Pat
      tier: free
```

## Credentials path

The CLI stores its credential file using [`conf`](https://github.com/sindresorhus/conf):

- Linux/macOS: `~/.config/postwave/credentials.json`
- Windows: `%APPDATA%\postwave\Config\credentials.json`

The file is written with `0600` permissions on POSIX systems.
