# Moosewave Analytics — 2026 Gap Analysis

This document captures the gap between Moosewave's current Analytics surface and the 2026 industry state-of-the-art across ESP analytics (Klaviyo, Mailchimp, Customer.io), product/BI tooling (Mixpanel, Amplitude, Looker, PostHog), and cross-cutting agentic analytics patterns. Gaps are ranked by impact so we can sequence the next quarters of work against the highest-leverage investments first.

## Current state

What ships today on `apps/desktop/src/pages/Analytics.tsx` and its sibling components:

- **Header shell** — sticky header with title/subtitle and a right-aligned action cluster (live badge, vs-prev toggle, range chips, refresh, saved views, export).
- **Time range chips (7d / 30d / 90d)** — drive every range-aware fetch (dashboard stats, timeseries, replies, top responders) and sync via `#analytics?range=...`.
- **vs-previous comparison toggle** — flips KPI cards between hint text and delta deltas; auto-disables when `campaigns_sent == 0`.
- **Live SSE indicator with staleness tiers** — `/dashboard/live` stream, color-coded Live / Behind (>60s) / Reconnecting (>300s) / Connecting / Offline pill with a 1Hz "Xs ago" counter that pauses on tab hidden.
- **Refresh button** — manual re-fetch of the whole range, sequence-numbered via `loadSeqRef` so stale results from older clicks are discarded.
- **Saved Views menu** — localStorage-persisted named `{range, vsPrevious}` combos with save/apply/delete and a "View · <name>" label when the current state matches.
- **Export menu** — CSV snapshot (tenant-wide overview + per-campaign rows for recent 5) and Print/PDF via `window.print()` with scoped print CSS.
- **InsightsStrip** — up to 4 rule-based callouts (anomaly flags, complaint-rate red line >0.1%, period-over-period rate moves ≥5pp, top performer at ≥130% of fleet avg). Per-insight dismissal persisted to localStorage.
- **Drill-down deep-linking** — reads `#analytics?metric=opens&range=30d` on mount, seeds the range chip, scrolls to the matching `KpiCard` via `data-kpi-metric`, applies a 2.5s `is-drilldown-highlight` class.
- **KPI grid (8 cards)** — Subscribers, Open / Click / Reply / Bounce rate, Unsubscribes, Deliverability score, conditional Revenue. Each card has label / value / hint / sparkline / delta vs prev / anomaly badge / `InlineHelp` tooltip.
- **KpiCard** — headline value, optional sparkline (color-flipped on inverted-metric increases), delta% vs previous with up/down/flat classes, optional anomaly chip, optional `valueAccent` for derived score, `metricKey` for drill-down highlight.
- **Skeleton loading state** — 8 `SkeletonStatCard` placeholders + progress bar while `stats` is null on first load.
- **Hero empty state** — `HeroEmptyState` for zero-data workspaces (no campaigns sent and no subscribers).
- **Error banner with retry** — gating `dashboard/stats` failure surfaces as a notice banner; non-gating endpoint failures surface as toasts so the page stays partially usable.
- **Inverted-metric handling** — `deltaClass` flips green/red for bounce/unsub cards (increases are bad); sparkline tints red when an inverted metric rises.
- **Deliverability composite score** — derived `100 - bounceRate - 30*complaintRate - 2*unsubRate`, banded good (≥90) / warn (≥75) / bad; surfaced as a KPI card and in the deliverability health section.
- **Anomaly badge per KPI** — backend `/dashboard/stats` returns an anomalies record; cards render an "anomaly" chip with tooltip explaining the >2σ rule.
- **Sparklines per metric** — 120x26 inline sparkline from `stats.sparklines[<key>]` for subscribers/opens/clicks/bounces; replies derived from `repliesTs.points`.
- **InlineHelp tooltips on KPI labels** — hoverable explainers on Open rate (MPP caveat), Click rate (CTR vs CTOR), Reply rate (In-Reply-To matching), Deliverability score formula, plus most chart titles.
- **Subscriber growth full-width line chart** — daily snapshot from `/subscriber/timeseries` with range-aware `xTickStride` (1/5/15).
- **Engagement velocity multi-line chart** — opens / clicks / replies daily series, date axis synthesized client-side from `today - days`.
- **Sent → Delivered → Opened → Clicked funnel** — aggregate engagement funnel with conversion% between steps; empty-state when `campaigns_sent == 0`.
- **Campaign performance bar chart + drill chips** — opens/clicks bars for the 5 most recent campaigns + clickable drill chips that open `CampaignAnalyticsSlideover`.
- **Benchmark verdict badges** — above / on par / below baseline pills for the latest campaign vs trailing 90-day baseline.
- **Campaign comparison card** — multi-select side-by-side rate matrix across all-campaign candidates with best/worst per column (invert-aware) and a 6-campaign cap.
- **Mail-client donut** — top 6 mail clients by opens across the 5 most recent campaigns.
- **Top countries bar list** — hand-rolled horizontal bars (no map) for top 7 countries by opens with opens/clicks tabular column.
- **Top links list** — top 8 URLs across recent campaigns sorted by total clicks, with clicks + unique clickers and mini bars.
- **Deliverability health card** — hard/soft/spam-trap bounce donut, bounce/complaint/score tabular grid, red callout banner when `complaintRate ≥ 0.1%`.
- **Conversations** — total replies / matched / unique responders summary + top 6 responders with last-reply date.
- **Cohort retention heatmap** — signup-month × weeks-since-signup open-rate heatmap (max 8 weeks) from `/cohorts?bucket=month&metric=open_rate` with defensive envelope-unwrap.
- **Top sequence funnel** — step-by-step reach/opens/clicks with drop-off% for the first sequence returned by `/sequences`.
- **Per-campaign drill-down slideover** — `CampaignAnalyticsSlideover` triggered from drill chips; fires 7 parallel requests, surfaces 4 stat tiles, funnel, benchmark grid, top links, mail clients donut, top countries bars, bounce mix donut, revenue tile, and "Download per-recipient CSV" link.
- **Revenue (recent) KPI card** — conditional KPI summing attributed revenue across the 5 most recent campaigns using `Intl.NumberFormat` with per-campaign currency (defaults USD).
- **Race-safe load sequence** — monotonic `loadSeqRef` discards results from in-flight loads when a newer range change/refresh fires; per-section toast fallback for partial fetch failures.

## 2026 industry SOTA

### ESP analytics (Klaviyo / Mailchimp / Customer.io)

- **Cohort retention heatmap** with selectable bucket (week/month/quarter) and metric (open / click / retention / revenue) — Klaviyo Advanced KDP, Mailchimp.
- **Revenue & predicted-LTV attribution** per campaign/flow with retroactive attribution windows and an `attribution-model picker` (first-touch / last-touch / linear / time-decay / data-driven) — Klaviyo, Mailchimp, SegmentStream.
- **Predictive churn / disengagement scoring** with one-click "send win-back to these N at-risk" hand-off — Mailchimp predictive engagement, Klaviyo CLV/churn-risk.
- **Per-domain (Gmail / Yahoo / Outlook / iCloud) deliverability** split with reputation timeline, SPF/DKIM/DMARC widget, and Gmail/Yahoo 0.3% complaint threshold callout — Klaviyo, Mailchimp, Landbase.
- **Subject-line A/B winner with statistical significance + auto-promote** of the winning variant to remaining audience — Klaviyo, Mailchimp, HubSpot.
- **Per-step send-time RL** that picks each recipient's best moment for each step of a sequence — Adobe Journey Optimizer, Klaviyo STO.
- **Multi-channel unified performance view** spanning email + SMS + push + in-app on a single dashboard — Mailchimp Refreshed Marketing Dashboard, Klaviyo.
- **Holdout group lift measurement** — persistent control cohort, incremental-lift math, audience-level confidence intervals — Iterable universal holdout, Customer.io.

### BI / product analytics (Mixpanel / Amplitude / Looker / PostHog)

- **Natural-language Q&A** ("Ask Amplitude" / Mixpanel AI / Looker Conversational Analytics GA April 2026 / PostHog AI) as the default entry point for new charts.
- **AI-generated insight cards** on the home dashboard with explanations and Slack/email push (Amplitude Dashboard Monitoring Agent, PostHog AI prompts).
- **"Explain this chart" Q&A** on every visualization (Looker Dashboard Agents, Mixpanel AI inline).
- **Multi-step funnel builder** with per-step conversion windows and `branch attribution` (Mixpanel, Amplitude, Heap, Mitzu).
- **Retention heatmap with cohort segmentation** — D1/D7/D30 grid, behavioural cohorts, predictive AI overlay.
- **Threshold + anomaly alert policies** — static thresholds AND baseline anomaly detection delivered via Slack/email/webhook (Datadog, CloudWatch, Amplitude, Mixpanel).
- **Scheduled email/Slack digests** at hourly/daily/weekly/after-refresh cadence with PDF / image / CSV / inline-HTML and AI-enriched summaries.
- **Custom metrics / formula / SQL semantic layer** — Looker LookML AI Agent, Mixpanel Custom Events & Formulas, PostHog HogQL endpoints.
- **Pivot-to-row drilldown** — click a funnel drop-off, see the users; jump to session recordings (Mixpanel cohorts, PostHog, Heap).
- **Agentic BI** — Looker BI Agents trigger downstream actions grounded in the semantic layer; Amplitude experimentation agent designs / launches / decides rollout.
- **Behavioral cohort builder** ("users who did X more than N times") as first-class shareable objects that drive both charts and downstream targeting.
- **Brush-to-zoom time picker** with synced date range across every chart on the page, URL-persisted.
- **Linked highlighting / cross-filtering** — click a country bar, watch every other chart filter to it (Dotdigital, Sigma, Tableau).

### Cross-cutting

- **Brief-to-canvas sequence generation** with per-step copy auto-drafted in brand voice and AI-suggested branch conditions from segment history.
- **Multi-touch attribution overlay (MTA + MMM reconciliation)** with model comparison (first-touch / last-touch / linear / time-decay / data-driven) — adopted by ~47% of marketing teams in 2026.
- **Bot-click and privacy-pixel filtering** with per-event trust scoring feeding all downstream metrics, A/B tests, and sequence advancement.
- **Audience overlap analysis** across concurrent sequences with per-subscriber "currently active in" badges and centralized frequency caps.
- **Cohort engagement decay & sunset policy automation** with marketer-visible "these N subscribers will be suppressed next week" call-outs.
- **Chart annotations + auto event markers** so spikes in time-series carry context (campaign sends, sequence starts, Black Friday push).
- **Sticky / pinned toolbar** so range, vs-prev, refresh, and export controls stay reachable on long dashboards.
- **MCP / agent-callable analytics** (Mixpanel MCP server, Braze native MCP) so a copilot can author and inspect dashboards from chat.
- **Accessibility annotations on charts** — role=img + aria-label, focus-visible on menus, aria-live for range changes, keyboard navigation across chips and KPI cards.

## Gaps ranked by impact

### 1. Custom date range with calendar picker  [effort: m / impact: high]
**What:** Add a calendar-based custom range picker alongside the existing 7d/30d/90d chips, with smart presets (today, yesterday, this/last week, MTD, QTD, YTD, last 12 months, custom from/to).

**Why:** Three fixed presets is the single biggest 2026 expectation gap on the toolbar — every modern dashboard defaults to a calendar with smart presets so users can investigate specific windows (a single send, a holiday week, a quarter close).

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/analytics/DateRangePicker.tsx` (new)
- `apps/desktop/src/components/analytics/SavedViewsMenu.tsx`

**Acceptance:**
- Toolbar shows "Custom..." option that opens a two-month calendar with from/to selection and 9+ smart presets
- Selected custom range syncs to the URL hash (`#analytics?from=YYYY-MM-DD&to=YYYY-MM-DD`) and is restorable on reload
- All range-aware fetches (stats, timeseries, replies) honor the custom window and the live-badge tick reflects the chosen range
- Saved Views can persist a custom range, not just the three presets

### 2. Prior-period overlay on charts  [effort: m / impact: high]
**What:** When "vs previous" is on, render a dashed ghost line of the prior-period series on every line/multi-line chart (subscriber growth, engagement velocity, sparklines), not just delta arrows on KPI cards.

**Why:** The comparison toggle currently only affects 8 KPI cards while 9 charts ignore it; visual ghost-overlays are how 2026 dashboards make "this week vs last week" instantly readable without context-switching.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/charts/LineChart.tsx`
- `apps/desktop/src/components/charts/MultiLineChart.tsx`
- `apps/desktop/src/components/charts/Sparkline.tsx`

**Acceptance:**
- `LineChart` and `MultiLineChart` accept an optional `priorSeries` prop and render it as a 1px dashed line at 50% opacity
- Sparklines render a 1px dashed prior line when `vsPrevious` is true and prior data is available
- Chart legends gain a "Previous period" swatch when overlays are active, with an aria-label describing the date range
- Toggle off cleanly removes the dashed lines without re-fetching

### 3. Page-wide breakdown / group-by  [effort: l / impact: high]
**What:** Add a "Group by" selector (list, segment, country, mail-client, device) in the toolbar that splits every chart and KPI into per-group series instead of an aggregate.

**Why:** Aggregate-only views hide the actual story (new vs 90-day subscribers, gmail vs outlook deliverability, mobile vs desktop engagement) — 2026 product analytics tools all support arbitrary breakdowns and marketers export to CSV to compensate when they don't.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/analytics/GroupByMenu.tsx` (new)
- `apps/desktop/src/lib/api-client.ts`
- `apps/desktop/src/components/charts/MultiLineChart.tsx`

**Acceptance:**
- Toolbar exposes a "Group by" dropdown with 5 dimensions plus "None" (default)
- When a dimension is chosen, subscriber growth, engagement velocity, and bounce donut switch to per-series rendering with a max of 6 groups shown plus an "Other" rollup
- KPI cards show a small per-group breakdown bar under the headline value when grouped
- Group-by selection is hash-syncable and saved-views compatible

### 4. Sticky toolbar on scroll  [effort: s / impact: high]
**What:** Pin the Analytics header (range chips, vs-prev toggle, refresh, live badge, export) to the top of the viewport once the user scrolls past it, with a condensed height variant.

**Why:** The current page is ~10 sections long and the toolbar scrolls away with the page, so users lose access to range/refresh/export controls below the fold and must scroll all the way up just to switch from 7d to 30d.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/styles.css`

**Acceptance:**
- Header becomes `position:sticky` with a backdrop-blur background once the user scrolls past its initial offset
- Subtitle and `InsightsStrip` collapse out of the sticky pane while range chips, vs-prev, refresh, and live badge stay
- Sticky variant has a 1px bottom border and a slightly reduced vertical padding (44px vs 64px)
- Sticky behavior disabled at narrow viewports (< 768px) to avoid eating mobile screen real estate

### 5. Range-aware aggregate cards  [effort: m / impact: high]
**What:** Make the Mail-clients donut, Top countries bar list, Top links list, Deliverability health card, and Revenue KPI honor the current range chip instead of always aggregating across the 5 most recent campaigns.

**Why:** The header comment explicitly admits these cards aren't range-scoped, so changing 7d to 90d only refreshes half the page — a correctness gap that silently breaks user mental models and exports.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/lib/api-client.ts`

**Acceptance:**
- Recent-campaigns loop filters by `send_at` within the selected range (or its custom from/to) rather than a hard count of 5
- Each affected card section subtitle reads "In the last <N> days" instead of "Across recent campaigns"
- Empty range (no sends in window) shows a per-card "No campaigns in this range" state instead of stale data
- Range change re-runs the per-campaign fan-out under the same `loadSeqRef` race guard already in place

### 6. Cohort heatmap dimension switcher  [effort: s / impact: mid]
**What:** Add dropdowns above the cohort heatmap to swap bucket (week / month / quarter) and metric (open rate / click rate / reply rate / retention / revenue per cohort).

**Why:** The heatmap is hard-coded to `bucket=month`, `metric=open_rate`, 8 weeks — a single perspective on the most powerful retention chart in the page; switching metrics is how marketers spot whether engagement decay is opens, clicks, or revenue.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/lib/api-client.ts`
- `apps/desktop/src/components/charts/Heatmap.tsx`

**Acceptance:**
- Two dropdowns (bucket, metric) render above the heatmap and call `/analytics/cohorts` with the chosen params
- Color scale legend updates to reflect the metric range (0-100% for rates, $ for revenue)
- Selected bucket/metric persists in the URL hash and survives reload
- Defensive shape coercion (`CohortRow[]` vs `{items:[]}`) continues to work for all metric variants

### 7. Per-domain deliverability split  [effort: m / impact: high]
**What:** Add a per-domain (Gmail / Yahoo / Outlook / iCloud / Other) breakdown card showing open rate, bounce rate, and complaint rate by recipient domain, with the Gmail/Yahoo 0.3% complaint threshold highlighted.

**Why:** Post-Feb 2024 Gmail/Yahoo sender requirements made per-domain reputation life-or-death, and a single aggregate complaint number hides the case where Yahoo is at 0.4% (about to blocklist) while Gmail is fine.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/lib/api-client.ts`
- `apps/desktop/src/components/charts/BarChart.tsx`

**Acceptance:**
- New "Inbox provider health" card renders below "Deliverability health" with a row per top-5 domain
- Each row shows open rate, bounce rate, complaint rate with a red bar when complaint >= 0.3% (Gmail/Yahoo threshold)
- Domains are derived client-side from recent-campaign report data by splitting on `@` in recipient hashes (or a new `/campaigns/{id}/domain-breakdown` endpoint if hashes aren't available)
- Card has an `InlineHelp` tooltip explaining the 0.3% Postmaster rule

### 8. Chart annotations + send markers  [effort: m / impact: mid]
**What:** Auto-overlay vertical event markers on time-series charts at the moment of each campaign send (and sequence start), with hover tooltips showing campaign name; allow users to drop manual annotations ("Black Friday push", "sender warmup").

**Why:** Charts have spikes today with zero explanation — automatic send markers turn "why did opens spike on the 12th" into a one-glance answer and manual annotations let teams capture institutional knowledge inline rather than in a separate doc.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/charts/LineChart.tsx`
- `apps/desktop/src/components/charts/MultiLineChart.tsx`
- `apps/desktop/src/components/analytics/AnnotationsLayer.tsx` (new)

**Acceptance:**
- Time-series charts render a thin vertical line at each campaign's `send_at` within the visible window, with a small dot at top
- Hover surfaces a tooltip with campaign name, type, and a link to its analytics slideover
- Marketers can right-click any chart point to "Add annotation" which stores label + date in localStorage (server later) and renders as a labeled tag
- Toggle in toolbar to show/hide annotations and send markers independently

### 9. Per-chart export menu  [effort: m / impact: mid]
**What:** Add a small overflow menu on each chart card (CSV of the underlying series, PNG screenshot via SVG-to-canvas, "copy link to this section") in addition to the global `ExportMenu`.

**Why:** Today export is all-or-nothing (whole-page CSV or whole-page print), forcing users to screenshot manually when they want to share one chart in Slack — a per-chart export reduces friction on the most common share workflow.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/analytics/ChartActions.tsx` (new)
- `apps/desktop/src/components/charts/LineChart.tsx`
- `apps/desktop/src/components/charts/MultiLineChart.tsx`

**Acceptance:**
- Every chart card gains a 3-dot menu in the top right with three actions: Download CSV, Download PNG, Copy link
- CSV download contains the exact series the chart rendered with ISO dates and a header row
- PNG download serializes the SVG to a 2x-resolution canvas and triggers a file download named `<chart-name>-<range>.png`
- Copy link sets the URL hash to scroll-target the chart section on reload (`#analytics?focus=engagement-velocity`)

### 10. Configurable KPI strip  [effort: m / impact: mid]
**What:** Let users hide, reorder (drag-and-drop), and pick which 4-8 KPI cards show in the strip, with the choice persisted per workspace (initially localStorage, server later).

**Why:** The 8 cards are hard-coded JSX so a team that doesn't track revenue or doesn't care about reply rate is stuck with dead cards; configurability is a 2026 baseline expectation and a low-effort polish that respects user attention.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/analytics/KpiConfigMenu.tsx` (new)

**Acceptance:**
- A small gear icon at the end of the KPI strip opens a config popover listing all 8 metrics with visibility checkboxes and drag handles
- Layout persists to localStorage as an ordered visibility list and is restored on mount
- Strip auto-reflows to 4-column grid when 4 are shown, 3-column when 6, 4-column when 8
- Reset link in the popover restores the default order and visibility

### 11. Statistical significance on compare  [effort: s / impact: mid]
**What:** On the `CampaignCompareCard`, compute a chi-square (or two-proportion z-test) per metric between best and rest, and tag the "best" chip with a confidence badge (95% / 99%) or "not significant" when sample sizes overlap.

**Why:** Today two campaigns with overlapping CIs both show winners regardless of sample size, which encourages bad decisions — adding stat-sig is what separates A/B-testing from looking-at-numbers and is the 2026 bar for any compare surface.

**Touch points:**
- `apps/desktop/src/components/analytics/CampaignCompareCard.tsx`
- `apps/desktop/src/lib/stats.ts` (new)

**Acceptance:**
- Pure-JS two-proportion z-test helper added in `lib/stats.ts` with unit-test-ready signature `ztest(p1, n1, p2, n2)`
- Each "best" chip shows a small confidence badge (95% / 99% / NS) computed against the next-best campaign
- Hovering the badge reveals a tooltip explaining the p-value and the sample sizes used
- When fewer than 100 sends per campaign, badge reads "low sample" instead of a false-positive winner

### 12. Time-of-day engagement heatmap  [effort: m / impact: mid]
**What:** Add a 7x24 hour-of-week heatmap of opens (and a tab for clicks) aggregated from recent-campaign reports, with the user's local timezone shown in the title.

**Why:** Send-Time Optimization lives on a separate page, but a peek heatmap on the headline Analytics view is how marketers spot "Tuesday at 10am is my sweet spot" without leaving the dashboard — table-stakes since Mailchimp shipped it years ago.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/charts/Heatmap.tsx`

**Acceptance:**
- New "Engagement by time" card renders a 7-row x 24-column heatmap of opens (with a tab for clicks)
- Cells are colored on a sequential ramp with the max-engagement cell labeled "Peak" and tooltipped
- Title includes the detected browser timezone (e.g., "America/New_York")
- Empty-state when no opens in the range explains "send at least one campaign to populate this view"

### 13. Engagement distribution histogram  [effort: m / impact: mid]
**What:** Render a histogram bucketing subscribers by engagement-score band (highly engaged / engaged / dormant / lapsed) derived from opens in the last 30/90 days, plus a headline "<N>% of your list hasn't opened in 90 days".

**Why:** Aggregate open rate masks the long tail of dead weight hurting deliverability — a distribution view tells marketers "sunset 18,400 dormant subscribers" instead of guessing, and pairs with the deliverability score the page already computes.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/charts/BarChart.tsx`
- `apps/desktop/src/lib/api-client.ts`

**Acceptance:**
- New "Subscriber engagement" card renders a 4-bucket histogram (highly engaged / engaged / dormant / lapsed)
- Card header shows the percent of subscribers in "dormant + lapsed" as a single high-contrast number
- Clicking a bucket deep-links to the Subscribers page with the corresponding filter pre-applied (e.g., "last open > 90d")
- Buckets are computed from existing `/subscribers` list + per-subscriber `last_open` timestamp; no new endpoint required if `last_open` is on the existing payload

### 14. Accessibility on charts and controls  [effort: s / impact: mid]
**What:** Add `role=img` + `aria-label` data summaries to every SVG chart, focus-visible styling to the saved-views/export menus, aria-live announcements for range changes, and keyboard navigation across range chips and KPI cards.

**Why:** Charts are hand-rolled SVG with no accessibility annotations, so screen readers see nothing — a single A11y sweep brings the most-viewed surface up to the same bar as the slideover and is a real risk for B2B/enterprise procurement reviews.

**Touch points:**
- `apps/desktop/src/pages/Analytics.tsx`
- `apps/desktop/src/components/charts/LineChart.tsx`
- `apps/desktop/src/components/charts/MultiLineChart.tsx`
- `apps/desktop/src/components/charts/BarChart.tsx`
- `apps/desktop/src/components/charts/Donut.tsx`
- `apps/desktop/src/components/charts/Heatmap.tsx`
- `apps/desktop/src/components/charts/Funnel.tsx`

**Acceptance:**
- Each chart SVG has `role=img` and `aria-label` that summarizes the data (e.g., "Subscriber growth: 1,240 to 1,890 over 30 days, +52%")
- Range chips form a roving-tabindex group and respond to `ArrowLeft`/`ArrowRight`, with the active chip announced via `aria-live=polite`
- Saved Views and Export menu items have visible focus-visible outlines and respond to `ArrowUp`/`ArrowDown`
- axe-core scan on the Analytics page reports zero serious/critical violations
