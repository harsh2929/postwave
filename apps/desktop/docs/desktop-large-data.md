# Desktop large-data and virtualization contract

Status: foundation and first Audit adoption implemented; DUX-041 remains in
progress

Owner: desktop performance and each large-collection owner

Last reconciled: 2026-07-16

## Scope

Large-data quality is not “make scrolling fast” in isolation. A qualified
surface must bound DOM, memory, CPU, request and parser work without hiding
position, losing focus, inventing totals, blocking cancellation, or replacing
an honest partial/failed result with an empty state.

`src/components/virtualization/WindowedList.tsx` is the first fixed-row
foundation. It is appropriate only when the owning surface can guarantee a
reviewed row height. Variable-height content, tables/grids with sticky column
relationships, trees, and editors require their own qualified patterns.

## Windowed-list contract

- The owner passes stable item keys; array index is never identity.
- A reviewed threshold keeps ordinary collections fully rendered. Windowing is
  introduced only when measured scale justifies its accessibility cost.
- Viewport rows plus bounded overscan are mounted. A focused row remains
  mounted separately if it scrolls out of view, so focus is never destroyed.
- Each rendered item exposes one-based `aria-posinset` and a truthful
  `aria-setsize`. Approximate server totals are not passed as exact set size.
- The labelled scroll region is keyboard focusable and uses stable scrollbar
  space, overscroll containment, and layout/paint containment.
- Dataset shrink clamps the old scroll position to the new range.
- Empty state is a normal, non-virtual status. Loading, refresh, stale, error,
  filtered no-match, partial page, end-of-results, and access denial remain
  owner-level orthogonal states.
- Forced colors preserves the focus boundary. Rendering introduces no motion.

## First adoption: Audit log

Audit keeps up to 200 loaded events fully rendered. At 201 it switches to a
52-pixel fixed-row window with a 420-pixel viewport and bounded overscan. Its
existing live-tail controller receives the actual virtual scroll element, so
buffering, “new events” recovery, and scroll-to-top behavior do not fork.

The cursor result controls remain additive (“Load more” / “Jump to end”), not
fake page navigation. Exact server totals become `aria-setsize`; approximate
counts remain visible progress copy but do not claim an exact set size.

## Automated evidence

The focused checkpoint covers eight large-data cases:

- a 10,000-item/12,000-total fixture renders at most 18 initial rows;
- scrolling to item 5,001 updates the window without growing beyond 19 rows;
- item 1 remains mounted and focused while off screen;
- native empty state remains outside the virtual list;
- the source contract pins overscan, focus retention, position/count,
  keyboard scrolling, containment, stable scrollbars and forced colors;
- Audit renders exactly 200 rows normally and windows the 201st; and
- Audit passes its exact total into the item-position contract.

The existing Audit page boundary/controller regressions also pass. Scoped
ESLint, Stylelint, stylesheet-entry order/hash, and both TypeScript checkpoints
belong to every reconciled run.

## Remaining DUX-041 work

- inventory every collection by realistic P50/P95/max rows, row height, total
  semantics, mutation frequency and task-critical keyboard behavior;
- qualify variable-height lists, native/virtual tables, grids, trees,
  calendars, feeds, selection and sticky context;
- add AbortSignal propagation for superseded filters/routes/exports and prove
  late responses cannot commit;
- move large CSV/JSON parsing and heavy aggregation to bounded workers or
  streaming APIs with progress, cancellation and retry;
- define renderer DOM/long-task/heap and installed native RSS/CPU/network
  ceilings for representative large accounts; and
- run the required 30-minute slow-network/offline/reconnect soak against exact
  signed macOS Intel/Apple Silicon and Windows artifacts, retaining traces,
  artifact hashes and reviewer results.

Only that complete source and installed matrix can move DUX-041 to `VERIFIED`.
