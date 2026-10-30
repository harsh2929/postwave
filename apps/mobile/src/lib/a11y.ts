/**
 * a11y — proactive screen-reader announcements.
 *
 * Every auth screen marks its error `Text` with `accessibilityRole="alert"`.
 * On Android that maps to a live region and announces; on iOS it does NOT — a
 * newly mounted alert-role node is simply part of the reading order, so a
 * blind user who taps "Sign in" and gets a wrong-password error hears total
 * silence and sees an unchanged screen.
 *
 * `announce()` closes that gap with `AccessibilityInfo.announceForAccessibility`
 * and `liveRegionProps()` gives Android the assertive live region it does
 * understand, so a single call site is correct on both platforms.
 *
 * Everything here is best-effort: an announcement failing must never break a
 * sign-in, so each call is guarded exactly the way `lib/haptics.ts` is.
 */
import { useEffect } from "react";
import { AccessibilityInfo, findNodeHandle, Platform } from "react-native";

/** Announcements are read verbatim; keep them short and never dump a stack. */
const MAX_ANNOUNCEMENT_CHARS = 300;

/**
 * Speak a message immediately. On Android the platform live region already
 * announces alert-role text, so announcing again would double-speak; this
 * no-ops there and `liveRegionProps()` covers that platform instead.
 */
export function announce(message: string): void {
  const text = (message ?? "").trim().slice(0, MAX_ANNOUNCEMENT_CHARS);
  if (!text) return;
  if (Platform.OS !== "ios") return;
  try {
    AccessibilityInfo.announceForAccessibility(text);
  } catch {
    /* announcements are decorative; never let one break a flow */
  }
}

/**
 * Speak `message` each time it changes to a new non-empty value — the iOS half
 * of an alert-role node that appears or changes text in place (ErrorState's
 * idiom, extracted). Pass null while nothing should be said; keep the node's
 * alert role / live region for Android, where `announce()` no-ops.
 */
export function useAnnounceOnChange(message: string | null | undefined): void {
  useEffect(() => {
    if (message) announce(message);
  }, [message]);
}

/**
 * Props for a node that must interrupt the screen reader when it appears.
 * `accessibilityLiveRegion` is Android-only; iOS is served by `announce()`.
 */
export function liveRegionProps(): {
  accessibilityRole: "alert";
  accessibilityLiveRegion: "assertive";
} {
  return {
    accessibilityRole: "alert",
    accessibilityLiveRegion: "assertive",
  };
}

/**
 * Move screen-reader focus onto a node. Sign-in swaps between three
 * full-screen trees (credential form / workspace picker / "check your email")
 * without unmounting the route, so without this the screen changes silently
 * underneath a VoiceOver user and focus stays on a button that no longer
 * exists. Desktop solves the same problem by focusing its alert region on
 * mount.
 */
export function focusOn(ref: { current: unknown } | null | undefined): void {
  const node = ref?.current;
  if (!node) return;
  try {
    const handle = findNodeHandle(node as Parameters<typeof findNodeHandle>[0]);
    if (handle == null) return;
    AccessibilityInfo.setAccessibilityFocus(handle);
  } catch {
    /* focus management is best-effort */
  }
}

/**
 * Announce a screen change AND move focus to its heading. Used at every
 * branch transition so the new state is both spoken and navigable.
 */
export function announceScreenChange(
  message: string,
  ref?: { current: unknown } | null,
): void {
  announce(message);
  if (ref) focusOn(ref);
}
