# DUX-039 product ownership — wave B

Status: Commerce/general-Integrations source convergence completed. DUX-039
remains `IN PROGRESS` because privacy, delivery/sending, inbox/helpdesk and
sending/account-settings concepts still require their own ownership waves and
installed-platform qualification.

Date: 2026-07-16

## Decision

`Commerce` is the only administrator for commerce-store connections.
`Integrations` remains the cross-product discovery surface: catalog, search,
readiness, coverage, stack analysis, recipes and a read-only connection
summary. When an Integrations action would administer a commerce source, it
hands a typed intent to Commerce instead of opening a second detail panel,
credential form, lifecycle mutation or disconnect confirmation.

The typed ownership source is
`src/lib/product-ownership-manifest.ts`. Its new
`commerce-store-administration` definition assigns:

| Relationship | Surface | Permitted responsibility |
| --- | --- | --- |
| Canonical owner | `pages/Commerce.tsx` and `components/commerce/IntegrationsTab.tsx` | Provider registry, credential lifecycle, OAuth/create, connection status, sync/backfill, pause, disconnect, health and commerce-data browsing |
| Discovery/handoff | `pages/Integrations.tsx` and its catalog controllers | Catalog/readiness/recipe discovery, read-only connection summary and provider/action handoff |

Integrations is explicitly forbidden from collecting commerce credentials,
mutating commerce connections, running commerce sync/backfill, or presenting
commerce operational detail and data browsing.

## Complete source inventory

The convergence review traced every commerce-relevant interaction in both
domains:

- `pages/Integrations.tsx` composes catalog and overlay controllers.
- `pages/integrations/useIntegrationsCatalogController.ts` loads catalog,
  connection-summary, coverage, readiness, stacks and recipes. These are
  retained as discovery/read-only evidence.
- `pages/integrations/IntegrationsCatalogSurface.tsx` renders catalog cards and
  now passes the catalog item into Manage so source ownership can be resolved.
- `pages/integrations/IntegrationPanels.tsx` remains the generic non-commerce
  detail/recipe presentation.
- `pages/integrations/useIntegrationLifecycleController.ts` owns generic and
  native non-commerce actions. Every commerce-source branch now exits through
  the typed Commerce handoff before any generic `integrationsApi` detail or
  mutation call.
- `pages/integrations/IntegrationOverlays.tsx` retains CRM, lead, review,
  loyalty, subscription, support, analytics and warehouse setup overlays. Its
  commerce case was removed. Detail guides and recipe-blueprint setup links
  now carry their source item into the same ownership handoff.
- `pages/integrations/NativeProviderConnectModals.tsx` retains those
  non-commerce provider credential flows. The duplicate `CommerceConnectModal`,
  its `commerceApi` import and its second credential draft were removed.
- `pages/integrations-helpers.ts` no longer classifies commerce as a native
  in-place connect target.
- `pages/Commerce.tsx` consumes route intents while preserving the exact
  `useCapabilityReporter("commerce", "commerce-suite")` readiness owner and
  its authoritative 404/405 suite-absence handling.
- `components/commerce/IntegrationsTab.tsx` remains the connection operator:
  provider registry, credential-protected store setup, status/sync-state rows,
  sync/backfill, confirmed pause, confirmed disconnect, analytics and
  customers/products/orders/events browsing.
- `components/commerce/CatalogsTab.tsx`, `RecoveryTab.tsx` and
  `LifecycleTab.tsx` remain adjacent Commerce-owned catalog, recovery and
  eligibility workflows; no competing implementation was introduced.
- `lib/api/commerce.ts` remains the direct Commerce API boundary. The general
  Integrations controller has no `commerceApi` import.

The second source pass found no `commerceApi`, `CommerceConnectModal`,
`native-commerce` draft owner or `case "commerce"` overlay under
`pages/integrations`. Generic `integrationsApi` calls remain intentionally for
non-commerce sources and are protected by earlier commerce-source exits.

## Typed handoff contract

`src/lib/commerce-owner-intents.ts` defines the only cross-surface payload:

```text
task: connect | manage | sync | backfill | pause | disconnect
provider: catalog source slug
integrationId?: canonical Commerce connection id
```

No credential, secret, provider settings, token, shop-domain draft, callback
payload, customer content or arbitrary URL can be represented. The canonical
desktop route stores the provider as the sole filter and the optional
connection id as the overlay resource id.

| Intent | Overlay | Commerce behavior |
| --- | --- | --- |
| Connect | `connect-store` | Opens the canonical credential-protected modal for a new or disconnected connection; an identified live connection never opens a duplicate setup flow |
| Manage | `manage-store` | Opens the matching connection's Commerce data/health browse area |
| Sync | `sync-store` | Shows a review notice; the operator must explicitly select **Sync now** |
| Backfill | `backfill-store` | Shows a review notice; the API documents backfill as the same handler, so Commerce truthfully labels and starts a sync/backfill |
| Pause | `pause-store` | Shows a review notice, then a separate confirmation before the direct pause request |
| Disconnect | `disconnect-store` | Shows a review notice, then the canonical destructive confirmation before disconnect |

The generic `connect/callback` catalog action resolves to Manage for a commerce
source. Commerce's provider callback remains owned by its OAuth/backend flow;
Integrations no longer calls the generic callback endpoint for that source.

## Navigation, reload and lifecycle behavior

- The intent uses the canonical desktop router and therefore survives app
  reload/reopen and browser-style Back/Forward navigation.
- Merely restoring or navigating to sync, backfill, pause or disconnect never
  calls an API. Mutations require a visible explicit action; pause and
  disconnect add confirmation.
- A provider plus explicit connection id must match the same Commerce row.
  Commerce never falls back to another connection of that provider when the id
  is stale, edited or belongs to a different provider.
- Dismissal or successful completion replaces the transient overlay with the
  base Commerce route. Switching tabs drops the transient overlay/filter but
  creates normal history, so Back can restore the safe review state.
- A connect route reopens a fresh, blank credential modal after Forward or
  reload. Credential values are never encoded in history. Existing draft and
  active-operation lifecycle guards continue to review navigation, quit,
  sign-out and workspace changes.
- A failed action leaves the intent visible for review/retry. A successful
  action whose list refresh fails reports that split outcome without claiming
  stale UI is current.
- Accepted sync, pause and disconnect requests share a retained single-flight
  lifecycle owner, so route changes, quit, restart and identity changes cannot
  silently abandon an in-flight store operation.

## Security, role and failure properties

- Producer and consumer both enforce admin-only mutations. A direct edited
  route cannot bypass Commerce's `canAdmin` gate.
- Commerce target resolution requires an exact normalized provider and, when
  present, exact integration id. An explicit id never degrades to
  provider-only selection.
- The canonical `StoreConnectModal` holds credentials only in component memory,
  uses `useCredentialDraftLifecycle`, blocks dismissal during active work and
  requires explicit discard when switching provider or closing a dirty draft.
- Provider-registry and connection failures render public fallback/error copy;
  thrown transport exceptions are not interpolated into credential UI.
- OAuth authorization uses the existing Tauri external-URL boundary. Direct
  provider creation continues to transmit credential references through the
  Commerce API without persisting them in the handoff route.
- Capability reporting and partial/full Commerce gates from DUX-040 are
  unchanged: verified list success reports available, while only authoritative
  suite-root absence becomes not-configured.

## Automated evidence

The focused and adjacent checkpoint passes 97 of 97 cases across fifteen
suites. It covers:

- all six intent codec round trips;
- exact provider/id target matching and malformed-route rejection;
- Back, Forward and route-reload restoration;
- identity-scoped app-reopen persistence containing only the bounded
  task/provider/connection identifiers;
- absence of credentials/secrets/settings in route payloads;
- Integrations controller handoff for connect, manage, sync, backfill, pause
  and disconnect with zero generic commerce mutation/detail calls;
- preservation of the generic non-commerce lifecycle;
- admin gates on both surfaces;
- no mutation on intent render, explicit sync, and confirmed pause/disconnect;
- process-level blocking ownership while a store mutation is in flight;
- connect provider preselection, disconnected-store reconnect posture and
  prevention of duplicate setup for a live connection;
- the canonical credential lifecycle, non-commerce provider modals, readiness
  reporting, manifest/source ownership and all Commerce/Integrations API/helper
  regressions.

Full app TypeScript, renderer-test TypeScript, scoped zero-warning ESLint,
default 300-line/complexity-50 function checks and the function-quality
contract are required reconciliation gates. No function-quality budget was
added or raised for this wave.

## Honest residuals

This ownership wave does not invent unsupported backend behavior:

- the Commerce client exposes pause but no corresponding resume endpoint;
  confirmed pause is canonical, while resume must remain a separately tracked
  backend/product capability rather than a misleading local control;
- OAuth completion remains browser/backend-driven and the connection appears
  after approval and refresh;
- installed macOS/Windows Back/Forward/reload, OAuth return, offline, denied
  storage, role, focus, keyboard, screen-reader and high-zoom recordings remain
  necessary before `VERIFIED`;
- usability validation must still confirm that users understand Integrations
  as discovery and Commerce as the operator without searching for a removed
  duplicate administrator.

DUX-039 therefore stays `IN PROGRESS`. Remaining source convergence is limited
to privacy/consent/incidents, delivery/sending controls,
inbox/helpdesk/customer-agent concepts, and sending/account/workspace settings,
followed by cross-platform qualification.
