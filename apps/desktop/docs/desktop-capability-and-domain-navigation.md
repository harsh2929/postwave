# Desktop capability, readiness, and domain-navigation contract

Status: source foundation in progress; authoritative backend and installed-app
qualification remain required
Capability source: `src/lib/desktop-capabilities.ts`  
Route/title source: `src/lib/desktop-routes.ts`
Runtime owner source: `src/lib/capability-observation-owners.ts`

## Product contract

Every persistent desktop destination has one stable capability id, one task
domain, one readiness state, one reviewed offline policy, and optional entry
role/audit-scope/recovery metadata. Sidebar grouping, command-palette labels,
the route guard, product availability in Billing, and tests consume this same
registry. A page may report an explicit server observation, but it must not
invent a plan or entitlement from an empty response, an HTTP 5xx, or a usage
limit.

Access precedence is deterministic:

1. Required role or audit scope is loading: do not mount remote content; show
   “Checking access”.
2. Required role/scope is absent or could not be confirmed: fail closed and
   explain how to request/retry access.
3. The app is offline: allow only a reviewed cached destination, clearly
   labelled as cached/limited; block every online-only destination.
4. An authoritative endpoint has reported destination-wide `plan-required` or
   `not-configured`: block content and route to Billing/Settings or
   Integrations.
5. An authoritative sub-capability endpoint has reported
   `partial-plan-required` or `partial-not-configured`: preserve entry and
   unrelated tasks, but disclose the limitation and recovery path before the
   page.
6. Static readiness is `read-only`, `mixed`, `conditional`, or `preview`:
   preserve discoverability and content, but disclose the boundary before the
   page.
7. Otherwise the destination is operational.

Blocked navigation is still discoverable. Sidebar and palette items remain
operable and lead to the shared explanation; they do not disappear or bounce
silently. The route guard does not mount the destination page, so denied,
offline, setup, and plan states cannot fall through to “no records”, zero
metrics, or first-run copy.

Runtime observations are identity scoped and memory-only. Each reporter has a
stable bounded owner id. Success clears only that owner; it cannot erase a
sibling provider/tab limitation in the same destination. The section exposes
the highest-impact current observation, with destination-wide plan/setup gates
ahead of partial plan/setup disclosures. “Check again” deliberately clears the
whole section so every mounted owner must re-establish current evidence.

HTTP 402 or the explicit codes `plan_required`,
`upgrade_required`, and `entitlement_required` can establish a plan gate.
HTTP 404/405 can establish a setup gate only when the owning feature declares
that its feature-level endpoint uses absence as capability evidence; explicit
provider/capability-not-configured codes need no such hint. Network, timeout,
parse, 401/403, generic 404, and 5xx errors remain their own transport/access
states; they never become entitlement claims.

Billing’s plan-summary endpoint currently returns tier, metered resources, and
usage projections—not per-capability entitlements. The UI therefore shows the
same static/runtime capability and entry-requirement disclosures beside plan
data but deliberately does not infer that a tier or a zero/unlimited meter
grants or denies a product.

## Runtime evidence-owner wave

The owner manifest currently pins these authoritative root/sub-capability
probes:

| Destination | Owner | Impact | Evidence boundary |
| --- | --- | --- | --- |
| Push suppressions | `push-provider` | Destination | Provider endpoint |
| Commerce | `commerce-suite` | Destination | Commerce suite-root integrations endpoint |
| Helpdesk | `service-suite` | Destination | Service-suite catalog endpoint |
| Audience syncs | `webhook-sync` | Partial | Webhook sync list; ad-platform/writeback tasks remain mounted |
| Audience syncs | `ad-platforms` | Partial | Ad-platform destination list; webhook/writeback tasks remain mounted |
| Agency | `subaccounts` | Partial | Explicit `not_agency` child-workspace response; Branding remains mounted |
| Data platform | `warehouse-catalog` | Partial | Warehouse provider/object catalog; other data tools remain mounted |
| Data platform | `warehouse-connections` | Partial | Warehouse connection list; other data tools remain mounted |
| Data platform | `reverse-etl` | Partial | Reverse-ETL connection/mapping endpoints; custom objects/transforms remain mounted |

The source-discovery contract fails if production adds a reporter that is not
in this manifest. Endpoint absence may be interpreted only by its declared
owner. Agency eligibility is derived from the structural `not_agency` code,
never by searching arbitrary error prose. A 401/403 without that code, a
generic 404, a network error or a 5xx remains a transport/access failure.
Observation reasons are bounded and reject URL, email and credential-shaped
text; endpoint errors use fixed public copy rather than reflected server
messages, resource identifiers or customer content.

## Exhaustive destination matrix

| Destination               | Domain                  | Readiness              | Offline                 | Entry access / honest boundary                                                 |
| ------------------------- | ----------------------- | ---------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Dashboard                 | Home                    | Operational            | Reviewed cache          | Previously cached dashboard data only while offline                            |
| Subscribers               | Audience                | Operational            | Limited encrypted cache | Only previously cached eligible records while offline                          |
| Tags                      | Audience                | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Lists                     | Audience                | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Segments                  | Audience                | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Audience syncs            | Audience                | Mixed                  | Online required         | Webhook sync operational; ad-platform foundations depend on provider readiness |
| Email suppressions        | Audience                | Operational            | Limited encrypted cache | Previously cached eligible suppression data only offline                       |
| Campaigns                 | Messaging               | Operational            | Online required         | Viewer entry; authoring/sending remain page-role gated                         |
| Sequences                 | Messaging               | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Automations               | Messaging               | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Forms                     | Messaging               | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Templates                 | Messaging               | Operational            | Online required         | Viewer entry; mutations remain page-role gated                                 |
| Assets                    | Messaging               | Operational            | Online required         | Viewer entry; transfers remain online/native-service controlled                |
| Collections               | Messaging               | Mixed                  | Online required         | Reference-data admin only; no personalization, automation, or coupon-pool runtime |
| Webhooks                  | Data & connections      | Operational            | Online required         | One canonical inbound/outbound destination                                     |
| Product events            | Data & connections      | Operational            | Online required         | Viewer entry                                                                   |
| Analytics                 | Insights & delivery     | Operational            | Online required         | Viewer entry; individual metrics may have their own runtime readiness          |
| Send-time optimization    | Insights & delivery     | Operational            | Online required         | Viewer entry; scheduling remains online-only                                   |
| Archive                   | Publishing & growth     | Operational            | Online required         | Viewer entry; publish mutations remain role gated                              |
| Referrals                 | Publishing & growth     | Operational            | Online required         | Viewer entry                                                                   |
| Affiliates                | Publishing & growth     | Mixed                  | Online required         | Admin entry; partner admin works, public affiliate offer unavailable           |
| Discount history          | Publishing & growth     | Read only              | Online required         | Historical reporting only; no Stripe-backed mutations/redemption               |
| Gift subscription history | Publishing & growth     | Read only              | Online required         | Historical reporting only; no purchase/claim/cancel flow                       |
| Commerce                  | Publishing & growth     | Mixed                  | Online required         | Connected-provider capabilities must be labelled individually                  |
| Reviews                   | Publishing & growth     | Operational            | Online required         | Viewer entry; moderation mutations remain page-role gated                      |
| Retention offer history   | Publishing & growth     | Read only              | Online required         | Historical records only; no authoring or automated win-back                    |
| Deliverability hub        | Insights & delivery     | Operational            | Online required         | Viewer entry; provider-specific panels retain independent state                |
| Custom domains            | Insights & delivery     | Operational            | Online required         | Viewer entry; changes remain admin gated                                       |
| DMARC reports             | Insights & delivery     | Operational            | Online required         | Viewer entry                                                                   |
| Moosewave AI               | AI                      | Operational            | Online required         | Viewer entry; model/provider failures remain explicit panel state              |
| AI changelog              | AI                      | Operational/contextual | Online required         | Canonical persistent page; included in the 54-destination palette contract     |
| Migrations                | Data & connections      | Operational            | Online required         | Viewer entry; imports and rollback require online lifecycle proof              |
| Integrations              | Data & connections      | Mixed                  | Online required         | Catalog includes verified, partial, delegated, and planned items               |
| Data platform             | Data & connections      | Conditional            | Online required         | Warehouse/reverse-ETL jobs need a configured provider                          |
| Approvals                 | Operations & governance | Operational            | Online required         | Viewer entry; approval actions remain role/policy gated                        |
| Audit log                 | Operations & governance | Operational            | Limited encrypted cache | Requires `audit:read`; cached eligible audit pages only offline                |
| Privacy incidents         | Operations & governance | Operational            | Online required         | Viewer entry; response mutations remain role gated                             |
| Consent receipts          | Operations & governance | Operational            | Online required         | Viewer entry                                                                   |
| MCP                       | Data & connections      | Operational            | Online required         | Viewer entry; token/connection actions retain local gates                      |
| SMS Inbox                 | Operations & governance | Operational            | Online required         | Viewer entry                                                                   |
| Helpdesk                  | Operations & governance | Conditional            | Online required         | Requires configured support-channel capability                                 |
| SMS suppressions          | Audience                | Operational            | Online required         | Viewer entry; mutations remain role gated                                      |
| Push suppressions         | Audience                | Conditional            | Online required         | Provider/endpoint absence becomes explicit setup gate                          |
| API Playground            | Data & connections      | Operational            | Online required         | Viewer reads; mutations require resolved admin role and review                 |
| Webhook simulator         | Data & connections      | Operational            | Online required         | Viewer entry; firing requires configured outbound webhook                      |
| Sending settings          | Insights & delivery     | Operational            | Online required         | Viewer entry; changes remain admin gated                                       |
| Agency                    | Operations & governance | Conditional            | Online required         | Branding is broad; sub-accounts/billing require agency eligibility             |
| Inbound routes            | Data & connections      | Operational            | Online required         | Viewer entry; credential/mapping changes remain admin gated                    |
| SCIM                      | Operations & governance | Operational            | Online required         | Admin entry; no token/mapping data loads before access resolves                |
| Compliance                | Operations & governance | Operational            | Online required         | Viewer entry; framework-specific unsupported states stay explicit              |
| Privacy portal            | Operations & governance | Operational            | Online required         | Viewer entry; transport failures never become an empty portal                  |
| Audit sinks               | Operations & governance | Operational            | Online required         | Requires `audit:read`; configure actions require finer page scope              |
| Audit alerts              | Operations & governance | Operational            | Online required         | Requires `audit:read`; mutations remain page-scope gated                       |
| Settings                  | Settings                | Operational            | Online required         | Viewer entry; each setting retains its own role/policy gate                    |

Aliases and contextual routes reuse the same capability identity: Outbound
Webhooks maps to Webhooks, HIPAA maps to Compliance, and Audit Investigation
requires `audit:read`. The internal AEO Sensor scaffold is `preview` and is not
a persistent or command-palette destination. All 54 persistent destinations,
including AI Changelog, are command-palette targets.

## Navigation behavior

- Nine domain groups replace the two 54-item buckets. Groups are collapsible;
  the active group reopens automatically so the current destination never
  disappears.
- Favorites, destination recents, domain collapse, and sidebar width use one
  identity-scoped preference source. Favorites and recent destinations are
  promoted once and removed from their domain list, so there are still exactly
  54 unique persistent buttons rather than duplicated navigation state.
- The collapsed sidebar is explicit and reversible. At narrow window widths it
  follows the same icon-only contract.
- The 54-item declaration/glyph catalog loads with the domain-navigation
  engine, behind a labelled `aria-busy` fallback; workspace/account chrome
  remains available on the cold shell without shipping the full catalog there.
- Command-palette navigation uses the same domain and access/readiness label.
  Selecting a restricted item opens the route-level explanation rather than
  suppressing discovery.
- Existing typed URLs, Back/Forward, resource/tab/filter state, title, focus,
  announcement, and scroll restoration remain owned by the desktop router.

## Evidence and remaining qualification

Pure tests exhaust all 54 destinations, capability-id uniqueness, every domain,
offline precedence, role/audit failure, full and partial plan/setup
observations, independent-owner aggregation, source-owner discovery, read-only
and mixed states, preference validation, identity isolation, and recency
de-dupe.
Component tests prove protected content does not mount on denial/offline,
read-only and partial disclosures preserve content, recovery actions work, and
all 54 Sidebar destinations remain unique and discoverable. The current
capability wave passes 36/36 focused cases across eight suites, including real
Commerce, Agency, Helpdesk, Audience Sync/ad-platform and Warehouse/Reverse-ETL
reporter behavior; scoped zero-warning ESLint is green. The most recent full
app and renderer-test TypeScript checkpoints are green after reconciliation
with the governance-owner and Commerce/Integrations ownership waves.

The 2026-07-16 full production renderer build plus bundle checker passed all
enforced gates after the navigation-catalog split: critical JS 662,765 bytes
(188,286 gzip), total JS 4,912,136 bytes (1,390,066 gzip), and Settings static
closure 223,854 bytes (59,681 gzip) across nine requests. This is bundle
evidence, not installed-package performance evidence.

Before source status can advance, every remaining provider-dependent feature
API and empty state must either publish through a named owner or document why
it cannot establish capability evidence; the backend still needs an
authoritative per-capability entitlement/readiness endpoint. Before calling
this contract verified, run task-finding/card-sorting sessions
with owner, operator, marketer, support, developer, and compliance roles; test
all role/plan/setup/offline fixtures against an exact backend; and qualify the
signed macOS/Windows packages with keyboard, VoiceOver/Narrator, minimum window,
zoom, Back/Forward/reopen, and slow/revoked entitlement transitions.
