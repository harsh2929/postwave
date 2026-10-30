# postwave (Python SDK)

First-party Python SDK for the [Moosewave](https://moosewave.com) API.
MIT licensed as Layer 2 of the Moosewave open-core architecture.

- Sync (`Moosewave`) + async (`AsyncPostwave`) clients on top of `httpx`.
- Pydantic v2 models for every request/response — full type hints.
- Exponential-backoff retries on 429 / 5xx (honors `Retry-After`).
- Constant-time HMAC-SHA256 webhook signature verification.
- Hand-written; the OpenAPI spec at `packages/openapi/openapi.yaml` is the source of truth.

## Install

```bash
pip install postwave
# or with poetry
poetry add postwave
```

Requires Python 3.10+.

## Quickstart (sync)

```python
from postwave import Moosewave

pw = Moosewave(api_key=os.environ["POSTWAVE_API_KEY"], tenant_id="acme")

# Generate a 3-email welcome series
seq = pw.sequences.generate({
    "template_id": "tpl_welcome_3",
    "name": "Welcome series",
    "variables": {"product_name": "Acme", "founder_name": "Alex"},
})
print(seq.emails[0].subject)
```

## Quickstart (async)

```python
import asyncio
from postwave import AsyncPostwave

async def main():
    async with AsyncPostwave(api_key=os.environ["POSTWAVE_API_KEY"], tenant_id="acme") as pw:
        page = await pw.subscribers.list(per_page=100)
        for sub in page.items:
            print(sub.email)

asyncio.run(main())
```

## Method index

| Resource                   | Methods                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pw.integrations`          | `catalog`, `connections`, `coverage`, `stacks`, `readiness`, `recipes`, `recipe`, `apply_recipe`, `detail`, `contract`, `health`, `start_connect`, `finish_connect`, `sync`, `backfill`, `pause`, `disconnect`                                                                                                  |
| `pw.native_integrations`   | `commerce`, `crm`, `lead`, `reviews`, `loyalty`, `subscriptions`, `support`, `analytics`, `warehouse` first-party surfaces. Support is catalog/minimized-read compatibility only: provider catalog plus minimized stored list/detail reads remain available; every support lifecycle method fails locally with `support_integration_runtime_held` and sends no HTTP request. Other generic families expose their route-accurate methods. |
| `pw.audience_destinations` | `providers`, `list`, `create`, `get`, `update`, `readiness`, `preview`, `sync`, `jobs`, `job_diagnostics`, `disconnect` for first-party Meta, Google Ads, TikTok, LinkedIn, and Snap audience delivery.                                                                                                         |
| `pw.chat_integrations`     | `slack`, `discord`, and `teams` incoming-webhook integrations. Each exposes `list`, `create`, `update`, and `delete`; direct `pw.discord_integrations` and `pw.teams_integrations` accessors are also available.                                                                                                |
| `pw.agent_mandates`        | Session-only `list`, reveal-once `create`, and idempotent `revoke` for bounded agent authority. API keys are deliberately refused: use a client backed by the granting person's authenticated session cookie.                                                                                                      |
| `pw.push_suppressions`     | `list`, `add`, `remove`, `bulk_import`, `bulk_remove` for exact-admin tenant-customer APNs/FCM/Web suppression authority. This is a private registry/control-plane surface, not operator Expo-device management or evidence of live delivery.                                                                     |
| `pw.developer_marketplace` | `monitoring`, `submit_listing_review`, `list_partner_profiles`, `upsert_partner_profile`, `submit_partner_profile_review`, `review_queue`, `review_app_decision`, `review_listing_decision`, `review_partner_profile_decision`, `authorize`, `token`, `revoke`                                                  |
| `pw.migrations`            | `start`, `callback`, `discover`, `dry_run`, `commit`, `get`, `verification`, `rollback`, `rollback_status`, `list_sources`                                                                                                                                                                                      |
| `pw.subscribers`           | `list`, `get`, `create`, `update`, `delete`, `search`, `suppress`                                                                                                                                                                                                                                               |
| `pw.sequences`             | `list`, `get`, `generate`, `regenerate`                                                                                                                                                                                                                                                                         |
| `pw.templates`             | `list`, `get`, `create`                                                                                                                                                                                                                                                                                         |
| `pw.campaign_templates`    | Visual newsletter designs: `list`, `search`, `get`, `create`, `update`, `delete`, `clone`, durable `adapt`/`generate`, actor-scoped `list_designs`, and `create_campaign`                                                                                                                                         |
| `pw.voice_profile`         | `get`, `build`, `list_sources`, `add_source`, `ingest_source`, `remove_source`                                                                                                                                                                                                                                  |
| `pw.forms`                 | `list`, `get`, `create`, `update`, `delete`, `list_submissions`, `export_submissions_csv`                                                                                                                                                                                                                       |
| `pw.inbox_reality`         | `get_campaign_report`, `predict`, `diagnose`, `render`                                                                                                                                                                                                                                                          |
| `pw.reputation`            | `get`                                                                                                                                                                                                                                                                                                           |
| `pw.auth_checks`           | `list`                                                                                                                                                                                                                                                                                                          |
| `pw.sending`               | `provision`, `get_state`, `get_warmup`                                                                                                                                                                                                                                                                          |
| `pw.automations`           | `trigger`, `list_executions`, `pause`, `resume`                                                                                                                                                                                                                                                                 |
| `pw.webhooks`              | Canonical outbound destinations: `list`, `create`, `update`, `delete`, `test`, `deliveries`, `replay`, `rotate_secret`, `verify_signature`                                                                                                                                                                      |
| `pw.inbound_webhooks`      | Signed inbound endpoints: `list`, `create`, `get`, `update`, `rotate`, `delete`, `events`, `replay`, `triggers`, `create_trigger`, `update_trigger`, `delete_trigger`, `preview_transform`                                                                                                                        |
| `pw.conversion_ingest`     | Key-bound HMAC v2 server-side conversions: `ingest` and atomic `ingest_batch` (maximum 500). The resource signs exact raw JSON bytes and omits dashboard bearer/tenant headers.                                                                                                                                     |
| `pw.conversion_ingest_secrets` | Exact-admin, metadata-only `list`, reveal-once `issue`, and exact `revoke` for conversion HMAC credentials. Sync and async pages are capped at 100 and never auto-walked. |

The async client mirrors every method.

`conversion_ingest_secrets.issue()` makes exactly one request and forcibly
omits `Idempotency-Key`, including an `httpx.Client` default header. If its
transport or exact 201 response is ambiguous, never retry blindly: list the
metadata register, identify any newly issued key ID, revoke it, and then issue
a replacement. The CLI intentionally exposes no mint command.

## SMS source boundary

The source candidate exposes synchronous and asynchronous
`list_suppressions`, `add_suppression`, and `remove_suppression` under the
exact-admin API boundary. Lists return one tenant-bound response-cutoff page;
callers must pass `nextCursor` explicitly. Exact phone filters use the JSON
body-query endpoint and never a URL. Writes affect only reversible
`manual/manual` holds and do not grant or restore consent.

SMS resource code may be present in a mutable source checkout, but it is not an
advertised customer-traffic surface. Current verdict is **HOLD / NO-GO**:
dispatch/scheduling, A2P submit/poll, hosted callbacks/clicks, financial/MMS
evidence, outbound auto-replies, and private campaign evidence reads are
structurally release-held. Do not infer availability from generated/source
method names; independently verify a promoted immutable package and hosted
release before using any SMS operation.

## Push suppression authority (Route43)

`pw.push_suppressions` and its async twin require an exact-admin credential and
an expected canonical tenant UUID. `list` returns one strict snapshot page;
copy an opaque `nextCursor` unchanged to continue. Rows expose only a minimized
16-hex `device_token_hash`, never the raw customer token or full digest. Raw
tokens are accepted only by `add` and `bulk_import` request bodies and must not
be logged.
Snapshot membership is pinned by a monotonic visibility revision;
`snapshotAt` is response-observation metadata, so valid row timestamps may be
later if the database clock moved backward.

Only reversible `manual`/`dashboard` authority can be removed. Pass the exact
reviewed row `version` as `expected_version`; a valid receipt increments it and
reports `stillSuppressed`. Keep the token suppressed when that value is true.
Provider, user-opt-out, complaint, and legacy-review authority is locked and
fails closed. `bulk_remove` applies the same compare-and-swap rule atomically to
every item.

```python
tenant_id = os.environ["POSTWAVE_TENANT_UUID"]
page = pw.push_suppressions.list(tenant_id=tenant_id, limit=50)

# Read this value directly from a private secret store. Never log it or place it
# in application evidence.
manual = pw.push_suppressions.add(
    device_token=os.environ["CUSTOMER_PUSH_TOKEN"],
    platform="fcm",
    tenant_id=tenant_id,
)
receipt = pw.push_suppressions.remove(
    manual["id"],
    expected_version=manual["version"],
    tenant_id=tenant_id,
)
if receipt["stillSuppressed"]:
    # Another independent authority still holds this customer token.
    pass
```

This tenant-customer APNs/FCM/Web registry is not operator Expo-device
management. It does not lift the current **HOLD / NO-GO** on customer push
runtime, audience materialization, APNs/FCM providers, or automatic provider
feedback. Web is registry-only and does not prove a live send excluded or
processed anything.

## Mailchimp migration lifecycle

Mailchimp runs require an explicit audience scope. Discover once without a
scope to list audiences, repeat the chosen IDs for the scoped preview and
authoritative dry run, wait for `awaiting_confirmation`, then commit those same
IDs:

```python
auth = pw.migrations.start("mailchimp")
# Redirect to auth.authorize_url. The OAuth callback returns the job_id.
callback = pw.migrations.callback("mailchimp", code, auth.state)
job_id = callback["job_id"]

inventory = pw.migrations.discover("mailchimp", job_id)
discovered_audience_ids = {audience.id for audience in inventory.audiences}
# Replace this placeholder with IDs the operator explicitly chose from the
# discovery result. Never default to every discovered audience.
audience_ids = ["<operator-selected-audience-id>"]
if not audience_ids or not set(audience_ids) <= discovered_audience_ids:
    raise RuntimeError("Choose valid Mailchimp audience IDs")

pw.migrations.discover("mailchimp", job_id, audience_ids)
pw.migrations.dry_run("mailchimp", job_id, audience_ids)
# Poll pw.migrations.get(job_id) until status == "awaiting_confirmation".
report = pw.migrations.verification(job_id)
# Present the full report for operator approval, especially discovery/source-
# archive warnings, account-global resources, unsupported automations, and the
# generic, non-detected Customer Journey gap. Do not approve from counts alone
# or treat that gap as a Journey inventory.
print(report.resource_completeness)
operator_approved = your_explicit_approval_workflow(report)
if not operator_approved:
    raise RuntimeError("Explicit operator approval required")
pw.migrations.commit("mailchimp", job_id, audience_ids)
```

If the credential is revoked, invalidated, or the authorizing user's access
changes, call `start("mailchimp", job_id)` and complete its callback. Passing
`job_id` reconnects the same non-running job, preserving its reviewed scope;
omitting it starts a new migration. Only the validated Classic `welcomeSeries`
subset can become paused runtime records; other Classic workflows require
manual rebuild/review. The API cannot enumerate or export Customer Journey
graphs, so operators must inventory them in Mailchimp and attach rebuild or
waiver evidence themselves. The async client uses the same arguments.

## Integrations facade

Search the public catalog, inspect connection health, and delegate lifecycle
actions through the owning connector surface:

```python
catalog = pw.integrations.catalog(q="Snowflake", badge="native")
readiness = pw.integrations.readiness()
print(readiness["public_claim"])

snowflake = catalog["items"][0]

detail = pw.integrations.detail(snowflake["slug"])
print(detail["connection"]["health_message"])

sync = pw.integrations.sync(snowflake["slug"])
print(sync["delegated_to"])
```

Catalog badges are intentionally explicit: `native`, `partner`, `zapier`,
`webhook`, `api_sdk`, `migration_only`, or `planned`. Check `runtime_status`:
`partial` native entries are Moosewave-managed foundations until provider
pullers, callbacks, and lifecycle adapters are verified.

## Native managed integrations

Use the facade for catalog discovery and public setup state. Use
`native_integrations` when you already have the concrete managed connection ID
and need provider metadata, run history, or direct lifecycle controls:

Support is the held exception: `providers()` is static discovery, while
`list()` and `get()` return tenant-bound minimized historical stored
projections. A first page is not complete history. Continue manually only when
`page["has_more"]` is true by copying the opaque `page["next_cursor"]` exactly
into a new `list(limit=..., cursor=...)` call; do not decode, alter, or reuse a
cursor for a different query. Rows and detail do not prove live credentials,
callbacks, synchronization, or run history. The async facade uses the same
arguments and envelope.

```python
support_page = pw.native_integrations.support.list(limit=50)
if support_page["page"]["has_more"]:
    next_support_page = pw.native_integrations.support.list(
        limit=50,
        cursor=support_page["page"]["next_cursor"],
    )
    print(next_support_page["items"])
support_detail = pw.native_integrations.support.get(
    "22222222-2222-4222-8222-222222222222"
)
print(support_detail["runtime_status"])  # held

providers = pw.native_integrations.crm.providers()
print([provider["name"] for provider in providers["items"]])

connection = pw.native_integrations.crm.create({
    "provider": "hubspot",
    "name": "HubSpot production",
    "credentials_ref": "vault://crm/hubspot",
    "settings": {"portal_id": "123456"},
})

pw.native_integrations.crm.sync(connection["id"], {
    "contacts": [{"email": "ada@example.com"}],
})
# Support lifecycle calls are intentionally omitted: create/sync/backfill/
# ingest/pause/disconnect/runs fail locally with
# support_integration_runtime_held and send no HTTP request.
pw.native_integrations.reviews.backfill("review_conn_123")
pw.native_integrations.lead.ingest("lead_conn_123", {"email": "ada@example.com"})
runs = pw.native_integrations.crm.runs(connection["id"], limit=10)
print(runs["items"][0]["status"])

pw.native_integrations.commerce.sync("commerce_conn_123", {
    "cursor": "last_cursor",
    "orders": [{"source_id": "order_123", "customer_email": "ada@example.com"}],
})
pw.native_integrations.commerce.backfill("commerce_conn_123")

pw.native_integrations.warehouse.backfill("warehouse_conn_123", {
    "object_selection": ["profiles", "events"],
})
```

## Ad audience destinations

`audience_destinations` operates readiness-gated first-party ad audience
foundations for Meta, Google Ads, TikTok, LinkedIn, and Snap. Public config
stores credential references; readiness stays `credential_resolution_required`
until the trusted resolver hydrates provider tokens for live delivery:

```python
providers = pw.audience_destinations.providers()
print(providers["providers"])

readiness = pw.audience_destinations.readiness("meta", {
    "credentials_ref": "vault://ads/meta",
    "audience_id": "aud_123",
})
print(readiness["ready"], readiness.get("missing", []))

destination = pw.audience_destinations.create({
    "provider": "meta",
    "list_id": "list_123",
    "external_audience_id": "aud_123",
    "config": {"credentials_ref": "vault://ads/meta", "audience_id": "aud_123"},
})

pw.audience_destinations.preview(destination["id"])
pw.audience_destinations.sync(destination["id"])
jobs = pw.audience_destinations.jobs(destination["id"])
print(jobs["items"][0]["status"])
diagnostics = pw.audience_destinations.job_diagnostics(destination["id"], jobs["items"][0]["id"])
print(diagnostics["diagnostics"].get("external_job_id"))
```

## Chat notification integrations

Slack, Discord, and Teams incoming-webhook integrations share one route
shape and encrypt webhook URLs server-side:

```python
pw.chat_integrations.discord.create(
    url="https://discord.com/api/webhooks/123/token",
    channel_hint="#growth",
    events=["subscriber.added", "campaign.sent"],
)

pw.teams_integrations.update("teams_123", enabled=False)
pw.chat_integrations.for_provider("slack").delete("slack_123")
```

## Developer marketplace

Public partner apps can use the marketplace OAuth runtime without hand-rolling
endpoint paths. Partner profiles also follow the review-owned certification
flow used by public catalog tiles:

```python
monitoring = pw.developer_marketplace.monitoring("app_123")
print(monitoring["status"], monitoring.get("blockers", []))

listing = pw.developer_marketplace.submit_listing_review("app_123")
print(listing["review_state"])

profile = pw.developer_marketplace.upsert_partner_profile({
    "organization_name": "Example Agency",
    "profile_type": "agency",
})
print(profile["status"])

pw.developer_marketplace.submit_partner_profile_review()

queue = pw.developer_marketplace.review_queue(
    os.environ["POSTWAVE_REVIEW_SECRET"],
    kind="partner_profile",
    limit=25,
)
print(queue["counts"]["profiles"])

pw.developer_marketplace.review_partner_profile_decision(
    "00000000-0000-0000-0000-000000000000",
    {"decision": "approve", "partner_level": "premier"},
    os.environ["POSTWAVE_REVIEW_SECRET"],
)

auth = pw.developer_marketplace.authorize({
    "response_type": "code",
    "client_id": "pw_oac_123",
    "redirect_uri": "https://partner.example/oauth/callback",
    "state": "st_123",
    "code_challenge": "S256_CHALLENGE",
    "code_challenge_method": "S256",
})

token = pw.developer_marketplace.token({
    "grant_type": "authorization_code",
    "code": auth["code"],
    "redirect_uri": auth["redirect_uri"],
    "client_id": "pw_oac_123",
    "client_secret": os.environ["POSTWAVE_CLIENT_SECRET"],
    "code_verifier": os.environ["PKCE_VERIFIER"],
})

pw.developer_marketplace.revoke({"token": token["access_token"]})
```

## Error handling

```python
from postwave import Moosewave, NotFoundError, RateLimitError

try:
    sub = pw.subscribers.get("does-not-exist")
except NotFoundError as e:
    print(f"missing: {e.code}")
except RateLimitError as e:
    print(f"slow down — retry in {e.retry_after_seconds}s")
```

Every error carries `status`, `code`, `message`, `request_id`.

## Signed server-side conversions

```python
import os

from postwave import Moosewave, SignedConversionCredentials

pw = Moosewave()  # no dashboard API key is needed for this HMAC-only surface
pw.conversion_ingest.ingest(
    {
        "event_name": "purchase",
        "occurred_at": "2026-08-09T10:22:31Z",
        "identity": {"external_id": "customer-123"},
        "value": 129,
        "currency": "USD",
    },
    SignedConversionCredentials(
        key_id="orders-primary", secret=os.environ["POSTWAVE_CONVERSION_SECRET"]
    ),
    idempotency_key="order-123",
)
```

The secret remains local. The SDK binds the key ID and timestamp to the exact
raw request body and pins one idempotency key across transport retries.
Plaintext email is rejected by the typed model.

## Outbound webhook event contract

`OUTBOUND_WEBHOOK_EVENT_TYPES` exports the exact subscription vocabulary:

```text
campaign.sent
subscriber.added
subscriber.removed
subscriber.unsubscribed
approval.requested
approval.decided
audit.created
bounce.received
list_health.degraded
list.subscriber.added
email.bounced
email.complained
email.delivered
assurance.run.completed
assurance.run.blocked
```

`pw.webhooks.test(id)` sends only the fixed `webhook.test` probe. The SDK does
not wrap the admin playground's arbitrary custom-payload fire: that route is a
live receiver side effect with a step-up/idempotency/reconciliation workflow,
not a normal retryable resource method. Clients deliberately opting into it
must use the documented HTTP operation, retain its `fire_id` and exact
`Idempotency-Key`, and reconcile ambiguous or cancelled calls by `fire_id`
before creating another attempt.

## Webhook verification

```python
from fastapi import FastAPI, Header, Request, HTTPException
from postwave import verify_signature

app = FastAPI()

@app.post("/postwave-webhook")
async def webhook(req: Request, x_postwave_signature: str = Header(default=None)):
    raw = await req.body()
    if not verify_signature(raw, x_postwave_signature, secret=...):
        raise HTTPException(401, "bad signature")
    envelope = await req.json()
    # event.id is stable across retries and manual replay; delivery.id is not.
    await handle_once(
        envelope["event"]["id"],
        envelope["event"]["type"],
        envelope["event"]["data"],
    )
    return {"ok": True}
```

The verifier parses `t=<unix>,v1=<hex>`, authenticates
`<timestamp>.<raw-body>`, accepts overlapping `v1` values during secret
rotation, and enforces a five-minute replay window by default.

## Development

```bash
poetry install
poetry run pytest
```
