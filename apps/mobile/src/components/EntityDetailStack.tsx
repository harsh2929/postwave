/**
 * EntityDetailStack — the navigator every entity family mounts between the
 * bottom-tab rail and its own screens.
 *
 * WHY IT EXISTS (LOVE-V#1). Until this landed, `campaigns/[id]`,
 * `subscribers/[id]`, `lists/[id]`, … were registered as SIBLING
 * `<Tabs.Screen href={null}>` entries in `app/(tabs)/_layout.tsx`. A bottom-tab
 * navigator has no card presentation, so opening a record was a tab SWAP:
 *
 *   - no push transition — the detail replaced the list in one frame,
 *   - no interactive edge-swipe back — the single most-used gesture on iOS,
 *   - no stack under the detail, so `router.canGoBack()` was false on a cold
 *     deep link and `goBackOr()` had to REPLACE with a guessed fallback,
 *   - and the list's scroll offset was destroyed on the way back, because the
 *     list screen was unmounted rather than left beneath.
 *
 * Making each family a directory with this layout — `campaigns/index.tsx` +
 * `campaigns/[id].tsx` under `campaigns/_layout.tsx` — turns the drill-down
 * into a real push inside ONE tab. The tab rail stays mounted (this stack is a
 * CHILD of the tab screen, not a replacement for it), which is the invariant
 * `app/(tabs)/_layout.tsx` and `SecondaryRouteGuard` are built on.
 *
 * `headerShown: false` is deliberate, not laziness. Every screen in the app
 * renders `<ScreenHeader>` INSIDE its own `SafeAreaView`, above the scroll
 * view, so the title never scrolls away and the screen owns its right-hand
 * actions. Letting the native header render too would double it. The
 * interactive pop gesture does NOT depend on the header — `gestureEnabled`
 * carries it on its own — so hiding the header costs nothing here.
 *
 * The URL surface is unchanged: `/campaigns/{id}` still routes to the same
 * file, so every deep link, push payload and web hand-off keeps working.
 */
import { Stack } from "expo-router";

/**
 * Interned at module scope. React Navigation compares `screenOptions` by
 * identity; a fresh object literal per render re-configures every screen in
 * the stack on every render of the layout.
 */
const SCREEN_OPTIONS = {
  headerShown: false,
  /**
   * iOS edge-swipe / Android predictive back. Default-true on native-stack,
   * stated explicitly because it is the entire point of the conversion and a
   * silent default is not a contract.
   */
  gestureEnabled: true,
} as const;

export function EntityDetailStack() {
  return <Stack screenOptions={SCREEN_OPTIONS} />;
}
