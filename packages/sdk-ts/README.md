# @postwave/sdk

First-party TypeScript SDK for the [Moosewave](https://moosewave.com) API.
MIT licensed as Layer 2 of the Moosewave open-core architecture.

- Strict types end-to-end (no `any`).
- Dual ESM + CJS build.
- Works in Node 18+, modern browsers, and edge runtimes.
- Exponential-backoff retries on 429 / 5xx (with `Retry-After` honoring).
- Constant-time HMAC-SHA256 webhook signature verification.
- Hand-written — no codegen toolchain — kept in lockstep with `packages/openapi`.

## Install

```bash
pnpm add @postwave/sdk
# or: npm i / yarn add
```

## Quickstart

```ts
import { PostwaveClient } from "@postwave/sdk";

const pw = new PostwaveClient({
  apiKey: process.env.POSTWAVE_API_KEY!,
  tenantId: "acme", // local-dev only; production API keys carry tenant scope
});

// Generate a 3-email welcome series
const seq = await pw.sequences.generate({
  template_id: "tpl_welcome_3",
  name: "Welcome series",
  variables: { product_name: "Acme", founder_name: "Alex" },
});

console.log(seq.emails[0].subject);
```

## Method index

| Resource                  | Methods                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pw.integrations`         | `catalog`, `connections`, `coverage`, `stacks`, `readiness`, `recipes`, `recipe`, `applyRecipe`, `detail`, `contract`, `health`, `startConnect`, `finishConnect`, `sync`, `backfill`, `pause`, `disconnect`                                                                                                     |
| `pw.nativeIntegrations`   | `commerce`, `crm`, `lead`, `reviews`, `loyalty`, `subscriptions`, `support`, `analytics`, `warehouse` first-party surfaces. Support is catalog/minimized-read compatibility only: provider catalog plus minimized stored list/detail reads remain available; every support lifecycle method fails locally with `support_integration_runtime_held` and sends no HTTP request. Other generic families expose their route-accurate methods. |
| `pw.audienceDestinations` | `providers`, `list`, `create`, `get`, `update`, `readiness`, `preview`, `sync`, `jobs`, `disconnect` for first-party Meta, Google Ads, TikTok, LinkedIn, and Snap audience delivery.                                                                                                                            |
| `pw.chatIntegrations`     | `slack`, `discord`, and `teams` incoming-webhook integrations. Each exposes `list`, `create`, `update`, and `delete`; direct `pw.discordIntegrations` and `pw.teamsIntegrations` accessors are also available.                                                                                                  |
| `pw.sms`                  | **Source candidate; HOLD / NO-GO for customer traffic.** Draft/configuration method names exist, but dispatch/scheduling, A2P submit/poll, hosted callbacks/clicks, financial/MMS evidence, auto-replies, and private reports are structurally release-held. Published immutable-package parity is not certified.            |
| `pw.pushSuppressions`     | `list`, `add`, `remove`, `bulkImport`, `bulkRemove` for exact-admin tenant-customer APNs/FCM/Web suppression authority. This is a private registry/control-plane surface, not operator Expo-device management or evidence of live delivery.                                                                            |
| `pw.developerMarketplace` | `monitoring`, `submitListingReview`, `listPartnerProfiles`, `upsertPartnerProfile`, `submitPartnerProfileReview`, `reviewQueue`, `reviewAppDecision`, `reviewListingDecision`, `reviewPartnerProfileDecision`, `authorize`, `token`, `revoke`                                                                   |
| `pw.migrations`           | `start`, `callback`, `discover`, `dryRun`, `commit`, `get`, `verification`, `rollback`, `rollbackStatus`, `listSources`                                                                                                                                                                                         |
| `pw.subscribers`          | `list`, `get`, `create`, `update`, `delete`, `search`, `suppress`                                                                                                                                                                                                                                               |
| `pw.sequences`            | `list`, `get`, `generate`, `regenerate`                                                                                                                                                                                                                                                                         |
| `pw.templates`            | Voice/sequence templates: `list`, `get`, `create`, `update`, `delete`                                                                                                                                                                                                                                           |
| `pw.campaignTemplates`    | Visual newsletter designs: `list`, `search`, `get`, personal `favorite`/`unfavorite`, recents, collections, saved searches, `listRevisions`, `getRevision`, `create`, concurrency-safe `update`, `archive`, `restore`, `clone`, durable `adapt`/`generate`, actor-scoped `listDesigns`, and `createCampaign`. Deprecated `delete` safely archives.             |
| `pw.voiceProfile`         | `get`, `build`, `listSources`, `addSource`, `ingestSource`, `removeSource`                                                                                                                                                                                                                                      |
| `pw.forms`                | `list`, `get`, `create`, `update`, `delete`, `listSubmissions`, `exportSubmissionsCSV`                                                                                                                                                                                                                          |
| `pw.inboxReality`         | `getCampaignReport`, `predict`, `diagnose`, `render`                                                                                                                                                                                                                                                            |
| `pw.reputation`           | `get`                                                                                                                                                                                                                                                                                                           |
| `pw.authChecks`           | `list`                                                                                                                                                                                                                                                                                                          |
| `pw.sending`              | `provision`, `getState`, `getWarmup`                                                                                                                                                                                                                                                                            |
| `pw.automations`          | `trigger`, `listExecutions`, `pause`, `resume`                                                                                                                                                                                                                                                                  |
| `pw.webhooks`             | Canonical outbound destinations: `list`, `create`, `update`, `delete`, `test`, `deliveries`, `deliveriesList`, `replay`, `rotateSecret`, `verifySignature`                                                                                                                                                       |
| `pw.inboundWebhooks`      | Signed inbound endpoints: `list`, `create`, `get`, `update`, `rotate`, `delete`, `events`, `replay`, `triggers`, `createTrigger`, `updateTrigger`, `deleteTrigger`, `previewTransform`                                                                                                                            |
| `pw.conversionIngest`     | Key-bound HMAC v2 server-side conversions: `ingest` and atomic `ingestBatch` (maximum 500). The resource signs the exact raw JSON bytes and omits dashboard bearer/tenant headers.                                                                                                                               |
| `pw.conversionIngestSecrets` | Exact-admin, metadata-only `list`, reveal-once `issue`, and exact `revoke` for the HMAC credentials used by conversion ingest. Pages are capped at 100 and are never auto-walked. |

`conversionIngestSecrets.issue()` makes exactly one request and forcibly omits
`Idempotency-Key`, even if the client has a default header. If its transport or
201 response is ambiguous, do not call it again blindly: list the metadata
register, identify any newly issued key ID, revoke it, and then issue a
replacement. The CLI intentionally exposes no mint command.

The SMS source candidate includes exact-admin `listSuppressions`,
`addSuppression`, and `removeSuppression`. Listing returns one tenant-bound
response-cutoff page and never follows `nextCursor` automatically. When
`phone` is present the SDK uses `POST /api/v1/sms/suppressions/query`, keeping
the exact recipient out of URLs. Add/remove affect only reversible
`manual/manual` workspace holds and never grant or restore consent.

## Push suppression authority (Route43)

`pw.pushSuppressions` requires an exact-admin credential and an expected
canonical tenant UUID. `list` returns one strict snapshot page; copy an opaque
`nextCursor` unchanged to continue. Returned rows contain a minimized 16-hex
`device_token_hash`, never the raw customer token or full digest. Raw tokens are
accepted only in `add` and `bulkImport` request bodies and must not be logged.
Snapshot membership is pinned by a monotonic visibility revision;
`snapshotAt` is response-observation metadata, so valid row timestamps may be
later if the database clock moved backward.

Only reversible `manual`/`dashboard` authority can be removed. Pass the exact
reviewed row `version` to `remove`, or `expected_version` for every
`bulkRemove` item. A valid receipt increments that version and reports
`stillSuppressed`; `true` means another independent authority still holds the
customer token. Provider, user-opt-out, complaint, and legacy-review authority
is locked and fails closed.

```ts
const tenantId = process.env.POSTWAVE_TENANT_UUID!;
const page = await pw.pushSuppressions.list({ tenantId, limit: 50 });

// Fetch this secret directly from a private store. Never log or persist it in
// application evidence.
const manual = await pw.pushSuppressions.add(
  {
    device_token: process.env.CUSTOMER_PUSH_TOKEN!,
    platform: "fcm",
    reason: "manual",
  },
  { tenantId },
);

const receipt = await pw.pushSuppressions.remove(manual.id, manual.version, {
  tenantId,
});
if (receipt.stillSuppressed) {
  // Keep treating the customer token as suppressed by another authority.
}
```

This tenant-customer APNs/FCM/Web registry does not lift the current
**HOLD / NO-GO** on customer push runtime, audience materialization, APNs/FCM
providers, or automatic provider feedback. Web is registry-only. It must not be
presented as proof that a push was excluded from, or processed by, a live send.

## Editable campaign-template lifecycle

Editable visual templates use strong ETags so one editor or agent cannot
silently overwrite another. Always fetch the current template, pass its
`etag` unchanged, and continue with the fresh ETag returned by each mutation:

```ts
const templateId = "00000000-0000-0000-0000-000000000000";
const current = await pw.campaignTemplates.get(templateId);
const updated = await pw.campaignTemplates.update(
  current.id,
  { subject: "This week at Acme" },
  current.etag,
);
const archived = await pw.campaignTemplates.archive(updated.id, updated.etag);
const restored = await pw.campaignTemplates.restore(
  archived.id,
  archived.etag,
);

const history = await pw.campaignTemplates.listRevisions(restored.id);
const snapshot = await pw.campaignTemplates.getRevision(
  restored.id,
  history.items[0].version,
);
```

`delete(id, etag)` is retained for compatibility but performs the same
recoverable archival transition. It does not permanently erase source or
revision history.

## Mailchimp migration lifecycle

Mailchimp runs require an explicit audience scope. Discover once without a
scope to list audiences, repeat the chosen IDs for the scoped preview and
authoritative dry run, wait for `awaiting_confirmation`, then commit those same
IDs:

```ts
const auth = await pw.migrations.start("mailchimp");
// Redirect to auth.authorize_url. The OAuth callback returns the job_id.
const { job_id } = await pw.migrations.callback("mailchimp", code, auth.state);

const inventory = await pw.migrations.discover("mailchimp", job_id);
const discoveredAudienceIds = new Set(
  (inventory.audiences ?? []).map(({ id }) => id),
);
// Replace this placeholder with IDs the operator explicitly chose from the
// discovery result. Never default to every discovered audience.
const audienceIds = ["<operator-selected-audience-id>"];
if (
  audienceIds.length === 0 ||
  audienceIds.some((id) => !discoveredAudienceIds.has(id))
) {
  throw new Error("Choose valid Mailchimp audience IDs");
}

await pw.migrations.discover("mailchimp", job_id, audienceIds);
await pw.migrations.dryRun("mailchimp", job_id, audienceIds);
// Poll pw.migrations.get(job_id) until status === "awaiting_confirmation".
const report = await pw.migrations.verification(job_id);
// Present the full report for operator approval, especially discovery/source-
// archive warnings, account-global resources, unsupported automations, and the
// generic, non-detected Customer Journey gap. Do not approve from counts alone
// or treat that gap as a Journey inventory.
console.log(report.resource_completeness);
const operatorApproved = await yourExplicitApprovalWorkflow(report);
if (!operatorApproved) throw new Error("Explicit operator approval required");
await pw.migrations.commit("mailchimp", job_id, audienceIds);
```

If the credential is revoked, invalidated, or the authorizing user's access
changes, call `start("mailchimp", job_id)` and complete its callback. Passing
`job_id` reconnects the same non-running job, preserving its reviewed scope;
omitting it starts a new migration. Only the validated Classic `welcomeSeries`
subset can become paused runtime records; other Classic workflows require
manual rebuild/review. The API cannot enumerate or export Customer Journey
graphs, so operators must inventory them in Mailchimp and attach rebuild or
waiver evidence themselves.

## Integrations facade

Search the public catalog, inspect connection health, and delegate lifecycle
actions through the owning connector surface:

```ts
const catalog = await pw.integrations.catalog({
  q: "Shopify",
  badge: "native",
  capability: "orders",
});

const shopify = catalog.items[0];
if (shopify) {
  const readiness = await pw.integrations.readiness();
  console.log(readiness.public_claim);

  const detail = await pw.integrations.detail(shopify.slug);
  console.log(detail.connection.health_message);

  const sync = await pw.integrations.sync(shopify.slug);
  console.log(sync.delegated_to);
}
```

Catalog badges are intentionally explicit: `native`, `partner`, `zapier`,
`webhook`, `api_sdk`, `migration_only`, or `planned`. Check `runtime_status`:
`partial` native entries are Moosewave-managed foundations until provider
pullers, callbacks, and lifecycle adapters are verified.

## Native managed integrations

Use the facade for catalog discovery and public setup state. Use
`nativeIntegrations` when you already have the concrete managed connection ID
and need provider metadata, run history, or direct lifecycle controls:

Support is the held exception: `providers()` is static discovery, while
`list()` and `get()` return tenant-bound minimized historical stored
projections. A first page is not complete history. Continue manually only when
`page.has_more` is true by copying the opaque `page.next_cursor` exactly into a
new `list({ limit, cursor })` call; do not decode, alter, or reuse a cursor for a
different query. Rows and detail do not prove live credentials, callbacks,
synchronization, or run history.

```ts
const supportPage = await pw.nativeIntegrations.support.list({ limit: 50 });
if (supportPage.page.has_more) {
  const nextSupportPage = await pw.nativeIntegrations.support.list({
    limit: 50,
    cursor: supportPage.page.next_cursor!,
  });
  console.log(nextSupportPage.items);
}
const supportDetail = await pw.nativeIntegrations.support.get(
  "22222222-2222-4222-8222-222222222222",
);
console.log(supportDetail.runtime_status); // held

const providers = await pw.nativeIntegrations.crm.providers();
console.log(providers.items.map((provider) => provider.name));

const connection = await pw.nativeIntegrations.crm.create({
  provider: "hubspot",
  name: "HubSpot production",
  credentials_ref: "vault://crm/hubspot",
  settings: { portal_id: "123456" },
});

await pw.nativeIntegrations.crm.sync(connection.id, {
  contacts: [{ email: "ada@example.com" }],
});
await pw.nativeIntegrations.lead.ingest("lead_conn_123", {
  email: "ada@example.com",
});
const runs = await pw.nativeIntegrations.crm.runs(connection.id, 10);
console.log(runs.items[0]?.status);

await pw.nativeIntegrations.commerce.sync("commerce_conn_123", {
  cursor: "last_cursor",
  orders: [{ source_id: "order_123", customer_email: "ada@example.com" }],
});

await pw.nativeIntegrations.warehouse.backfill("warehouse_conn_123", {
  object_selection: ["profiles", "events"],
});
```

## Ad audience destinations

`audienceDestinations` operates readiness-gated first-party ad audience
foundations for Meta, Google Ads, TikTok, LinkedIn, and Snap. Public config
stores credential references; readiness stays `credential_resolution_required`
until the trusted resolver hydrates provider tokens for live delivery:

```ts
const providers = await pw.audienceDestinations.providers();
console.log(providers.providers);

const readiness = await pw.audienceDestinations.readiness("meta", {
  credentials_ref: "vault://ads/meta",
  audience_id: "aud_123",
});
console.log(readiness.ready, readiness.missing ?? []);

const destination = await pw.audienceDestinations.create({
  provider: "meta",
  list_id: "list_123",
  external_audience_id: "aud_123",
  config: {
    credentials_ref: "vault://ads/meta",
    audience_id: "aud_123",
  },
});

await pw.audienceDestinations.preview(destination.id);
await pw.audienceDestinations.sync(destination.id);
const jobs = await pw.audienceDestinations.jobs(destination.id);
console.log(jobs.items[0]?.status);
```

## Chat notification integrations

Slack, Discord, and Teams incoming-webhook integrations share one route
shape and encrypt webhook URLs server-side:

```ts
await pw.chatIntegrations.discord.create({
  url: "https://discord.com/api/webhooks/123/token",
  channel_hint: "#growth",
  events: ["subscriber.added", "campaign.sent"],
});

await pw.teamsIntegrations.update("teams_123", { enabled: false });
await pw.chatIntegrations.forProvider("slack").delete("slack_123");
```

## Developer marketplace

Public partner apps can use the marketplace OAuth runtime without hand-rolling
endpoint paths. Partner profiles also follow the review-owned certification
flow used by public catalog tiles:

```ts
const monitoring = await pw.developerMarketplace.monitoring("app_123");
console.log(monitoring.status, monitoring.blockers ?? []);

const listing = await pw.developerMarketplace.submitListingReview("app_123");
console.log(listing.review_state);

const profile = await pw.developerMarketplace.upsertPartnerProfile({
  organization_name: "Example Agency",
  profile_type: "agency",
});
console.log(profile.status);

await pw.developerMarketplace.submitPartnerProfileReview();

const queue = await pw.developerMarketplace.reviewQueue(
  process.env.POSTWAVE_REVIEW_SECRET!,
  { kind: "partner_profile", limit: 25 },
);
console.log(queue.counts.profiles);

await pw.developerMarketplace.reviewPartnerProfileDecision(
  "00000000-0000-0000-0000-000000000000",
  { decision: "approve", partner_level: "premier" },
  process.env.POSTWAVE_REVIEW_SECRET!,
);

const auth = await pw.developerMarketplace.authorize({
  response_type: "code",
  client_id: "pw_oac_123",
  redirect_uri: "https://partner.example/oauth/callback",
  state: "st_123",
  code_challenge: "S256_CHALLENGE",
  code_challenge_method: "S256",
});

const token = await pw.developerMarketplace.token({
  grant_type: "authorization_code",
  code: auth.code,
  redirect_uri: auth.redirect_uri,
  client_id: "pw_oac_123",
  client_secret: process.env.POSTWAVE_CLIENT_SECRET!,
  code_verifier: process.env.PKCE_VERIFIER!,
});

await pw.developerMarketplace.revoke({ token: token.access_token });
```

## Error handling

Every method throws a typed subclass of `PostwaveError`:

```ts
import { PostwaveClient, NotFoundError, RateLimitError } from "@postwave/sdk";

try {
  await pw.subscribers.get("does-not-exist");
} catch (e) {
  if (e instanceof NotFoundError) console.warn(`gone: ${e.code}`);
  else if (e instanceof RateLimitError)
    console.warn(`retry in ${e.retryAfterSeconds}s`);
  else throw e;
}
```

Every error carries `status`, `code`, `message`, and (when the gateway sets it)
a `requestId` you can include in support tickets.

## Signed server-side conversions

```ts
const publicClient = new PostwaveClient({ authMode: "none" });
await publicClient.conversionIngest.ingest(
  {
    event_name: "purchase",
    occurred_at: "2026-08-09T10:22:31Z",
    identity: { external_id: "customer-123" },
    value: 129,
    currency: "USD",
  },
  { keyId: process.env.POSTWAVE_CONVERSION_KEY_ID!, secret: process.env.POSTWAVE_CONVERSION_SECRET! },
  { idempotencyKey: "order-123" },
);
```

The secret remains local. The SDK binds the key ID and timestamp to the exact
raw request body with HMAC-SHA256 and pins one idempotency key across transport
retries. Plaintext email is not part of the typed contract.

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

## Webhook signature verification

```ts
import { verifySignature } from "@postwave/sdk";

// Express, with body-parser raw middleware so req.body is a Buffer:
app.post("/postwave-webhook", async (req, res) => {
  const ok = await verifySignature(
    req.body,
    req.headers["x-postwave-signature"] as string,
    process.env.POSTWAVE_WEBHOOK_SECRET!,
  );
  if (!ok) return res.status(401).end();
  const envelope = JSON.parse(req.body.toString());
  // Persist event.id before side effects. It is stable across automatic
  // retries and manual replay; delivery.id identifies this delivery only.
  await handleOnce(envelope.event.id, envelope.event.type, envelope.event.data);
  res.status(200).end();
});
```

The verifier parses `t=<unix>,v1=<hex>`, authenticates
`<timestamp>.<raw-body>`, accepts overlapping `v1` values during secret
rotation, and enforces a five-minute replay window by default. It uses Web
Crypto and works unchanged on Cloudflare Workers, Vercel Edge, Deno, Bun, and
Node 18+.

## Contributing

Open a PR against `packages/sdk-ts/`. Run:

```bash
pnpm -F @postwave/sdk test
pnpm -F @postwave/sdk typecheck
pnpm -F @postwave/sdk build
```

The OpenAPI spec at `packages/openapi/openapi.yaml` is the source of truth;
keep `src/types.ts` in sync with any spec change in the same PR.
