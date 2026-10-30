# Desktop data-table and collection contract

Status: foundation implemented; DUX-024 remains in progress

Owner: desktop design system and each collection owner

Last reconciled: 2026-07-16

## Authority and scope

`src/components/table/DataTable.tsx` is the qualified foundation for
decision-bearing tabular collections. It uses a native HTML table and a
controlled data model so visual alignment, screen-reader relationships,
sorting, selection, bulk actions, loading, empty state, and exported/server
order cannot disagree.

This foundation does not make every historical table qualified. Existing
`list-header`/`list-row` grids, one-off tables, interactive grids, calendars,
trees, feeds, and virtualized collections remain migration owners until the
implementation ledger names their evidence.

## Required behavior

- Every table has a concise visible title, a native caption, and an optional
  scope/refresh description associated with the overflow region.
- Column headers use `scope="col"`. Sortable headers publish controlled
  `aria-sort`; clicking the button requests the next order but never silently
  sorts a second local copy.
- Selection checkboxes name the represented object. Page selection excludes
  disabled rows, exposes mixed state, preserves selections outside the current
  page, and reports the total selected count.
- Bulk controls appear in a named region only when selection makes them
  applicable. Destructive actions retain the shared confirmation contract.
- A row is not itself a catch-all button. Navigation and mutations are named
  links or buttons in explicit cells, preventing nested-interactive ambiguity.
- Headers remain available during loading and empty states. Loading, request
  failure, empty data, filtered no-match, stale data, and access denial must
  remain distinct at the owning surface.
- Horizontal overflow is a labelled, keyboard-focusable region with stable
  scrollbar space. Sticky headers retain context; compact and comfortable
  density never reduce target or text accessibility below the app floor.
- Numeric columns align consistently and use tabular figures. Truncated text
  retains the complete value through visible expansion, a labelled action, or
  a non-secret title/accessible name.
- Forced colors preserves borders, focus, and selected rows. The full table
  remains usable at 200% zoom, text scaling, and the 880×560 minimum window.

## API contract

`DataTableColumn<Row>` owns a stable ID, header, cell renderer, optional sort
capability, alignment, width, and class. `DataTableSortState` is controlled by
the surface and contains a column ID plus `asc`/`desc`. Rows require a stable
key; array position is not an acceptable identity.

`DataTableSelection<Row>` owns the selected key set, atomic change callback,
human row label, optional disabled predicate, and page/scope label. Selection
is controlled so pagination, refresh, optimistic results, and server filters
can make retention policy explicit.

`DataTableExpansion<Row>` keeps disclosure content inside the native row
sequence as a labelled region with an optional stable region ID. The cell
action that opens it remains an ordinary button with matching
`aria-expanded`/`aria-controls`; expansion never turns the whole row into a
pseudo-button.

`DataTablePagination` owns a labelled navigation region, previous/next and
optional first/last actions, an exact or bounded page summary, busy state, and
an optional labelled page-size control. `DataTableLoadMore` is the distinct
cursor/additive pattern: it reports loaded/total counts and never pretends a
cursor stream supports random page navigation.

Column controls and bulk actions are caller-owned React content, but the
qualified table owns their placement and selection visibility. Row actions
remain ordinary cells so each domain can use its correct permission,
confirmation, lifecycle, and mutation state.

## Qualified migration waves

Nineteen source-pinned production surfaces now use the qualified native
primitive instead of visual-only `list-header`/`list-row` grids or incomplete
one-off tables:

- Deliverability blocklist hits, webhook delivery errors, DNS health, ISP
  breakdown, placement provider counts, authentication checks, frequency caps,
  intelligent retry events, and recent spam-trap hits;
- DMARC failing sources, Analytics revenue attribution, Privacy double-opt-in
  pending confirmations, compliance activation exclusions, API Playground
  headers, and the AI model changelog; and
- experiment control groups, the referral leaderboard, the template
  performance leaderboard, and the Track event catalog.

The migrations preserve exact object values, status badges, scope and rollup
copy, permissions, and named row actions. The Track catalog replaces its
row-wide pseudo-button with an explicit Filter/Selected cell action. Control
group reports use the native expansion contract and a labelled detail region.
Frequency caps, intelligent retry, spam-trap hits, control groups, both
leaderboards, the event catalog, and double-opt-in confirmations distinguish
initial loading from refresh failure and retain verified same-scope rows where
available. Range/window owners suppress rows from the previous scope while a
new scope loads, and request generations prevent late or unmounted reads from
winning.

Segments now uses the labelled page-pagination contract. The foundation also
exposes page-size and first/last controls for owners whose API and count model
can support them honestly. The audit log uses additive cursor controls, so its
UI does not claim random page navigation the API cannot provide.

## Automated evidence

The combined focused checkpoint passes 43 behavior/source/state tests across
seven DUX-024 files. The contained seven-surface wave contributes 13 of those
cases, and its broader helper/regression checkpoint passes 76 tests across
eight files. Together they cover:

- native caption, scoped headers, rows, explicit cell actions, and labelled
  overflow;
- controlled ascending/descending `aria-sort` and callback parity;
- named row selection, disabled-row exclusion, page selection, selected-row
  treatment, count announcement, and contextual bulk controls;
- persistent headers plus correctly spanned loading and empty status rows;
- native expansion regions, labelled page/page-size controls, first/last
  readiness, and additive cursor load-more semantics;
- centralized overflow, sticky, density, selection and forced-color CSS; and
- source-pinned migration of all nineteen named surfaces, explicit Event
  Catalog actions, same-scope refresh retention, scope-keyed leaderboards, and
  stale/unmount request invalidation.

Scoped ESLint passes. Frequency Caps is now below the default 300-line
per-function ceiling and no longer needs its legacy exception; Control Groups
is ratcheted from 489 to 376 lines and Track from 567 to 559. Renderer-test
TypeScript passes, and the table-owned app TypeScript checkpoint was green
before unrelated concurrent onboarding-storage errors appeared in the shared
tree. The qualified-table stylesheet remains unchanged; the wave only removes
the obsolete Track catalog-header selector. Stylelint and all four stylesheet
entry/cascade contract checks pass.

## Remaining DUX-024 boundary

DUX-024 may move to `IMPLEMENTED` only when every production collection is
inventoried and assigned the correct semantic pattern (table, list, tree,
grid, feed, or calendar); applicable surfaces migrate caption/header/sort/
selection/bulk/row-action/pagination/column/density behavior; virtualization
retains accessible position/count and focus; and broad source, unit, visual,
axe, type, lint, build, and large-account checks pass.

It may move to `VERIFIED` only after keyboard-only, VoiceOver, Narrator/NVDA,
forced-colors, 200% zoom/text scaling, minimum-window, horizontal panning,
large-page/virtualization, slow-refresh, offline, permission, and mutation
tasks pass against exact hash-bound signed macOS and Windows packages.
