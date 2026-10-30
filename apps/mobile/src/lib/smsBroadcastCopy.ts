/**
 * smsBroadcastCopy — the PURE half of the broadcast list's dispatch banner.
 *
 * `SmsBroadcastsScreen` is the React half; the SENTENCE it shows when the
 * server says dispatch is unavailable is decided here, with no react,
 * react-native or expo import in the module. Same split, and the same reason,
 * as `lib/smsThreadCopy` beside it: a copy rule that only exists inside JSX can
 * only be exercised by mounting a whole screen.
 *
 * WHY IT MOVED HERE AT ALL. The fallback branch used to interpolate the raw
 * server gate code into the banner —
 * `Broadcast dispatch is unavailable (${reason ?? "unknown reason"})` — so an
 * operator read an internal identifier they cannot act on, and in the
 * already-known release-hold case they read a second, worse copy of a sentence
 * the screen explains properly one branch above. What the reader needs is the
 * same in both branches: dispatch is off, drafts are still editable. The code
 * itself is still worth keeping for support, so the screen hangs it off the
 * banner as a `testID` rather than printing it.
 */

/**
 * The one dispatch hold the app can explain in full. It is the server's own
 * code (apps/api; mirrored as `SMS_BROADCAST_DISPATCH_RELEASE_HELD_CODE` in
 * `api/smsCampaigns.ts`), compared as a literal here because this module is
 * deliberately unreachable from `src/api`, which pulls react-native.
 */
export const SMS_BROADCAST_DISPATCH_RELEASE_HELD =
  "sms_broadcast_dispatch_release_held";

/**
 * What the banner says when `dispatchAvailable` is false.
 *
 * The release-hold gets the full explanation because we know exactly what it
 * means and when it lifts. Every other reason gets the honest short form: we
 * do not know why, so we say what is true for the user either way instead of
 * quoting a code at them.
 */
export function broadcastDispatchUnavailableSentence(
  reason: string | null | undefined,
): string {
  if (reason === SMS_BROADCAST_DISPATCH_RELEASE_HELD) {
    return "Broadcast dispatch is release-held server-side: drafts can be authored, edited, and deleted here, but nothing can be sent from any client until the dispatch saga ships.";
  }
  return "Broadcast dispatch is unavailable right now; drafts remain editable.";
}
