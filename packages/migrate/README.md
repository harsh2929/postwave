# `@postwave/migrate`

**Migration adapters for ActiveCampaign, HubSpot, Mailchimp, ConvertKit, Brevo, Substack, Beehiiv, MailerLite, Klaviyo, Customer.io, Sendy CSV exports, CSV, and CSV-export backed sources like Constant Contact, AWeber, Drip, Campaign Monitor, Omnisend, Loops, Flodesk, and Bento — into a canonical schema you can ship anywhere.**

[![Go Reference](https://pkg.go.dev/badge/github.com/postwave/migrate.svg)](https://pkg.go.dev/github.com/postwave/migrate)
[![CI](https://github.com/postwave/migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/postwave/migrate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`@postwave/migrate` is a Go module that reads subscriber data, segments, automations, paid subscriptions, and campaign archives out of major newsletter and marketing automation platforms and normalizes everything into a single canonical schema. You then write that canonical data wherever you want — Moosewave, Listmonk, your own database, a different ESP, a CSV file, an `S3://` dump.

It is the read-half of Moosewave's migration pipeline, extracted, MIT-licensed, and shipped as a standalone library because **data portability should be a standard, not a moat**.

## Why this exists

Every email platform has a Mailchimp importer. None of them are honest. They pull the subscribers you can see, drop the ones marked `cleaned`, lose your tag → segment relationships, and quietly skip your automations. Six months later you discover that your "10,000-subscriber list" is actually 8,742 because the importer silently filtered.

We built this toolkit because we wanted Moosewave's migration reports to be honest before any cutover is approved — we maintain source-specific adapters, local protocol fixtures and explicit release qualification gates. Local fixtures do not establish compatibility with every real account or export.

Once we had that, we asked: who else is hurt by the lack of an honest, open migration toolkit? The answer is everyone. Every newsletter platform, every database, every "self-hosted Substack alternative", every researcher trying to analyze a public newsletter archive. The community wins more if these adapters are public than Moosewave wins by hoarding them.

So they're public. MIT. Use them in your product. Use them in your weekend hack. Use them to migrate your own data away from us and we won't be mad.

The pitch:

> **Read once, ship anywhere.** Pull from any supported platform, get back a `canonical.Subscriber` (or Segment, Automation, PaidSub, CampaignArchive). What you do with the canonical struct is your business — write it to Listmonk's HTTP API, INSERT into Postgres, dump it to JSON, hand it to your favourite ESP's API client. The hard part — the source-side decoding — is done.

> **Hosted commit boundary:** every subscriber import requires an isolated engine selected through `LISTMONK_TENANT_ROUTES`, or a legacy dedicated engine with `LISTMONK_DEDICATED_TENANT_ID` exactly matching the authenticated tenant. Registry destinations are bound durably to the tenant and migration job. This runtime safety gate is stricter than using the source adapters as a standalone Go library.

## Install

```bash
go get github.com/postwave/migrate
```

Go 1.25 or newer; repository CI uses the pinned Go 1.26.8 toolchain.

## 60-second quickstart

Read every subscriber page out of Mailchimp:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/mailchimp"
)

func main() {
	a := mailchimp.New()
	sess, err := a.Authenticate(context.Background(), adapter.Credentials{
		AccessToken: os.Getenv("MAILCHIMP_OAUTH_TOKEN"),
		AccountID:   os.Getenv("MAILCHIMP_DC"), // e.g. "us21"
	})
	if err != nil {
		panic(err)
	}

	var subs []canonical.Subscriber
	cursor := ""
	for {
		page, next, err := a.ListSubscribers(context.Background(), sess, cursor)
		if err != nil {
			panic(err)
		}
		subs = append(subs, page...)
		if next == "" {
			break
		}
		cursor = next
	}
	fmt.Printf("got %d subscribers\n", len(subs))

	for _, s := range subs[:min(3, len(subs))] {
		_ = json.NewEncoder(os.Stdout).Encode(s)
		_ = canonical.Subscriber{} // documentation hint
	}
}

func min(a, b int) int { if a < b { return a }; return b }
```

That's it. `subs` is a `[]canonical.Subscriber` — a fully-portable slice of structs. Every adapter exposes the same interface; swapping `mailchimp.New()` for `beehiiv.New()` is the only line you change.

## Adapter capability matrix

| Source                                                                                   | Auth                                        |                      Subs                       |                     Segments                     |                                                Automations                                                 |                                 Archive                                  |  Paid Subs   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- | :---------------------------------------------: | :----------------------------------------------: | :--------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------: | :----------: |
| ActiveCampaign                                                                           | API token + trusted account URL             |     email-addressable; phone-only archived      | partial: lists runtime, saved definitions review |                                enriched source definition + rebuild review                                 |                sent campaigns + read-only source archive                 |      no      |
| HubSpot                                                                                  | portal-bound Service Key / existing token              | exact email contacts + conservative preferences | frozen list/subscription tags + preserved rules  |                                                     no                                                     |                                    no                                    |      no      |
| Mailchimp                                                                                | OAuth 2.0                                   |                       yes                       |                       yes                        | partial: validated Classic `welcomeSeries`; other Classic workflows and all Journeys require manual review |                                   yes                                    |      no      |
| Kit (ConvertKit) | OAuth 2.0 v4 | yes | tags; saved filters need review | sequence content/settings preserved for rebuild; never auto-activated | completed broadcasts with HTML and required statistics | separate Stripe helper only |
| Brevo | account API key, bound to organization ID | email contacts; scoped opt-outs remain suppressed | list membership; saved rules require rebuild | no public graph export | sent HTML + individual campaign reports | no |
| Substack                                                                                 | CSV or official export ZIP                  | yes (status + tier provenance; consent unconfirmed) |                     no                         |                                                     no                                                     | posts.csv + matching HTML; aggregate delivery/open evidence when exported | no (tier metadata only) |
| Beehiiv                                                                                  | API key                                     |                       yes                       |                       yes                        |                                                    yes                                                     |                                   yes                                    |     yes      |
| MailerLite                                                                               | API token                                   |       yes (suppression + opt-in evidence)       |   groups runtime; saved rules rebuild review    |                                          rebuild review only                                               | metadata/plain text + aggregate reports; rendered HTML unavailable       |      no      |
| Klaviyo                                                                                  | API key (Klaviyo-API-Key + revision header) |                       yes                       |        partial (lists + segment metadata)        |                                         source definition + review                                         |                            yes (email + sms)                             |      no      |
| Customer.io                                                                              | App API key (Bearer; US/EU regions)         |                       yes                       |   yes (exact frozen segment/topic memberships)   |               campaigns/broadcasts preserved for rebuild review; no runtime workflow import                | yes (sent email newsletters only; other definitions are source evidence) |      no      |
| Sendy                                                                                    | CSV upload                                  |                       yes                       |                        no                        |                                                     no                                                     |                                    no                                    |      no      |
| Constant Contact / AWeber / Drip / Campaign Monitor / Omnisend / Loops / Flodesk / Bento | CSV upload                                  |                       yes                       |                        no                        |                                                     no                                                     |                                    no                                    |      no      |
| CSV                                                                                      | upload                                      |                       yes                       |                       n/a                        |                                                    n/a                                                     |                                   n/a                                    |     n/a      |

`via Stripe` means the adapter delegates paid-subscription pulls to the shared Stripe-Connect pathway because the source platform doesn't own the billing data.

## Canonical schema overview

The canonical types are deliberately minimal. They cover what every serious ESP exposes; they don't try to be the union of every platform's quirks.

### `canonical.Subscriber`

```go
type Subscriber struct {
    Email            string
    Status           SubscriberStatus // enabled | disabled | blocklisted | unconfirmed
    ConsentTimestamp *time.Time       // nil = unknown
    ConsentSource    ConsentSource    // double_optin | single_optin | import | api | unknown
    CustomFields     map[string]interface{}
    Tags             []string
    SourceID         string           // platform-native ID
    SourcePlatform   SourcePlatform
}
```

### `canonical.Segment` (with portable AST)

```go
type Segment struct {
    Name             string
    Description      string
    QueryAST         SegmentNode
    SourceDefinition string // platform-native JSON for round-tripping
}

type SegmentNode struct {
    Op         string        // and | or | not | condition
    Children   []SegmentNode // for and / or
    Field      string        // for condition
    Comparator string        // equals | contains | gt | ...
    Value      interface{}
}
```

The AST is the same shape Moosewave's segment compiler eats. Translating it to your own database's WHERE clause is a textbook recursive-descent walk.

### `canonical.Automation`

A node-and-edge graph. Nodes are `wait`, `send_email`, `branch`, or `action`. Edges are directed. Triggers describe what fires the automation. Source-platform-specific quirks the adapter couldn't express land in `SourceDefinition` so they're never lost.

### `canonical.PaidSub`

```go
type PaidSub struct {
    StripeCustomerID     string
    StripeSubscriptionID string
    StripePriceID        string
    Status               string
    CurrentPeriodEnd     time.Time
    TrialEnd             *time.Time
    Email                string
    SourcePlatform       SourcePlatform
}
```

A direct mirror of the Stripe subscription object, scoped to the publication.

### `canonical.CampaignArchive`

One previously-sent campaign, with rendered HTML, plain text, sent timestamp, recipient count, and engagement totals.

## Per-source guides

### ActiveCampaign

**Auth:** API token + account API URL. Pass the API token as
`Credentials.APIKey` and the account URL as `Credentials.AccountID` or
`Credentials.Extra["api_url"]`. Common operator aliases
`account_api_url`, `account_url`, and `base_url` are accepted too. Both
`https://example.api-us1.com` and `https://example.api-us1.com/api/3`
normalize to the API v3 root. The URL must be HTTPS on port 443 with exactly
one account label under `api-us1.com` or `activehosted.com`; arbitrary hosts,
IPs, loopback, userinfo, query/fragment data, and cross-host redirects are
rejected before the token is sent. Authentication reads `/users/me` so hosted
workflows can bind later reconnect/commit/delta reads to the same provider
account rather than trusting the hostname as identity.

**Pilot behavior:**

- Email-addressable contacts import with phone, names, custom fields, tags,
  channel-specific list evidence, and source IDs. List status and `sdate` are
  audit provenance, not channel consent; incomplete channel or exclusion
  evidence stays unconfirmed, and SMS-only activity never enables email.
- Email-less and phone-only contacts return a typed non-email result so callers
  can preserve/review them without fabricating an email identity.
- Lists become tag-backed canonical segments. Saved-segment summaries come
  from `/audiences`, details from `/segmentsV2/{id}`, and unsafe raw predicates
  remain rebuild-only.
- Completed campaigns are hydrated from campaign detail plus linked message
  HTML/text before entering the read-only archive; missing expected content is
  surfaced as a fidelity warning.
- Automation summaries and available blocks, goals, linked campaigns, and SMS
  relationships are preserved as rebuild definitions. They are not executable
  canonical runtime automations until rebuilt and tested.
- CRM deals and pipelines can be exposed through the optional
  `SourceArchiveAdapter` so the hosted migration service can preserve them in
  a read-only source archive while executable CRM parity is still being built.
- Discovery and source archive cover CRM, forms, messages, available custom
  object schemas and records, ecommerce connections, customers, orders and
  per-order products, and SMS broadcasts. These inventories are explicit
  rebuild evidence, not executable parity claims.

**Caveats:**

- Editable template reconstruction is limited to adapters that expose a
  canonical template stream. Mailchimp currently imports editable templates
  from `/templates` plus `/templates/{id}/default-content`.
- Custom-object schemas and available records are preserved, but that does not
  prove every provider-side relationship is complete. Ecommerce connections,
  customers, orders, and per-order products are preserved; catalogs, abandoned
  carts, and executable commerce triggers are not claimed. SMS broadcasts are
  archive-only and do not establish SMS opt-in. These surfaces require explicit
  parity review before activation.
- Use the hosted migration service's `shadow-check` or durable
  `shadow-monitor` endpoints during customer pilots to detect source-side
  deltas before final cutover.
- ActiveCampaign contact updates also expose the optional
  `adapter.SourceEventAdapter` surface. The hosted migration service uses it
  for `source-events` monitoring during the 7-14 day overlap window. Each poll
  fixes lower and upper update-time bounds, drains that immutable window in
  ascending contact ID order, and advances to the fixed upper bound only after
  every page succeeds. The resumable cursor carries those bounds, the last
  contact ID, and the verified provider-account fingerprint; polling does not
  use mutable update-time ordering or offset pagination.
- Use `delta-import` after the final ActiveCampaign freeze. The service reruns
  the idempotent import from the stored encrypted source session and produces a
  fresh verification report.
- Use `automation-rebuilds` plus `pilot-acceptance` to track and hard-gate the
  top unsupported automations before the first customer cutover; the acceptance
  gate also includes rollback rehearsal and a mandatory, evidence-referenced
  consent/exclusion review. This review must reconcile email and SMS consent by
  channel, ActiveCampaign exclusions, and email-less contacts after the final
  delta; it is human cutover evidence, not a claim that API v3 exposes a
  complete exclusion-list read contract.

### HubSpot

**Auth:** A dedicated HubSpot Service Key (existing private app tokens also work) with
`crm.objects.contacts.read`, `crm.schemas.contacts.read`, `crm.lists.read`,
`subscriptions-definition-read`, and `subscriptions-status-read`. Pass the
token as `Credentials.APIKey`; `Credentials.AccountID` can carry the expected
numeric Hub ID. Authentication verifies that selector against
`/account-info/2026-03/details`, binds the session to an opaque portal
fingerprint, and never trusts caller metadata as provider identity.

Create a key under **Development → Keys → Service keys** using a Super admin
or Developer tools account. Give it only the reads listed above. The complete
preflight also requires account details and daily API usage; a missing scope,
quota read or unsupported account stops discovery. Service Keys use the same
Bearer transport as existing tokens, and rotation must preserve the verified
portal. After reconciliation, delete the dedicated key in HubSpot and remove
its stored session in Moosewave. Deleting our copy alone does not revoke access
at HubSpot. See [HubSpot's Service Key guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys).
These are local protocol checks; a real account must still qualify all reads.

**Pilot behavior:**

- The final snapshot traverses all contacts, exact non-sensitive contact
  property definitions, exact list membership and allowlisted structural list
  metadata, active email subscription
  definitions, every per-contact subscription status, and account/brand-wide
  email opt-outs through HubSpot's `2026-03` APIs. Sensitive/highly-sensitive
  property values are deliberately not requested.
- Email-addressable contacts import with phone, lifecycle stage, populated
  non-sensitive properties, HubSpot source IDs, CRM provenance, exact
  communication-preference evidence, and frozen list/subscription tags.
  Contacts without a usable primary email are counted/fingerprinted and
  excluded. Additional addresses are counted exactly but are not independent
  sendable identities; aliases on non-email contacts remain fingerprint-only.
- Lists become exact `hubspot:list:{id}` membership snapshots. Dynamic-list
  predicates are deliberately not requested or persisted because HubSpot
  filter operations can contain sensitive literal values and are not
  translated or continuously evaluated by Moosewave. `Segment.SourceDefinition`
  retains only allowlisted structural identity/version/type/status evidence and
  marks predicate fidelity as unavailable; operators must rebuild or retain
  source-owned rules explicitly.
- A contact can be enabled only when every active email definition is
  `SUBSCRIBED`, no scoped or wide opt-out exists, and the current primary email
  has no hard-bounce reason, quarantine, invalid-address,
  non-marketing/unknown-marketing-contact, pending/unconfirmed double-opt-in,
  or legacy opt-out restriction. `NOT_SPECIFIED` remains unconfirmed. Consent
  timestamps are retained only when every active subscribed row has defensible
  legal-basis or self-service-resubscription evidence. This is a conservative
  projection, not exact HubSpot sendability parity; primary-email changes
  require a fresh authoritative snapshot because eligibility/DOI evidence is
  tied to the current email.
- HubSpot remains CRM system of record for the first customer pilot. Deals,
  companies, tickets, notes, and workflows are intentionally not migrated into
  Moosewave for the email/SMS cutover.
- Modified contacts expose the optional `adapter.SourceEventAdapter` surface
  using HubSpot contact search filtered by `lastmodifieddate`, so shadow mode
  can replay safe subscriber upserts during the HubSpot bridge overlap window.
- Changed-contact polling is not a complete change feed: list-only or
  preference-only changes, deletions, and contacts that lose primary email can
  be missed. The authoritative final full contact/list/preference snapshot is
  required after the freeze, followed by an exact fingerprint shadow check,
  rollback rehearsal, hard scope review, strict pilot acceptance, local
  source-session deletion, rollback, and external token cleanup evidence.

**Caveats:**

- Contact creation time remains provenance, but sendability is not an
  acknowledgment-only gap: the adapter imports and validates HubSpot's exact
  per-type and wide email communication-preference evidence, then applies the
  current-primary-email eligibility restrictions above. The pilot gate requires
  complete preference and eligibility coverage and cannot be waived as a
  warning.
- Discovery fails instead of returning partial data above 1,000,000 contacts,
  10,000 traversal pages, or 64 MiB of aggregate retained snapshot data.
  Changed-contact CRM Search also fails at its 10,000-result bound; poll more
  frequently or narrow the overlap window before retrying.
- Before the two per-contact communication-preference reads, discovery probes
  HubSpot's daily usage and reserves the larger of 1,000 calls or 5% of the
  daily limit. Insufficient budget fails before partial preference coverage.
  API traversal is bounded at 100 contacts per contact page/preference batch,
  100 contact properties per chunk, and 500 list rows per page.
- Exact list membership is imported by default through HubSpot's `2026-03` list
  memberships batch-read endpoint. Contacts receive `hubspot:list:{id}` tags
  so the migrated "HubSpot: ..." segments target the frozen audience. Future
  dynamic membership changes require a rebuilt Moosewave predicate or retained
  HubSpot ownership. Exact list membership is mandatory and fails closed when
  it cannot be completed.

### Mailchimp

**Auth:** OAuth 2.0. Set `MAILCHIMP_CLIENT_ID` and `MAILCHIMP_CLIENT_SECRET` (from your registered app at [admin.mailchimp.com](https://admin.mailchimp.com/account/oauth2/)). The adapter exposes `mailchimp.BuildAuthorizeURL(state, redirectURI)` and `mailchimp.ExchangeCode(ctx, code, redirectURI)` so you can drop OAuth into any HTTP framework.

**Caveats:**

- Mailchimp documents a maximum of 10 simultaneously processing requests per
  user. Within one migration-service process, every adapter instance shares a
  conservative 10-request ceiling keyed by the verified Mailchimp account
  fingerprint (and a hashed credential/data-center fallback while identity is
  being resolved). Separate service replicas are not coordinated by that
  in-memory limiter, so Mailchimp's HTTP 429 remains authoritative across the
  deployment. The hosted job honors `Retry-After` when present and resumes from
  durable collection state.
- `cleaned` status (hard-bounced) maps to `blocklisted`. The exact native Mailchimp status remains available to the hosted migration service so suppression and verification records do not flatten it into an ordinary unsubscribe.
- Classic Automations (`/automations`) are readable. Mailchimp's public
  Marketing API exposes Customer Journey API-trigger actions, but not a
  general "export all journey maps" endpoint suitable for migration. The
  adapter emits one generic, non-detected Customer Journey parity-gap warning;
  it cannot enumerate, count, or preserve individual Journey graphs. Operators
  must inventory Journeys in Mailchimp and attach rebuild or waiver evidence.
  Only the validated Classic `welcomeSeries` subset can become paused runtime
  records; other Classic workflows remain manual-review items.
- Signup forms and audience-schema evidence are scoped to the selected
  audiences. Landing pages and ecommerce store metadata are account-wide and
  preserved as explicitly labeled source-archive records in the hosted
  migration service.

### ConvertKit (Kit)

**Auth:** OAuth 2.0. Set `CONVERTKIT_CLIENT_ID` / `CONVERTKIT_CLIENT_SECRET` from your developer dashboard. Use `convertkit.BuildAuthorizeURL` / `convertkit.ExchangeCode`.

**Caveats:**

- The adapter uses Kit v4 at `https://api.kit.com/v4`, verifies the account ID, and rotates expiring OAuth tokens under a durable lock before continuing each page. Legacy v3 secrets are rejected. The migration service surfaces forms, landing pages, commerce products, and incentive downloads as parity gaps for manual rebuild.
- Tags map to canonical tags and tag-backed segments. Saved Kit segment filter logic is not fully exposed by the API, so the raw source definition is preserved for review.
- Sequences retain their content/settings as draft rebuild evidence. Their timing and enrollment rules need review before activation. Completed broadcast reads reject missing HTML or mandatory statistics. Kit may withhold older statistics under its retention policy; the job fails visibly so an operator can obtain an export.
- The separate Stripe helper requires an independently authorized Stripe connection; it does not grant permission to move billing simply because Kit OAuth succeeded.

### Substack

**Auth:** Substack does not expose a supported public migration API. The hosted upload route accepts the official publication ZIP and calls `substack.PrepareUpload`, or accepts a standalone subscriber CSV. Direct adapter callers pass `Credentials.Extra["subs_csv"]`, optional `Credentials.Extra["archive_csv"]`, `Credentials.Extra["archive_dir"]`, and optional `Credentials.Extra["archive_stats_csv"]`. The older `SUBSTACK_SUBS_CSV` / `SUBSTACK_ARCHIVE_CSV` environment fallback remains for local callers.

**Caveats:**

- Free, paid, founding, gift, and comp rows come from the same subscriber export. Tier values are namespaced metadata, not billing objects or destination entitlements.
- Signup dates are retained as `substack_created_at` provenance and never promoted to consent. Source-active rows remain unconfirmed until destination send permission is reviewed; suppressions dominate duplicate active rows.
- Segments and Automations are not exported by Substack. The capability matrix returns `false` for both.
- Official `posts.csv` metadata is joined to `posts/<post_id>.*.html`. Only rows with email-send evidence become sent archive history; drafts/pages/web-only rows remain rebuild evidence.
- Per-post delivery/open CSVs are reduced to counts without retaining recipient identities. Comments, reactions, Notes, chat, recommendations, media, assets, publication settings, consent, billing, integrations, and richer engagement history remain explicit parity records.
- `ListPaidSubs` is intentionally unsupported: an arbitrary Stripe account ID does not prove Substack publication/product ownership, and Apple in-app subscriptions are a separate rail.

### Beehiiv

**Auth:** API key. Pass via `Credentials.APIKey` and the publication ID via `Credentials.AccountID`.

**Caveats:**

- Beehiiv's API rate-limit is treated as roughly 150 req/min by the adapter bucket.
- Premium subscribers are exposed via `/v2/publications/{id}/subscriptions` and surface as `canonical.PaidSub`; when `Credentials.Extra["stripe_account_id"]` is present, Stripe fills subscription IDs, price IDs, and billing periods.
- Custom fields land in `CustomFields` keyed by the Beehiiv field name.
- Referral program, recommendations, boosts, ad-network settings, polls, subscribe widgets, and publication website settings are reported as parity gaps.

### MailerLite

**Auth:** API key. Pass via `Credentials.APIKey`.

**Caveats:**

- MailerLite's "groups" are mapped to canonical `Tags`. Field definitions are inventoried and source-preserved; subscriber field values are mapped to `CustomFields`.
- Subscriber reads request `include=groups`; without that documented expansion the API omits group memberships.
- The Connect API is globally limited to 120 requests/minute. The adapter honors `429 Retry-After` and never logs the API token.
- Groups become executable tag-backed segments. MailerLite saved-segment predicates are not exposed by the documented API, so saved segment metadata is rebuild evidence rather than an invented runtime rule.
- Automation triggers and steps are source-preserved as rebuild-review definitions. Provider-specific graph semantics and rendered automation-email bodies are not activated automatically.
- Sent campaigns retain subject, plain text when available, preview reference, timestamps, aggregate sent/open/click totals, and metadata for every API-visible email variant. Draft and ready campaign metadata is source-preserved for rebuild. The documented campaign read API does not expose rendered HTML.
- Popup, embedded, and promotion form metadata plus ecommerce shop metadata are preserved in the source archive. Their UI, embeds, consent configuration, catalogs, purchases, attribution, and triggers must be rebuilt or reconnected. Sites/landing pages and reusable templates have no documented inventory/read endpoint.
- `subscribed_at` is account-ingestion time, not portable consent proof. Only a parseable `opted_in_at` becomes a consent timestamp; raw source, opt-in IP, and lifecycle timestamps are retained in namespaced migration fields, and unconfirmed records remain unconfirmed.
- MailerLite exposes no documented token-to-account identity endpoint. Use a dedicated migration token, keep the source frozen for the final snapshot, and revoke the token after verification.

MailerLite key rotation requires a new migration. Its API does not provide the immutable account identity needed to prove that a replacement key belongs to the original account; changing credentials on an existing job is rejected.

### CSV (universal importer)

**Auth:** none. Pass the CSV path via `Credentials.Extra["csv_path"]`.

**Caveats:**

- The CSV adapter auto-detects column meaning from common header names (`email`, `e-mail`, `Email Address`, `subscriber_email`, ...). If autodetection fails, override via `Credentials.Extra["mapping"]` with a JSON object.
- Explicit source status and suppression fields are combined conservatively. Missing or unknown permission remains `unconfirmed`; signup dates and false suppression flags never grant consent.
- Tags can come from a comma- or pipe-separated `tags` column.

See [examples/csv_universal/main.go](examples/csv_universal/main.go) for the auto-detection log.

### Sendy

**Auth:** Sendy's official API does not provide a complete subscriber export
endpoint, so the adapter is intentionally CSV-upload based. Export a list from
Sendy with "Export all subscribers" and pass that file through the resumable
upload route. The adapter uses the universal CSV mapper, but preserves
`SourcePlatform=sendy` and tags rows with Sendy provenance fields.

## Examples

Runnable example programs live under [`examples/`](examples/):

- [`examples/mailchimp_export/`](examples/mailchimp_export/) — read 100 subs, print as JSON
- [`examples/csv_universal/`](examples/csv_universal/) — auto-detect a CSV's columns
- [`examples/migrate_to_listmonk/`](examples/migrate_to_listmonk/) — pipe any source into a Listmonk instance over HTTP

See [`examples/README.md`](examples/README.md) for run instructions.

## Contributing

We accept community-built adapters. The CONTRIBUTING guide explains the canonical interface every adapter must implement and the test patterns we expect.

See [CONTRIBUTING.md](CONTRIBUTING.md). We commit to merging well-tested adapter PRs within 2 weeks of submission.

For security issues, see [SECURITY.md](SECURITY.md).

For community-conduct standards, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## Or use Moosewave Cloud

If you'd rather not run this locally, **Moosewave Cloud** handles the migration end-to-end with a verification report and 7-day rollback. <https://moosewave.com>

The cloud product wraps this exact library with an orchestrator, durable job persistence, an SSE progress stream, a per-tenant Postgres-backed write-side translator, and a one-click rollback engine — none of which are open-source. The library you're reading about is the "read from the source platforms" half. Everything that comes after is Moosewave's hosted layer.

If you only need the read half, you're in the right place.

## License

MIT. © 2026 Moosewave. See [LICENSE](LICENSE).

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## File export qualification

The named CSV paths use the same resumable importer with source-specific
interpretation. `exportcsv/testdata/manifest.json` records the official guides
and labels the fixtures as synthetic. Test coverage includes all ten CSV paths,
UTF-8 BOM/CRLF, source identity, opt-outs, channel separation and restart across
a page boundary. This is local evidence; representative authorized exports and
migration/rollback runs remain required before release.

- **AWeber:** export each list and include subscription states. Unexplained
  Stop Status values cannot enable a contact; no numeric meaning is guessed.
- **Bento:** carry explicit status and unsubscribe evidence. An empty unsubscribe
  date alone does not establish permission.
- **Campaign Monitor:** reconcile list exports with the separate account
  suppression export; retain original list identity.
- **Constant Contact:** include email permissions and opt-out dates. Missing,
  pending or unknown permission stays unconfirmed. Keep SMS fields separate.
- **Drip:** preserve status, IDs, tags and confirmed-at evidence; creation dates
  remain ordinary source fields.
- **Flodesk:** include every subscription state and segment; bounce, spam,
  cleaned and archived states stay unsendable.
- **Loops:** preserve the subscribed flag and original contact properties.
- **Omnisend:** email subscription status and email opt-in dates are interpreted
  separately from SMS and push columns.
- **Sendy:** export all subscription states for each list; the GDPR label alone
  does not establish consent.
- **Generic CSV:** review the detected mapping. Missing/unknown status stays
  unconfirmed, and explicit opt-outs override positive flags.

Save files as UTF-8 CSV with distinct column names. Profile values stay text
so postal codes and long IDs survive unchanged. Supply original list/audience
metadata when importing separate exports. Imports do not recreate executable
workflows, dynamic segment rules, or source billing relationships.

## Brevo read contract

Authentication binds the provider's `organization_id`, independent of display
names and API key rotation. Legacy name-bound jobs must be restarted. Contact,
list and segment reads require collection/count fields and reject incomplete
or changing pagination. Resume cursors include source account and collection;
legacy numeric cursors must be restarted. SMS-only and invalid primary-email
contacts are excluded and counted. Pause source edits and reconcile a final
export: offset pagination is not a provider-side atomic snapshot.

Sent campaign HTML and totals come from each campaign report, because list
statistics cover only six months. Missing reports stop the archive phase.
Available statistics and A/B subject variants remain report evidence; a single
returned HTML body does not establish every rendered variant's fidelity.
Automation graphs and saved segment predicates require source inventory and
rebuilding. Provider definitions: [account](https://developers.brevo.com/reference/get-account),
[campaigns](https://developers.brevo.com/reference/get-email-campaigns).
