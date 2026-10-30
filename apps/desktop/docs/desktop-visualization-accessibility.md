# Desktop visualization accessibility and data-integrity contract

Status: shared foundation implemented; DUX-025 remains in progress

Owner: desktop design system and each data-surface owner

Last reconciled: 2026-07-16

## Product contract

A visual chart is never the only representation of a measurement. Every dense
or decision-bearing visualization must expose the same information through an
exact semantic representation and must identify where the data came from.
Color, pointer hover, shape geometry, animation, and an inferred zero are not
acceptable substitutes for data.

For every chart, heatmap, distribution, funnel, quota, or proportional strip:

- the visible context names the metric and its unit;
- a concise summary states the represented scope, trend, and limitations;
- keyboard and pointer inspection announce the same point values;
- categories have a non-color marker, hatch, dash, label, or native table
  equivalent;
- missing, invalid, loading, empty, stale, and failed data remain distinct;
- the exact displayed matrix is available as a native HTML table or grid;
- exports use the same matrix and record source, scope, source timestamp (or an
  honest `Not supplied`), and export timestamp;
- CSV is saved through the centralized file-transfer service with an explicit
  privacy classification; and
- forced colors, reduced motion, narrow containers, zoom, and text scaling do
  not remove the authoritative representation.

## Shared architecture

`src/components/charts/AccessibleChartData.tsx` owns the common disclosure,
native table, provenance, transfer, and CSV behavior. Its
`RequiredChartSupportProps` type makes source, explicit `asOf`, filename, and
privacy mandatory for dense shared charts. An absent source timestamp must be
represented as `asOf: null`; callers must never manufacture export time as
data freshness.

The current shared primitives are:

| Primitive                      | Authoritative nonvisual representation                         | Operable visual behavior                                            |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `BarChart`                     | Exact category × visible-series table and CSV                  | Focusable bars, arrow-key inspection, patterns and markers          |
| `LineChart`                    | Date/value table and CSV                                       | Left/right/home/end point inspection; missing samples are gaps      |
| `MultiLineChart`               | Date-key union × visible-series table and CSV                  | Keyboard date inspection; toggle/solo legend; distinct dashes       |
| `Donut`                        | Category/value/share table and CSV                             | Native legend buttons and shape markers                             |
| `Funnel`                       | Stage/value/secondary/conversion table and CSV                 | Native ordered stage list; geometry is supplemental                 |
| `Heatmap`                      | Native keyboard grid, including cohort size, plus matching CSV | Arrow/home/end grid navigation and announced cells                  |
| `CategoricalDistributionChart` | Category/value/share table and CSV                             | Native legend/actions; patterned proportional bar is decorative     |
| `EngagementSparkline`          | Delegates to the multi-line contract                           | Opens/clicks date inspection and exact export                       |
| `Sparkline`                    | Spoken trend summary and point inspection                      | Arrow/home/end inspection; dash semantics; invalid samples are gaps |

`src/components/charts/dux-025-visual-manifest.ts` binds custom visual owners
to a title, unit, endpoint family, scope, and explicit source timestamp. New
custom visuals must be added to that manifest or replaced by a shared
primitive. Supplemental SVGs and magnitude bars must be `aria-hidden`; they
may not introduce data absent from their native table/disclosure.

The reconciled manifest currently governs 29 decision-bearing surfaces across
webhooks, engagement, portfolio mixes, MCP quotas/status/hourly calls,
segments, cohorts, campaign comparison, fatigue, benchmarks, goals,
lifecycle/demographic/catalog/prediction analytics, referrals, privacy,
plans/sends/custom fields, and sending-rate limits. Runtime source timestamps
are retained where APIs provide them; every other owner passes an honest
`asOf: null`.

Compact `Sparkline` remains lightweight by default but supports opt-in exact
table/provenance/confidential-export disclosure; MCP calls/hour is the first
adoption. `RateBar` is deliberately supplemental and hidden from assistive
technology because every live caller renders its exact, heterogeneous value
immediately beside the bar.

## Data-integrity rules

### Missing and invalid measurements

- `NaN`, infinite, negative-where-impossible, absent date samples, and failed
  subrequests render as `No data` or an unavailable state.
- A missing value must never be coerced to zero. Lines split into separate
  segments and table/CSV cells remain blank or explicitly unavailable.
- An all-invalid dataset is an unavailable/empty state with provenance still
  discoverable; it is not an all-zero success state.
- Multi-series points join by their date keys. Array positions are not assumed
  to describe the same date.
- Hiding a series updates the visible chart, table, summary, tooltip, live
  announcement, and export together.

### Provenance and export

- `source` is a human-readable service or endpoint family and must not contain
  credentials or tenant-secret query parameters.
- `scope` describes the active workspace, filters, date range, cohort, or
  selection represented by the rows.
- `asOf` is a server-supplied freshness time. Use `null` if the API supplies no
  authoritative time.
- `note` records sampling, truncation, timezone, or another material caveat.
- Every string cell in the complete CSV matrix—including title, source, scope,
  headers, and row labels—is neutralized against spreadsheet formula
  injection before RFC-style CSV escaping.
- The centralized transfer service owns save-picker, cancellation, collision,
  privacy, and installed-app behavior. Chart code must not create an anchor,
  blob URL, or ad-hoc canvas CSV path.

## Interaction and responsive behavior

- Inspectable SVGs are focusable, have a meaningful accessible name, and use
  Left/Right plus Home/End. Dense bars additionally support vertical arrows
  where that matches the visual axis.
- Focus and pointer inspection share one active value and a polite live
  region. Repeated layout changes must not generate announcements.
- Legends that change visible data are native buttons with pressed state.
- Container queries, not viewport assumptions, stack donut/funnel/legend
  layouts in narrow panels.
- `prefers-reduced-motion` removes nonessential chart transitions.
- `forced-colors` preserves outlines, focus indicators, patterns, markers, and
  authoritative text/table access.
- The semantic table remains the source of truth at 200% zoom, 880×560, text
  scaling, and when a visual has insufficient drawing space.

## Authoring checklist

When adding or changing a data visualization:

1. Choose the smallest existing primitive that represents the data honestly.
2. Pass a user-facing `title`, exact `valueLabel`/unit, provenance with
   explicit `asOf`, deterministic CSV filename, and transfer privacy.
3. Model loading, request failure, partial failure, empty, invalid, and one
   point separately before drawing geometry.
4. Verify the native table and CSV are derived from the same normalized rows as
   the visual. Include secondary labels, cohort sizes, hidden-series state, and
   missing values.
5. Add a non-color identity and keyboard path. Mark any redundant geometry
   `aria-hidden`.
6. Add or update the custom-visual manifest and contract test if the surface is
   not entirely represented by a shared primitive.
7. Exercise pointer, keyboard, screen-reader name, live announcement, 200%
   zoom, narrow container, forced colors, reduced motion, export cancellation,
   save failure, and formula-bearing tenant labels.

## Automated evidence

The reconciled visualization checkpoint passes 13 files and 80 tests. It
covers:

- summary/table/export/provenance parity across all dense primitives;
- keyboard inspection and live announcements;
- date-key joining and visible-series export parity;
- missing/invalid samples without `NaN` geometry or invented zeroes;
- heatmap grid and cohort-size export;
- empty funnel attribution and export discovery;
- non-color patterns, dashes, markers, and source-bypass prevention;
- whole-matrix spreadsheet-formula neutralization;
- all 29 custom visual owners, honest request-state behavior, exact timestamp
  handling, compact Sparkline disclosure, supplemental RateBar parity, and
  intentional non-chart exclusions; and
- the DUX-011 keyboard-equivalent, segment-growth, and analytics-boundary
  regressions.

Scoped production and test ESLint passes with the default 300-line function
limit and a complexity ceiling of 50. Stylelint, desktop application
TypeScript, and renderer-test TypeScript are part of the moving-tree checkpoint
and must be rerun after concurrent owner waves settle.

The source-bypass contract currently permits `role="img"` only inside the
qualified shared primitives, requires remaining quantitative SVGs to be
supplemental/hidden, prevents a second CSV canvas path, and pins the
container-query, reduced-motion, and forced-colors source contract.

## Remaining DUX-025 boundary

DUX-025 may move to `IMPLEMENTED` only after the residual source scan proves
every production quantitative visual either uses a qualified primitive, has a
manifest-backed exact equivalent, or is a documented non-chart/supplemental
exclusion; broader compact-Sparkline adoption is proportionate; and the full
renderer/build/data-gate checkpoint is green.

It may move to `VERIFIED` only after the exact hash-bound signed macOS and
Windows packages pass keyboard-only task completion, VoiceOver and
Narrator/NVDA reading, forced colors, reduced motion, 200% zoom/text scaling,
minimum-window/container layouts, export/save cancellation and denial, and
large-data performance qualification. Browser source tests do not substitute
for that installed evidence.
