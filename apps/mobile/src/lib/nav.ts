/**
 * Navigation helpers.
 */
import { router } from "expo-router";

import { haptics } from "@/lib/haptics";

/**
 * Back handler for secondary screens reached from the "More" menu. Pops
 * the stack when there's history (the usual push-from-More case) and falls
 * back to the More menu when the screen was opened cold via a deep link,
 * so the user is never stranded with no way back.
 */
export function goBackOrMore(): void {
  haptics.tap();
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/(tabs)/more");
  }
}

/**
 * Back handler for detail/drill-down screens. Pops when there's history,
 * otherwise replaces with the given list route — so a detail opened cold
 * via a deep link (no back stack) still has a working "back" instead of a
 * silent no-op that strands the user.
 *
 * WHAT THE PUSH-STACK CONVERSION CHANGED (LOVE-V#1). Entity families are now
 * directory navigators — `campaigns/index` + `campaigns/[id]` under
 * `campaigns/_layout.tsx` — so on those screens `canGoBack()` is TRUE where it
 * used to be false, and this pops a real card instead of replacing the route.
 * Two consequences worth knowing at the call site:
 *
 *   - The `fallback` is now genuinely a last resort. Each converted family
 *     declares `unstable_settings.initialRouteName = "index"`, so even a cold
 *     deep link arrives with its list underneath and takes the pop branch.
 *   - It is still REQUIRED. The three families that have not been converted
 *     (sequences, forms, sms) are still tab siblings with nothing beneath
 *     them, and `router.back()` there is the silent no-op this exists to
 *     prevent. `src/lib/navBack.consistency.test.ts` enforces that.
 *
 * `fallback` should be the LIST the record belongs to, not an arbitrary
 * screen: on the pop branch that is where the user lands anyway, so a
 * different fallback would make Back mean two different things.
 */
export function goBackOr(fallback: Parameters<typeof router.replace>[0]): void {
  // Back is a navigation press like any other and was the last common control
  // with no physical feedback (LOVE#31). It fires BEFORE the branch because
  // both outcomes are a "back" to the user — the replace path exists only
  // because a cold deep link has no stack to pop, which is an implementation
  // detail they should not be able to feel.
  haptics.tap();
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace(fallback);
  }
}
