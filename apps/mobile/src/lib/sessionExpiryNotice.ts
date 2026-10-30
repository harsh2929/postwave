/**
 * sessionExpiryNotice — turn a session's `expires_at` into the line the user
 * actually needs to read.
 *
 * WHY THIS EXISTS. The tenant policy `session_max_minutes` is enforced on the
 * server and surfaced nowhere in either client: `SessionInfo.ExpiresAt`
 * (apps/api/internal/auth/sessions_handler.go) has always been on the wire and
 * no screen rendered it. The result is that a session ending is something the
 * user only discovers by being thrown out mid-task — `lib/sessionExpiry.ts`
 * makes that landing clean, but a clean landing is still a landing. A short
 * workspace policy (say 60 minutes) is indistinguishable from a bug unless the
 * app says so out loud.
 *
 * DELIBERATELY IMPORT-FREE, like `approvalPolicy` / `chartScale` /
 * `passwordPolicy`: no react-native, no `./connectivity`. That is what lets the
 * node vitest environment exercise the boundaries, which is the whole risk
 * here — every interesting case is a threshold.
 *
 * The companion module `lib/sessionExpiry.ts` answers "a 401 arrived, is the
 * session gone?". This one answers "the session is alive, how long has it
 * got?". Together they cover before and after; neither replaces the other.
 */

/** Remaining time at or under which the notice is worth acting on. */
export const SESSION_EXPIRY_URGENT_MINUTES = 60;

/**
 * Beyond this we say nothing. A workspace with no meaningful cap issues
 * sessions months out, and "Expires in 87 days" is noise on a security row —
 * it teaches the user to ignore the line that matters at 10 minutes.
 */
export const SESSION_EXPIRY_MAX_NOTICE_DAYS = 30;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface SessionExpiryNotice {
  /** The visible line, e.g. "Expires in 42 minutes". */
  readonly text: string;
  /**
   * The spoken line. Identical to `text` today because nothing here is
   * compacted — it is a separate field so that stays true by contract rather
   * than by luck if the visible form is ever shortened.
   */
  readonly spoken: string;
  /** Within `SESSION_EXPIRY_URGENT_MINUTES`, or already gone. */
  readonly urgent: boolean;
}

/**
 * `null` means "say nothing" — an absent, malformed or far-future timestamp.
 *
 * Fail-safe by design: a security row must never invent a deadline it cannot
 * substantiate. Every reject path returns null rather than a guess.
 */
export function sessionExpiryNotice(
  expiresAt: unknown,
  nowMs: number,
): SessionExpiryNotice | null {
  if (typeof expiresAt !== "string" || expiresAt.trim() === "") return null;
  if (!Number.isFinite(nowMs)) return null;

  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return null;

  const remaining = expiryMs - nowMs;

  if (remaining <= 0) {
    return {
      text: "Session expired",
      spoken: "This session has expired",
      urgent: true,
    };
  }

  if (remaining > SESSION_EXPIRY_MAX_NOTICE_DAYS * DAY_MS) return null;

  const urgent = remaining <= SESSION_EXPIRY_URGENT_MINUTES * MINUTE_MS;

  if (remaining < HOUR_MS) {
    // Round UP: with 30 seconds left, "Expires in 0 minutes" is both wrong and
    // useless, and rounding down anywhere under a minute produces it.
    const minutes = Math.max(1, Math.ceil(remaining / MINUTE_MS));
    return finish(`${minutes} ${plural(minutes, "minute")}`, urgent);
  }

  if (remaining < DAY_MS) {
    // Round DOWN from here on: promising more time than remains is the one
    // error that costs the user work.
    const hours = Math.floor(remaining / HOUR_MS);
    return finish(`${hours} ${plural(hours, "hour")}`, urgent);
  }

  const days = Math.floor(remaining / DAY_MS);
  return finish(`${days} ${plural(days, "day")}`, urgent);
}

function finish(amount: string, urgent: boolean): SessionExpiryNotice {
  const text = `Expires in ${amount}`;
  return { text, spoken: `This session expires in ${amount}`, urgent };
}

function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${unit}s`;
}
