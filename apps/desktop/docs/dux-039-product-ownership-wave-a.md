# DUX-039 product ownership — wave A

Status: source convergence completed for Subject Lab, webhook administration,
and MCP/AI-agent connection. DUX-039 remains `IN PROGRESS` because its later
concepts require separate source waves and installed qualification. Commerce /
general-Integrations ownership was subsequently converged in
`dux-039-product-ownership-wave-b.md`.

Date: 2026-07-16

## Contract

The typed source of truth is
`src/lib/product-ownership-manifest.ts`. This wave deliberately declares only
three concepts. A supporting surface may summarize, launch, diagnose, discover
or confirm the canonical concept, but it cannot quietly grow a second
administrator or a second business model.

| Concept | Canonical owner | Canonical responsibilities |
| --- | --- | --- |
| Subject Lab | `components/SubjectLab.tsx`, launched in campaign context | Axis-conditioned generation, tenant-baseline scoring, confidence intervals, analyzer evidence, result callbacks |
| Webhook administration | `pages/WebhooksHome.tsx` with `InboundWebhooks.tsx` and `OutboundWebhooks.tsx` | Inbound endpoint and outbound subscription administration, secrets, delivery operations, event catalog |
| MCP/agent connection | `pages/MCP.tsx` | Client setup, API-key setup entry, tool catalog, history, quotas and full execution observability |

The manifest also names each permitted supporting surface, its relationship and
the responsibilities it must not assume. Source-contract tests pin those
boundaries.

## Fresh source inventory and resolution

### Subject Lab

Before this wave two unrelated engines shared the same product name:

- `components/SubjectLab.tsx` used the dedicated Subject Lab generation and
  scoring APIs, an active voice profile, the tenant's 180-day baseline,
  predicted open rate, confidence intervals and matched-sample confidence.
- `components/ai/SubjectLab.tsx` used AI Compose variants and a browser-only
  heuristic score based on length, spam words, capitalization and emoji.

The confidence/baseline implementation is now the only engine. The heuristic
component was deleted. Campaign creation and the composer Copilot continue to
launch the canonical component with their live draft callbacks.

Moosewave AI now mounts `SubjectLabWorkspace`, an adapter with no generation or
scoring implementation of its own. It:

- keeps the seed and optional body context mounted when the user changes AI
  tabs;
- registers a discard-only lifecycle owner for that local draft;
- opens the canonical Subject Lab only after a ten-character seed;
- stages the top three candidates in memory for review;
- requires a separate **Continue in Campaigns** action;
- hands only the selected subject and body context to the existing take-once
  campaign-draft handoff;
- clears that take-once handoff and restores the local draft if guarded route
  navigation is cancelled, busy or fails;
- never creates an A/B campaign, creates a draft resource or sends a campaign.

The campaign page remains the authority for resource creation, A/B execution,
approval and send behavior. This is intentionally safer than invoking its
`runBandit` mutation from a context-free AI tab.

### Webhooks

The live inventory contained four different relationships:

- `WebhooksHome` plus inbound/outbound pages: tenant endpoint/subscription
  administration;
- Settings: a duplicate outbound list/create/test/delete/secret flow;
- Webhook Simulator: explicit synthetic delivery diagnostics;
- Integrations: recipe and capability discovery.

Settings' duplicate administrator has been removed. Its replacement,
`WebhookAdministrationSummary`, makes one read-only canonical list request and
shows only aggregate counts: total, active, paused, failing and distinct event
types. The only action routes to the outbound tab in Webhooks. It has no URL
editor, create/delete/test call, delivery action or signing-secret state.

`AlertPrefsSection` remains in Settings because notification thresholds and
alert destinations are Settings-owned preferences, not webhook resources.
Webhook Simulator remains diagnostic, and Integrations remains discovery.

`components/lists/tabs/WebhooksTab.tsx` is retained as a deliberately narrow
list-context adjunct, not a second tenant-wide administrator. It is constrained
to `list.subscriber.*` events, always writes `list_id`, and filters every row to
the current list. The manifest forbids it from growing inbound, tenant-wide or
general-event administration. General endpoint/subscription work belongs in
Webhooks.

### MCP and Moosewave AI Agent

Before this wave the MCP page owned snippets, catalog and observability while
Moosewave AI independently owned:

- client selection, copy and download;
- API-key list/mint/revoke;
- a second live catalog/capability gallery;
- recent execution confirmation.

`McpConnectionSetup` is now the sole aggregate setup/key owner inside MCP's
Setup tab. It reuses the existing key and connection primitives, but the
plaintext API key lives in one parent state cell only. The shown-once lifecycle
guard activates before the plaintext is exposed, remains active while the key
is projected into a connection snippet, and resolves only when the operator
explicitly says it was stored. The value is never persisted. Non-admins receive
an honest role message and a placeholder configuration.

The former Moosewave AI capability gallery was deleted. The Agent tab now shows
only `McpAgentSummary`, with typed handoffs to MCP Setup, Tools and History.
`RecentExecutionsStrip` remains a bounded five-second confirmation loop and its
full-history action opens MCP History. It cannot mint keys, install clients,
load the catalog, configure quotas or administer execution history.

The client preference migrated from `postwave.ai.agent-client.v1` to
`postwave.mcp.client.v1`. It stores only the selected client name; it never
stores a key or rendered credential-bearing snippet.

## Security and lifecycle properties

- Subject Lab drafts participate in route/quit/sign-out lifecycle review and
  expose no automatic resource-creation callback.
- MCP plaintext remains memory-only and under the existing process-level
  shown-once guard. Credential-bearing clipboard/download operations retain
  their secret classification and clipboard expiry behavior.
- Settings never receives or renders webhook secrets after convergence.
- Summary and handoff routes use the canonical desktop router, so existing
  lifecycle review applies before leaving a dirty surface.
- The ownership manifest contains source roles and responsibilities only—no
  tenant identifiers, task payloads, URLs, credentials or customer content.

## Automated evidence

The reconciled focused and adjacent checkpoint passes 102 of 102 cases across
thirteen suites:

- typed ownership manifest and source contract;
- Subject Lab staging and explicit handoff behavior;
- webhook summary counts and owner routing;
- MCP contextual handoffs and aggregate shown-once plaintext behavior;
- the canonical Subject Lab regression suite;
- MCP history, webhook simulator and sensitive-lifecycle owner regressions.

Full desktop application TypeScript, renderer-test TypeScript, scoped
zero-warning ESLint, default function complexity/length checks for every new or
non-legacy owner, and the tightened exact Moosewave AI function ratchet also
pass on the reconciled shared tree. The function-quality contract itself passes
5 of 5 cases; the shared all-source checker remains a root-level reconciliation
gate while unrelated concurrent workstreams update their own exact ratchets.

## Why DUX-039 is not implemented or verified

Wave A did not claim the rest of DUX-039. Wave B has since converged commerce
and the general integration catalog. Canonical ownership still needs source
convergence for:

- privacy/consent/incidents;
- delivery and sending controls;
- inbox/helpdesk/customer-agent concepts;
- sending settings and adjacent account/workspace settings.

Even after all source concepts converge, `VERIFIED` requires installed macOS
and Windows navigation/lifecycle qualification, role matrices, offline and
denied-storage behavior, one-time-secret recordings, assistive-technology and
keyboard evidence, and usability validation that users consistently choose the
canonical owner without searching duplicate surfaces.
