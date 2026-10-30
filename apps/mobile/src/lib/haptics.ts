/**
 * Semantic haptics wrapper.
 *
 * A thin, typed layer over `expo-haptics` that names feedback by intent
 * (`tap`, `success`, `warning`, `error`, `impact`) rather than by the raw
 * native enum. Centralising it keeps the call sites tasteful and consistent,
 * and lets us tune the physical feel in one place.
 *
 * Every helper is fire-and-forget and guarded:
 *   - The native engine can throw / reject on simulators, web, and devices
 *     without a haptics motor. Feedback is purely decorative, so a failure
 *     must never bubble into the UX — each call is wrapped so it no-ops.
 *   - The underlying expo-haptics functions are async; we intentionally do
 *     not await them at call sites. We swallow the rejection here so callers
 *     can write `tap()` without `void`/`.catch()` boilerplate.
 */
import * as Haptics from "expo-haptics";

/** Run an async haptics call without letting a rejection or throw escape. */
function fire(run: () => Promise<unknown>): void {
  try {
    void Promise.resolve(run()).catch(() => {
      /* haptics are best-effort; ignore unsupported-device rejections */
    });
  } catch {
    /* a synchronous throw (e.g. missing native module) is equally ignorable */
  }
}

/**
 * Light selection tick — the right feel for a primary CTA tap or a
 * deliberate toggle. Maps to the OS "selection changed" feedback.
 */
export function tap(): void {
  fire(() => Haptics.selectionAsync());
}

/** A completed mutation succeeded (created, saved, applied). */
export function success(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/**
 * A destructive or consequential action is being confirmed (suppress,
 * delete, unsubscribe) — a heavier "are you sure" thud than a tap.
 */
export function warning(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** An operation failed. */
export function error(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

/**
 * Generic physical impact. Defaults to a medium collision; pass a style
 * for lighter/heavier feedback. Useful for confirming a destructive commit.
 */
export function impact(
  style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Medium,
): void {
  fire(() => Haptics.impactAsync(style));
}

export const haptics = { tap, success, warning, error, impact };
