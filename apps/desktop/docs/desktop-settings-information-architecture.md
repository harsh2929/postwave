# Desktop Settings information architecture

## Status and scope

This document records the implemented DUX-033 Settings hierarchy checkpoint as
of 2026-07-16. It covers typed destinations, in-page discovery, command-palette
entry, focus/scroll routing, lifecycle behavior, responsive presentation, and
focused automated evidence. DUX-033 remains **IN PROGRESS** because effective
policy/inheritance, change attribution/history, every contextual product link,
and installed assistive-technology qualification are not complete.

## Product contract

Settings is one mounted document containing independent remote and local forms.
Discovery must never filter or unmount those forms. Search and category browsing
therefore select a typed route anchor; they do not replace the Settings DOM,
serialize a user's search, or persist search text.

The page now provides:

- a route-aware `Settings / category / destination` breadcrumb;
- eight stable task categories and all 35 routable Settings destinations;
- a local, bounded search index over labels, summaries, categories, and
  task-oriented synonyms such as `2FA`, `DNS`, `tray`, and `portable export`;
- keyboard selection with Arrow Up/Down, Enter, and Escape;
- an accessible combobox/listbox relationship, result count announcement,
  honest no-match state, one active-descendant focus model, IME-safe actions,
  automatic active-option reveal, visible focus, and forced-colors treatment;
- responsive one-column browsing below 700 CSS pixels;
- exact command-palette entries for every Settings destination, including
  non-rendered discovery terms that are not exposed as customer data;
- exact route serialization, reload/Back/Forward support, stable element IDs,
  scroll placement, same-anchor reactivation, and real canonically named `h2`
  focus targets for all 35 destinations;
- an in-place lifecycle exception for anchor-only Settings moves. Since every
  form remains mounted, these moves do not ask users to save or discard work.
  Any route change that can unmount work still uses the global fail-closed
  lifecycle coordinator.

## Typed hierarchy

| Category | Destinations |
| --- | --- |
| Getting started | Setup progress, Tour, Sample data |
| Account | Privacy, Security, Workspace sign-out/reset, Notifications, Dashboard email digest, Webhook alerts |
| Workspace | Slack, Archive domain, Region, Workspace profile |
| Team & access | Approval chain, Audit access |
| Plans & usage | Usage, Your plan |
| Data & privacy | Custom fields governance, Data privacy, Export retention, Data exports, Identifier transforms, Data retention |
| Developer & security | API connection, AI brand-voice gate, Outbound webhooks, Form firewall, Inactive API keys, Feature flags, API keys |
| Desktop app | Appearance, About, Desktop updates, Desktop window, Keyboard shortcuts |

`SETTINGS_ANCHORS` remains the router allowlist. The metadata record is checked
with TypeScript's exhaustive `Record<SettingsAnchor, ...>` contract, then
projected in router order. Adding or removing an anchor without updating the
information architecture is a compile-time failure. A focused test also proves
that every label round-trips through the canonical heading-to-anchor function
and every category remains populated.

The audit found and repaired one concrete completeness defect during this wave:
the rendered Desktop window section already declared
`data-settings-anchor="desktop-window"`, but the router did not allow that
anchor. It is now a first-class parse/serialize destination.

## Search, privacy, and security

The in-page Settings search is entirely deterministic and local. Its corpus
contains only static product copy. It does not call an API, write storage,
update the URL, emit telemetry, or include current form values. Input is limited
to 128 characters, Unicode-normalized, reduced to lowercase alphanumeric
tokens, and matched only against the static allowlist. Navigation receives a
`SettingsAnchor`, not an arbitrary path or query string.

The command palette uses the same metadata source. Navigation-only `/` queries
remain local; an unprefixed global-palette query may also fan out to existing
workspace entity-search APIs. Additional Settings keywords affect local ranking
but the rendered hint remains the stable category label. This keeps global
discovery complete without duplicating destination strings or introducing an
unvalidated route builder.

## Lifecycle and history policy

An anchor-only move is safe only when both routes are Settings routes and their
canonical forms are identical after removing `settingsAnchor`. That narrow
comparison prevents a tab, record, query, filter, sort, or overlay transition
from accidentally taking the in-place path.

The same rule is applied to direct navigation and browser-history transitions.
Back/Forward between Settings anchors restores the prior in-page destination
without opening an abandon-work dialog. Back/Forward from Settings to another
surface still rolls history back while the global lifecycle review is open and
resumes only after an explicit safe decision.

## Evidence checkpoint

The reconciled focused checkpoint passes 101 tests across 15 suites covering:

- route parsing/serialization and the complete anchor allowlist;
- direct and Back/Forward lifecycle behavior;
- source pinning for all public typed navigation helpers;
- exhaustive Settings metadata, category population, normalization, synonyms,
  ranking, input bounds, no-match behavior, and source discovery of every
  mounted literal Settings heading/explicit anchor;
- rendered breadcrumb/category/search/listbox semantics and keyboard actions;
- command-palette coverage for all 35 destinations, synonym result filtering,
  semantic combobox/listbox focus, bounded no-result navigation and IME safety;
- shell scroll ownership, human title/live-announcement labels, exact Account,
  Workspace, Dashboard and post-onboarding contextual routes; and
- loading-to-loaded Archive-domain heading identity/focus retention.

A production-source contract rejects literal generic Settings CTA calls and
hand-authored anchor URLs; shared navigation catalogs may still expose the
intentional top-level Settings destination dynamically.

Targeted ESLint and Stylelint are warning-free. Renderer-test TypeScript and
the exact function-quality gate pass. Full application and renderer-test
TypeScript are green on the reconciled shared tree, as is `git diff --check`.

The source-discovery test scans Settings-specific source files as a static
orphan-heading/anchor ratchet. It is deliberately not treated as runtime
availability evidence: role and deployment gates can still omit a destination.

## Remaining release work

- Show effective value, source, inheritance, override scope, and lock reason
  consistently for organization/workspace/account/device policies.
- Add durable, permission-aware change attribution and history for every
  server-owned setting, with safe rollback where the API supports it.
- Finish lifecycle ownership for any Settings editor or active mutation still
  listed by DUX-015; do not infer safety from this navigation work.
- Extend the contextual-link source rule to native/external producers and
  dynamically assembled action registries.
- Resolve permission/deployment-delayed anchor availability with an explicit
  unavailable reason rather than leaving a requested destination unresolved.
- Qualify the complete page at 880×560, 200–400% zoom/text scale, forced colors,
  reduced motion/transparency, keyboard-only use, VoiceOver, Narrator, and NVDA
  in the exact signed macOS and Windows packages.
- Run task-finding research across new users, workspace administrators, and
  assistive-technology users; adjust labels/synonyms from measured failures
  without changing stable anchors.
