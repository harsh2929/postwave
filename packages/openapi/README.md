# @postwave/openapi

OpenAPI 3.1 spec for the Moosewave API.
MIT licensed as Layer 2 of the Moosewave open-core architecture.

The authoritative source is [`openapi.yaml`](./openapi.yaml). A
JSON twin lives at [`openapi.json`](./openapi.json) for tooling that
does not parse YAML.

## What's covered

A selected, reviewed set of operations from the gateway and the four backend
services. This is the published OpenAPI/SDK contract, not an inventory of every
mounted route. Internal trust boundaries, first-party web/session workflows,
public-token or embed behavior, compatibility routes, probes, and release-held
capabilities can include published operations. These categories are evaluated
per exact method and path; none is a blanket exclusion.

A mounted gateway operation that remains outside OpenAPI and the SDK must retain
an exact, reviewed exposure/reason classification in
[`route-contracts.json`](./route-contracts.json); direct registrations seen by
the supplementary AST scanner also require an exact, fail-closed entry in
[`openapi-exemptions.json`](./openapi-exemptions.json).

- Migrations (ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Brevo,
  Substack, Beehiiv, MailerLite, Sendy CSV, generic CSV, and CSV-backed ESP exports)
- Subscribers, Campaigns, Sequences, Templates, Voice Profile
- Embeddable Forms (admin) and public Submissions
- Inbox Reality (per-campaign placement reports), Reputation, Auth Checks
- Sending (Postmark provisioning / warmup), Automations, Webhooks, Account

The canonical outbound-webhook catalog is:

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

`GET /api/v1/outbound-webhooks/playground/events` returns this catalog with a
representative `event.data` sample for each topic. The custom playground fire
is an admin-only, live diagnostic—not a queue or a harmless preview. It can
mutate receiver state, requires a caller-retained `fire_id` plus one exact
`Idempotency-Key` and the positive `expected_webhook_config_version` the
operator confirmed. Omit `payload` to use the catalog sample; explicit null and
duplicate JSON member names at any depth are rejected, while numeric values are
preserved without float64 coercion. The raw request is capped at 524,288 bytes
and canonical payload at 262,144 bytes. The fire must be reconciled through
`GET /api/v1/outbound-webhooks/playground/fires/{fire_id}` after cancellation
or an ambiguous transport result. A `receipt_expired` identity remains consumed
after its private inspection payload ages out; its exact POST returns 410 and
must never be redispatched. The TypeScript/Python SDKs and MCP adapter
deliberately expose subscription management and the fixed `webhook.test`
probe, but do not wrap arbitrary custom-payload fire; an admin client that
needs that diagnostic must opt into the HTTP contract explicitly.

Use synthetic data only. Custom request inspection and bounded receiver output
are potentially personal arbitrary content even after credential redaction. The
server stores the exact inspection receipt in an envelope-encrypted private row
under the tenant's webhook-delivery retention policy. Conventional email-shaped
identifiers support a literal-email locator query; its synchronous section
returns only the newest 100 matches, includes no aliases, and has no
continuation. A direct-ledger erasure helper can match the requested address and
current known aliases, but the public erasure path remains disabled by the
repository-wide coverage gate. A name, phone number, or other identifier
without that email is not discoverable. Retention cryptoshredding removes the
receipt ciphertext, receipt digest, and email locators. The permanent
payload-free control row retains its tenant/fire/webhook identity,
configuration revision, event type, state/outcome/status/timestamps, and
idempotency/request hashes as the no-redispatch fence. Access-bundle JSONB
copies are outside this receipt lifecycle, so this is not a complete subject
access or erasure control. The OpenAPI contract describes source behavior; it
is not production deployment or retention-job attestation.

## Generated Versus Curated Operations

The route extractor prevents newly discovered direct API registrations from
silently drifting past the published-contract boundary: a route must already
be documented or carry an exact reviewed exemption. Generated operations include
`x-postwave-source` so reviewers can jump to the exact Go handler, but their
request/response bodies are intentionally described as endpoint-specific until
someone hand-curates stable schemas. Product-critical paths should graduate
from generated descriptions to explicit `requestBody` and response schemas
before they are announced as public API contracts.

### Route reachability is fail closed

The extractor and parity gate share
[`route-reachability.json`](./route-reachability.json). They scan the API
composition root plus internal packages imported by that root; a route-shaped
call in an unimported package is not treated as a live gateway route. Reviewed
source and operation exclusions cover dormant implementations that share a
package with mounted code. Importing an excluded source, or leaving a stale
route exclusion after its declaration disappears, fails the gate.

Do not remove an exclusion merely to make generation pass. Mount the completed
runtime deliberately, review its authentication and release contract, remove
the matching exclusion, then add or curate the OpenAPI operation. Reachability
logic is covered in both Go and Node tests so the generator and parity checker
cannot regress independently.

## Viewing the spec

### Scalar (recommended)

Open [`viewer.html`](./viewer.html) in a browser — it loads
`@scalar/api-reference-react` from the CDN and renders the YAML in place.

```
# from this directory
python3 -m http.server 8000
# then open http://localhost:8000/viewer.html
```

### Stoplight Studio / Redoc / Swagger UI

Point any OpenAPI 3.1 viewer at `openapi.yaml`.

```bash
npx @redocly/cli preview-docs openapi.yaml
```

## Regenerating SDKs

The TypeScript, Python, and PHP SDKs in this repo (`packages/sdk-ts`,
`packages/sdk-py`, and `packages/sdk-php`) are **hand-written**, not generated,
so they stay crisp and Moosewave-shaped. When the spec changes:

1. Edit `openapi.yaml`.
2. Run `pnpm --filter @postwave/openapi metadata` and
   `pnpm --filter @postwave/openapi sync-json`; never hand-edit either JSON
   mirror.
3. Update the matching TypeScript, Python sync/async, and PHP resource methods.
4. Run `node scripts/check-route-parity.mjs` and
   `node scripts/check-sdk-parity.mjs` from the repository root, followed by
   the affected SDK test suites.

The blocking local contract checks are:

```bash
pnpm --filter @postwave/openapi regen:check
pnpm --filter @postwave/openapi regen:test
pnpm --filter @postwave/openapi metadata:check
pnpm --filter @postwave/openapi sync-json:check
pnpm --filter @postwave/openapi codegen:check
npx --yes @stoplight/spectral-cli@6 lint \
  --ruleset packages/openapi/.spectral.yaml \
  --fail-severity error packages/openapi/openapi.yaml
node scripts/check-route-parity.mjs
node scripts/check-sdk-parity.mjs
```

## TypeScript codegen for the desktop client

A separate, curated spec lives at [`surfaces/openapi.yaml`](./surfaces/openapi.yaml).
It covers the first batch of surfaces migrated to generated types
(`subscribers`, `lists`, `campaigns`, `archive`, `send_time_opt`) and
is the input to [`openapi-typescript`](https://www.npmjs.com/package/openapi-typescript):

```bash
pnpm openapi:codegen           # regenerate packages/openapi/dist/types.ts
pnpm openapi:codegen:check     # CI drift gate
```

The generated types are re-exported under semantic names from
`apps/desktop/src/lib/api-types.ts`, which is the canonical import path
for the migrated surfaces. The full migration plan covering the
remaining ~40 surfaces is in [MIGRATION.md](./MIGRATION.md).

## Hosted docs

Production docs render at `https://docs.moosewave.com/api`.
