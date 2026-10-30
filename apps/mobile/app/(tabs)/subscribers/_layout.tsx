/**
 * subscribers/_layout.tsx — the subscribers family's push stack.
 *
 * Screens: `index` (the subscriber list, a PRIMARY bottom tab) → `[id]`
 * (the profile). The list is the app's longest scroll, so leaving it MOUNTED
 * beneath the profile — which is what a stack does and a tab swap cannot — is
 * the difference between returning to your place and returning to row one.
 *
 * See src/components/EntityDetailStack.tsx for WHY this exists: before it, the
 * detail routes were siblings on the bottom-tab rail, so a drill-down was a tab
 * swap with no transition, no edge-swipe back and no list left underneath.
 *
 * The URL surface is untouched — /subscribers and /subscribers/… resolve exactly as
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
 * /subscribers/{id} from a notification, a universal link or the widget builds
 * [index, detail] rather than [detail] alone, so `router.canGoBack()` is true
 * and `goBackOr()` POPS to the list instead of REPLACING with a guess.
 *
 * Expo Router only reads `unstable_settings` from a layout module, so this is
 * the one file it can live in.
 */
export const unstable_settings = { initialRouteName: "index" };

export default function SubscribersStackLayout() {
  return <EntityDetailStack />;
}
