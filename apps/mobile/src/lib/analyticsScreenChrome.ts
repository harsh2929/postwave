/**
 * lib/analyticsScreenChrome.ts — the PURE half of `app/(tabs)/analytics.tsx`.
 *
 * Split for the same reason `src/api/eventBus.ts` grew
 * `eventBusStream.ts`/`eventBusConnection.ts`: the screen is one long JSX
 * layout, and every non-JSX fact wedged between two `<CardBoundary>`s pushed
 * the component past the 300-line function budget while being untestable in
 * the node vitest environment, because the file it sat in imports
 * react-native.
 *
 * WHAT LIVES HERE: things with no React in them at all — the placeholder
 * payloads two self-gating sections require when their query has not settled,
 * the CardBoundary palette derivation, the array coercion every section's rows
 * pass through, and the screen's closing footnote copy.
 *
 * WHAT STAYS IN THE SCREEN: the layout itself, the header, and the footnote
 * component that renders the string below. Anything that calls a hook or
 * returns JSX belongs there, not here.
 *
 * This module must stay free of react-native/expo imports so it keeps running
 * under `vitest --environment node`.
 */
import type { ClvSummary } from "./clvSummary";
import type { SubscriberFunnel } from "./subscriberFunnel";

/**
 * The rows behind a section query, or an empty list.
 *
 * `query.data ?? []` is a NULLISH guard and every section ITERATES what it is
 * handed — `TopPerformersSection` maps its rows before its QueryStates ladder
 * even runs — so a truthy `{}` or `{items: []}` blew that section's
 * CardBoundary and replaced a chart with "couldn't be displayed". The queryFns
 * all normalise to arrays, so only a RESTORED persisted cache written by an
 * older response shape gets here; that is the same route by which
 * `app/(tabs)/api-keys.tsx` shipped "Invalid attempt to spread non-iterable
 * instance" in this repo.
 */
export function rowsOf<T>(value: readonly T[] | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * What the funnel card is handed before its query settles.
 *
 * `FunnelSection` self-gates on the step list rather than on a query flag, so
 * it needs a real (empty) funnel, not `undefined`.
 */
export const EMPTY_FUNNEL: SubscriberFunnel = { steps: [], cohortCount: 0 };

/**
 * What the customer-value card is handed before its query settles.
 *
 * Every field is `null` — NOT zero. A zero median is a measurement; a null one
 * is the absence of a measurement, and `clvUnavailableReason` reads exactly
 * that difference to decide between a number and a sentence.
 */
export const EMPTY_CLV_SUMMARY: ClvSummary = {
  profileCount: null,
  scoredProfiles: null,
  medianTotalCents: null,
  p90TotalCents: null,
  atRiskProfiles: null,
  atRiskAvgCents: null,
  lastCalculatedAt: null,
};

/** The three theme tokens every `<CardBoundary>` on the screen is given. */
export interface AnalyticsBoundaryColors {
  surface: string;
  border: string;
  text: string;
}

/**
 * The CardBoundary palette, derived once per render from the theme.
 *
 * Structural parameter rather than the theme type so this file needs no import
 * from `lib/theme`, which is a React context module.
 */
export function analyticsBoundaryColors(t: {
  surface: string;
  borderSubtle: string;
  fgMuted: string;
}): AnalyticsBoundaryColors {
  return { surface: t.surface, border: t.borderSubtle, text: t.fgMuted };
}

/**
 * The screen's closing footnote.
 *
 * Copy, not decoration: it states the three ways a number here can disagree
 * with the same number on the desktop (server-computed windows, device-local
 * dates, and the headline-only cohort comparison). Kept as a constant so it is
 * assertable without rendering react-native — and note the plain `'`, which is
 * what the JSX `&apos;` this replaced decoded to.
 */
export const ANALYTICS_FOOTNOTE =
  "Windows are computed on the server and end at the current moment. Dates " +
  "are shown in this device's timezone, so a send near midnight UTC can " +
  "appear on the neighbouring day. Cohort retention is shown as a headline " +
  "comparison, not the full week-by-week grid; that grid and the report " +
  "builder remain on the desktop app.";
