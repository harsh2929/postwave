/**
 * segments/_layout.tsx — the segments family's push stack.
 *
 * Screens: `index` (the segments catalogue, reached from the More menu) →
 * `[id]` (segment detail). `[id]` is also the landing target of a search hit
 * (src/api/search.ts), which is a cold entry — hence `initialRouteName`.
 *
 * See src/components/EntityDetailStack.tsx for WHY this exists: before it, the
 * detail routes were siblings on the bottom-tab rail, so a drill-down was a tab
 * swap with no transition, no edge-swipe back and no list left underneath.
 *
 * The URL surface is untouched — /segments and /segments/… resolve exactly as
 * they did — so deep links, push payloads and web hand-offs are unaffected.
 *
 * No ErrorBoundary export here on purpose: a boundary on a LAYOUT catches a
 * child's throw and takes the child's siblings down with it, which is the
 * behaviour src/lib/routeErrorBoundary.consistency.test.ts exists to prevent.
 * Each screen below carries its own.
 */
import { EntityDetailStack } from "@/components/EntityDetailStack";

/**
 * Seeds the list UNDER a cold-start detail (LOVE#48). Opening
 * /segments/{id} from a notification, a universal link or the widget builds
 * [index, detail] rather than [detail] alone, so `router.canGoBack()` is true
 * and `goBackOr()` POPS to the list instead of REPLACING with a guess.
 *
 * Expo Router only reads `unstable_settings` from a layout module, so this is
 * the one file it can live in.
 */
export const unstable_settings = { initialRouteName: "index" };

export default function SegmentsStackLayout() {
  return <EntityDetailStack />;
}
