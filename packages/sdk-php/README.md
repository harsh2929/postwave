# postwave-php

Official PHP SDK for the [Moosewave](https://moosewave.com) email + automation platform.

```bash
composer require postwave/postwave-php
```

## PHP requirements

Use PHP **8.2.35+, 8.3.36+, 8.4.27+, or 8.5.12+** within those minor
branches, with the cURL and JSON extensions. Composer rejects earlier patches
and unsupported PHP 8.1 installations. CI uses the latest patch in each
supported branch and checks the installed platform before running tests.

These minimums include the 21 October 2026 fixes for
[CVE-2026-109618 and CVE-2026-109619](https://www.php.net/archive/2026.php#2026-10-21-5).
For applications serving PHP web requests, also follow PHP's
[23 October session upload progress guidance](https://www.php.net/archive/2026.php#2026-10-23-1)
until the follow-up fix is released. A library cannot patch the host interpreter
or enforce its web server configuration; upgrade PHP on every SDK consumer's
server as well. Moosewave's own web application and API use Node and Go.

## Quick start

```php
use Moosewave\Client;

$pw = new Client(apiKey: getenv('POSTWAVE_API_KEY'));

$campaign = $pw->campaigns->create([
    'name'    => 'Black Friday teaser',
    'subject' => 'Mark your calendar',
    'body_html' => '<p>Hi {{ subscriber.first_name }}…</p>',
]);

$pw->campaigns->send($campaign['id']);
```

## Available resources

The skeleton ships with first-class wrappers for the most-used surfaces:

- `$pw->campaigns` — list / get / create / update / delete / send / send_test
- `$pw->campaignAssurance` — direct Fact Contract replacement plus immutable run creation/readback, manifests, paged evidence, progress snapshots, governed appeals/overrides, stored-finding application, and cancellation
- `$pw->campaignPolls` — materialize semantic-AST polls, list immutable campaign poll definitions, and read aggregate tallies with every excluded population visible
- `$pw->subscribers` — list / search / suppress
- `$pw->lists` — list / create / delete
- `$pw->segments` — list / create / preview
- `$pw->forms` — list / create
- `$pw->integrations` — catalog / connections / coverage / stacks / readiness / health / recipes / lifecycle actions
- `$pw->nativeIntegrations` — commerce / CRM / lead / reviews / loyalty / subscriptions / support / analytics / marketing / warehouse first-party surfaces. Support is catalog/minimized-read compatibility only: provider catalog plus minimized stored list/detail reads remain available, and `support->list(['limit' => 50, 'cursor' => $opaqueCursor])` preserves the bounded opaque pagination envelope. Every support lifecycle and run-history effect fails locally with `support_integration_runtime_held` and sends no HTTP request. Other generic families expose their route-accurate methods; only ingest-capable families expose working generic-family `ingest`.
- `$pw->audienceDestinations` — providers / list / create / get / update / readiness / preview / sync / jobs / disconnect for readiness-gated first-party ad audience foundations
- `$pw->chatIntegrations` — Slack / Discord / Teams incoming-webhook integrations; direct `$pw->discordIntegrations` and `$pw->teamsIntegrations` accessors are also available
- `$pw->sms` — **source candidate; HOLD / NO-GO for customer traffic**. Draft/configuration method names exist, but dispatch/scheduling, A2P submit/poll, hosted callbacks/clicks, financial/MMS evidence, auto-replies, and private reports are structurally release-held. Published immutable-package parity is not certified.
- `$pw->pushSuppressions` — `list`, `add`, `remove`, `bulkImport`, and `bulkRemove` for exact-admin tenant-customer APNs/FCM/Web suppression authority. This is a private registry/control-plane surface, not operator Expo-device management or evidence of live delivery.
- `$pw->developerMarketplace` — app CRUD/validation, OAuth clients, test accounts, listings, installs, app webhooks, partner profiles, review decisions, audit logs, and marketplace OAuth authorize / token / revoke
- `$pw->apiKeys` — list / get / create / rotate / revoke
- `$pw->inboundWebhooks` — manage signed inbound endpoints, events, durable replays, transforms, and triggers
- `$pw->webhooks` — list / create / update / delete / test / deliveries / replay / secret rotation on canonical `/api/v1/outbound-webhooks`
- `$pw->events` — replay (cursor-based)
- `$pw->conversionIngestSecrets` — exact-admin, metadata-only `list`, reveal-once `issue`, and exact `revoke` for conversion HMAC credentials; pages are capped at 100 and never auto-walked
- `$pw->migrations` — OAuth/credential setup, discover, dry run, commit, verification, and rollback
- `$pw->campaignTemplates` — visual newsletter catalog, personal discovery state, editable lifecycle, durable adapt/generate jobs, and actor-scoped `listDesigns` recovery
- `$pw->status` — public + subscriber endpoints

Other resources are accessible via the generic `$pw->request(...)` method, which mirrors the OpenAPI spec at `https://docs.moosewave.com/openapi.yaml`.

`$pw->conversionIngestSecrets->issue()` accepts only the exact 201 contract,
makes one transport attempt, and strips `Idempotency-Key` even from client-wide
headers. If the result is ambiguous, never retry blindly: list the metadata
register, identify any newly issued key ID, revoke it, and then issue a
replacement. The CLI intentionally exposes no mint command.

## Campaign Assurance and semantic polls

Fact Contract replacement is an exact conditional write. Pass the complete
closed v1 object (or `[]` to send the explicit JSON `{}` no-contract state),
the current strong campaign ETag, and optionally a stable retry key. The result
contains both the updated campaign and the next strong ETag:

```php
$updated = $pw->campaignAssurance->setFactContract(
    $campaignId,
    $factContractV1,
    $reviewedCampaignEtag,
    $stableRetryKey
);
$nextCampaignEtag = $updated['etag'];

$accepted = $pw->campaignAssurance->run($campaignId, [
    'profile' => 'full',
    'request_id' => $logicalRequestUuid,
]);
$latest = $pw->campaignAssurance->getLatest($campaignId);
```

Every assurance success is a versioned envelope with explicit source-class
disclosures. Modeled evidence is a prediction, not observation of a provider's
private inbox. Setting `include_seed_test` and `observed_surfaces` only requests
named controlled observation; while no controlled-client adapter is configured,
the API fails closed with `controlled_observation_unavailable` before creating
a snapshot or run.

Campaign polls can only materialize question/options already frozen in a
semantic-v2 content revision; callers supply runtime settings, never a second
copy of poll meaning:

```php
$poll = $pw->campaignPolls->materialize($campaignId, [
    'content_revision_id' => $revisionId,
    'poll_key' => 'venue:primary',
    'two_step_required' => true,
]);
$tally = $pw->campaignPolls->tally($campaignId, 'venue:primary');
```

Only explicitly human-classified, uncontaminated confirmations enter option
counts. Machine, unclassified, multi-option-voided, superseded, and
preview-only populations remain visible and excluded.

## Mailchimp migration lifecycle

Mailchimp runs require an explicit audience scope. Discover once without a
scope to list audiences, repeat the chosen IDs for the scoped preview and
authoritative dry run, wait for `awaiting_confirmation`, then commit those same
IDs:

```php
$auth = $pw->migrations->start('mailchimp');
// Redirect to $auth['authorize_url']; the callback returns the job_id.
$callback = $pw->migrations->callback('mailchimp', $code, $auth['state']);
$jobId = $callback['job_id'];

$inventory = $pw->migrations->discover('mailchimp', $jobId);
$discoveredAudienceIds = array_column($inventory['audiences'] ?? [], 'id');
// Replace this placeholder with IDs the operator explicitly chose from the
// discovery result. Never default to every discovered audience.
$audienceIds = ['<operator-selected-audience-id>'];
if ($audienceIds === [] || array_diff($audienceIds, $discoveredAudienceIds) !== []) {
    throw new RuntimeException('Choose valid Mailchimp audience IDs');
}

$pw->migrations->discover('mailchimp', $jobId, $audienceIds);
$pw->migrations->dryRun('mailchimp', $jobId, $audienceIds);
// Poll $pw->migrations->get($jobId) until awaiting_confirmation.
$report = $pw->migrations->verification($jobId);
// Present the full report for operator approval, especially discovery/source-
// archive warnings, account-global resources, unsupported automations, and the
// generic, non-detected Customer Journey gap. Do not approve from counts alone
// or treat that gap as a Journey inventory.
var_dump($report['resource_completeness'] ?? []);
$operatorApproved = yourExplicitApprovalWorkflow($report);
if (!$operatorApproved) {
    throw new RuntimeException('Explicit operator approval required');
}
$pw->migrations->commit('mailchimp', $jobId, $audienceIds);
```

If the credential is revoked, invalidated, or the authorizing user's access
changes, call `start('mailchimp', $jobId)` and complete its callback. Passing
`$jobId` reconnects the same non-running job, preserving its reviewed scope;
omitting it starts a new migration. Only the validated Classic `welcomeSeries`
subset can become paused runtime records; other Classic workflows require
manual rebuild/review. The API cannot enumerate or export Customer Journey
graphs, so operators must inventory them in Mailchimp and attach rebuild or
waiver evidence themselves.

## Integrations facade

Search the honest public catalog, inspect runtime state, and delegate lifecycle
actions through the owning connector surface:

```php
$catalog = $pw->integrations->catalog([
    'q' => 'Shopify',
    'badge' => 'native',
    'capability' => 'orders',
]);
$readiness = $pw->integrations->readiness();
echo $readiness['public_claim'] ?? '';

$shopify = $catalog['items'][0] ?? null;
if ($shopify) {
    $detail = $pw->integrations->detail($shopify['slug']);
    echo $detail['connection']['health_message'] ?? '';

    $sync = $pw->integrations->sync($shopify['slug']);
    echo $sync['delegated_to'] ?? '';
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

```php
$providers = $pw->nativeIntegrations->crm->providers();
echo $providers['items'][0]['name'] ?? '';

$connection = $pw->nativeIntegrations->crm->create([
    'provider' => 'hubspot',
    'name' => 'HubSpot production',
    'credentials_ref' => 'vault://crm/hubspot',
    'settings' => ['portal_id' => '123456'],
]);

$pw->nativeIntegrations->crm->sync($connection['id'], [
    'contacts' => [['email' => 'ada@example.com']],
]);
$pw->nativeIntegrations->lead->ingest('lead_conn_123', ['email' => 'ada@example.com']);
$runs = $pw->nativeIntegrations->crm->runs($connection['id'], 10);
echo $runs['items'][0]['status'] ?? '';

$pw->nativeIntegrations->commerce->sync('commerce_conn_123', [
    'cursor' => 'last_cursor',
    'orders' => [['source_id' => 'order_123', 'customer_email' => 'ada@example.com']],
]);

$pw->nativeIntegrations->warehouse->backfill('warehouse_conn_123', [
    'object_selection' => ['profiles', 'events'],
]);
```

## Ad audience destinations

Ad audience destinations are readiness-gated first-party foundations. Public
config stores credential references; readiness stays
`credential_resolution_required` until the trusted resolver hydrates provider
tokens for live delivery.

```php
$providers = $pw->audienceDestinations->providers();

$readiness = $pw->audienceDestinations->readiness('meta', [
    'credentials_ref' => 'vault://ads/meta',
    'audience_id' => 'aud_123',
]);
echo $readiness['status'] ?? '';

$destination = $pw->audienceDestinations->create([
    'provider' => 'meta',
    'segment_id' => 'seg_vips',
    'external_audience_id' => 'aud_123',
    'config' => [
        'credentials_ref' => 'vault://ads/meta',
        'audience_id' => 'aud_123',
    ],
]);

$pw->audienceDestinations->preview($destination['id']);
$pw->audienceDestinations->sync($destination['id']);
$jobs = $pw->audienceDestinations->jobs($destination['id']);
```

## Chat notification integrations

Slack, Discord, and Teams incoming-webhook integrations encrypt webhook URLs
server-side and share one route shape:

```php
$pw->chatIntegrations->discord->create([
    'url' => 'https://discord.com/api/webhooks/123/token',
    'channel_hint' => '#growth',
    'events' => ['campaign.sent', 'subscriber.created'],
]);

$pw->teamsIntegrations->update('teams_123', ['enabled' => false]);
$pw->chatIntegrations->forProvider('slack')->delete('slack_123');
```

## SMS

Do not configure a customer provider, phone audience, sender registration,
callback, test, or campaign through this source surface. The current public
effect boundaries include `sms_reply_dispatch_release_held`,
`sms_campaign_dispatch_release_held`,
`sms_broadcast_dispatch_release_held`,
`sms_a2p_registration_release_held`,
`sms_provider_callback_release_held`, and
`sms_evidence_read_release_held`.

```php
$smsReleaseVerdict = 'HOLD / NO-GO';
$smsReleaseCode = 'sms_campaign_dispatch_release_held';

// Source method names are inventory, not a runnable customer-send guide.
// Wait for a separately promoted SDK artifact and hosted SMS release.
```

The source candidate exposes exact-admin `listSuppressions`,
`addSuppression`, and `removeSuppression`. `listSuppressions` requires the
expected canonical tenant UUID, returns one response-cutoff page, and leaves
opaque cursor continuation to the caller. A phone filter uses the JSON
body-query endpoint, never a URL. Writes affect only reversible
`manual/manual` holds and never grant or restore consent.

## Push suppression authority (Route43)

`$pw->pushSuppressions` requires an exact-admin credential and an expected
canonical tenant UUID on every call. `list` returns one strict snapshot page;
copy an opaque `nextCursor` unchanged to continue. Rows expose only a minimized
16-hex `device_token_hash`, never the raw customer token or full digest. Raw
tokens are accepted only by `add` and `bulkImport` request bodies and must not
be logged.
Snapshot membership is pinned by a monotonic visibility revision;
`snapshotAt` is response-observation metadata, so valid row timestamps may be
later if the database clock moved backward.

Only reversible `manual`/`dashboard` authority can be removed. Pass the exact
reviewed row `version` to `remove`, or `expected_version` for every
`bulkRemove` item. A valid receipt increments that version and reports
`stillSuppressed`; keep the customer token suppressed when it is true.
Provider, user-opt-out, complaint, and legacy-review authority is locked and
fails closed.

```php
$tenantId = (string) getenv('POSTWAVE_TENANT_UUID');
$page = $pw->pushSuppressions->list($tenantId, ['limit' => 50]);

// Fetch this secret directly from a private store. Never log or persist it in
// application evidence.
$manual = $pw->pushSuppressions->add([
    'device_token' => (string) getenv('CUSTOMER_PUSH_TOKEN'),
    'platform' => 'fcm',
    'reason' => 'manual',
], $tenantId);
$receipt = $pw->pushSuppressions->remove(
    $manual['id'],
    $manual['version'],
    $tenantId
);
if ($receipt['stillSuppressed']) {
    // Another independent authority still holds this customer token.
}
```

This tenant-customer APNs/FCM/Web registry is not operator Expo-device
management. It does not lift the current **HOLD / NO-GO** on customer push
runtime, audience materialization, APNs/FCM providers, or automatic provider
feedback. Web is registry-only and does not prove a live send excluded or
processed anything.

## Developer marketplace

```php
$monitoring = $pw->developerMarketplace->monitoring('app_123');
echo $monitoring['status'];

$listing = $pw->developerMarketplace->submitListingReview('app_123');
echo $listing['review_state'];

$profile = $pw->developerMarketplace->upsertPartnerProfile([
    'organization_name' => 'Example Agency',
    'profile_type' => 'agency',
]);
echo $profile['status'];

$pw->developerMarketplace->submitPartnerProfileReview();

$queue = $pw->developerMarketplace->reviewQueue(
    (string) getenv('POSTWAVE_REVIEW_SECRET'),
    ['kind' => 'partner_profile', 'limit' => 25]
);
echo $queue['counts']['profiles'] ?? 0;

$pw->developerMarketplace->reviewPartnerProfileDecision(
    '00000000-0000-0000-0000-000000000000',
    ['decision' => 'approve', 'partner_level' => 'premier'],
    (string) getenv('POSTWAVE_REVIEW_SECRET')
);

$auth = $pw->developerMarketplace->authorize([
    'response_type' => 'code',
    'client_id' => 'pw_oac_123',
    'redirect_uri' => 'https://partner.example/oauth/callback',
    'state' => 'st_123',
    'code_challenge' => 'S256_CHALLENGE',
    'code_challenge_method' => 'S256',
]);

$token = $pw->developerMarketplace->token([
    'grant_type' => 'authorization_code',
    'code' => $auth['code'],
    'redirect_uri' => $auth['redirect_uri'],
    'client_id' => 'pw_oac_123',
    'client_secret' => getenv('POSTWAVE_CLIENT_SECRET'),
    'code_verifier' => getenv('PKCE_VERIFIER'),
]);

$pw->developerMarketplace->revoke(['token' => $token['access_token']]);
```

## Developer primitives

```php
$key = $pw->apiKeys->create([
    'label' => 'Warehouse sync',
    'scopes' => ['read:subscribers', 'read:reports'],
    'sandbox_only' => true,
]);
echo $key['plaintext'];

$endpoint = $pw->inboundWebhooks->create(['name' => 'Partner leads']);
echo $endpoint['secret'];

$pw->webhooks->create([
    'url' => 'https://example.com/postwave/webhook',
    'events' => ['campaign.sent', 'list.subscriber.added'],
    'auth_config' => [
        'type' => 'bearer',
        'bearer_token' => getenv('RECEIVER_BEARER_TOKEN'),
    ],
]);
$pw->webhooks->test('wh_123'); // always emits canonical webhook.test
$deliveries = $pw->webhooks->deliveries('wh_123', ['cursor' => 'next_page']);
$pw->webhooks->replay('delivery_123', 'stable-job-id');

$events = $pw->inboundWebhooks->events($endpoint['endpoint']['id']);
$pw->inboundWebhooks->replay(
    $endpoint['endpoint']['id'],
    $events['items'][0]['id'],
    'stable-replay-job-id',
);
```

## Configuration

```php
new Client(
    apiKey: 'pw_live_…',
    baseUrl: 'https://api.moosewave.com', // optional override
    timeout: 30,                          // seconds
);
```

## Error handling

Every method throws a `\Moosewave\Errors\PostwaveError` subclass on HTTP error:

| Status | Error                                    |
| ------ | ---------------------------------------- |
| 401    | `AuthError`                              |
| 403    | `ForbiddenError`                         |
| 404    | `NotFoundError`                          |
| 409    | `ConflictError`                          |
| 422    | `ValidationError`                        |
| 429    | `RateLimitError` (`->retryAfterSeconds`) |
| 421    | `WrongRegionError` (`->correctEndpoint`) |
| ≥500   | `ServerError`                            |

Network failures throw `NetworkError`.

## Webhook verification

```php
use Moosewave\Webhook;

if (!Webhook::verify($_SERVER['HTTP_X_POSTWAVE_SIGNATURE'], $rawBody, $secret)) {
    http_response_code(400);
    exit;
}
```

`Webhook::verify` parses the timestamped `t=<unix>,v1=<hex>` header,
authenticates the exact raw request bytes, accepts overlapping `v1` values
during rotation, and rejects signatures outside the configured replay window.

## Status

This is a beta SDK. The full resource matrix is auto-generated from `packages/openapi/openapi.yaml` and stays in lockstep with the TypeScript + Python SDKs.
