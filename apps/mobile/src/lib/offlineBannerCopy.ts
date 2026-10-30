/**
 * lib/offlineBannerCopy.ts — what the app-wide offline bar is allowed to say.
 *
 * The bar used to read, unconditionally:
 *
 *   "No connection — showing cached data. Changes will sync when you're back
 *    online."
 *
 * Both halves could be false at once (NATIVE#36 / LOVE#37).
 *
 * 1. "SHOWING CACHED DATA" is a promise the persistence policy explicitly does
 *    not keep. `shouldPersistQuery` in lib/queryClient.ts returns false
 *    UNCONDITIONALLY — no query response is written to disk, on purpose,
 *    because responses carry customer/DNS/sender/audit data even under
 *    innocuous keys. Only screens with a hand-written SecureStore projection
 *    have anything offline; every other screen shows an error state under a
 *    banner claiming its data is cached.
 *
 * 2. "CHANGES WILL SYNC" is only true if there ARE changes. Said on a device
 *    with an empty queue it is noise; and its converse — a device holding
 *    three unsent writes — is the fact the user actually needs and the only
 *    place it was visible was the Diagnostics screen, behind More.
 *
 * So the copy is derived from measured state instead of asserted. Pure, and
 * unit-tested in the node environment; the component supplies the numbers.
 *
 * ── AND WHY THE SENTENCES LIVE IN THE CATALOGUE NOW (LOVE#22) ──────────────
 * The pending-writes line used to read
 *
 *     `${n} change${n === 1 ? "" : "s"} waiting to send —
 *      ${n === 1 ? "it" : "they"} will go out when you reconnect.`
 *
 * Two independent English-only assumptions in one sentence: a two-form plural,
 * and a pronoun that agrees at the same boundary. `lib/i18n` selects a whole
 * sentence per CLDR category instead, so a language with four number forms
 * gets four sentences rather than a suffix it cannot use. The English output
 * is unchanged except that the count is now thousands-grouped like every other
 * number in the app.
 *
 * This file is in `i18nCoverage.test.ts`'s covered set: a new hardcoded
 * sentence here fails the build.
 */
import { msg, pluralMsg } from "@/lib/i18n";

export interface OfflineBannerState {
  /** Unsent writes on this device (queued + syncing). */
  pendingWrites: number;
  /** Writes that have already failed and are waiting to be dealt with. */
  failedWrites: number;
  /** Whether a reachability re-probe is currently running. */
  rechecking: boolean;
}

export interface OfflineBannerCopy {
  /** Headline, always present. */
  title: string;
  /** Second line, or null when there is nothing honest to add. */
  detail: string | null;
  /** What a screen reader announces for the whole bar. */
  accessibilityLabel: string;
  /** Label for the re-probe control. */
  actionLabel: string;
}

export function offlineBannerCopy(
  state: OfflineBannerState,
): OfflineBannerCopy {
  const parts: string[] = [];
  if (state.pendingWrites > 0) {
    parts.push(pluralMsg("offline.pending", state.pendingWrites));
  }
  if (state.failedWrites > 0) {
    parts.push(pluralMsg("offline.failed", state.failedWrites));
  }
  // No claim about cached data. Some screens have an offline projection and
  // most do not, and the bar cannot tell which one the user is looking at —
  // so it states the connection, and lets each screen state its own data.
  const detail = parts.length > 0 ? parts.join(" ") : null;
  const title = msg("offline.title");
  return {
    title,
    detail,
    // Even the punctuation joining the two clauses is a message: a language
    // that ends a sentence with "。" cannot be served by a hardcoded ".".
    accessibilityLabel: detail
      ? msg("offline.a11y.withDetail", { title, detail })
      : msg("offline.a11y.plain", { title }),
    actionLabel: state.rechecking
      ? msg("offline.action.rechecking")
      : msg("offline.action.recheck"),
  };
}
