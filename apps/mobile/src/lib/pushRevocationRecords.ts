/**
 * lib/pushRevocationRecords.ts — the pure rules of the push-revocation journal.
 *
 * The journal itself (lib/pushRevocationJournal.ts) imports expo-secure-store,
 * which the node vitest environment cannot load, so the whole module — origin
 * normalisation, device-key validation, and a six-condition record filter that
 * decides whether a queued "stop pushing to this device" survives a restart —
 * had no tests at all (NATIVE#51). Those rules are exactly the part worth
 * testing: each rejected record is a server that keeps its ability to push to a
 * phone whose owner asked it to stop.
 *
 * Split out rather than mocked, per the house rule: keep the policy in an
 * import-free module and let the storage module stay a thin adapter.
 */

export interface PendingPushRevocation {
  baseUrl: string;
  deviceKey: string;
  createdAt: number;
}

/** A journal bigger than this is corrupt, not merely busy. */
export const MAX_PENDING_REVOKES = 8;
export const MAX_JOURNAL_BYTES = 16_384;
/** Past this the server has almost certainly reaped the row itself. */
export const PENDING_REVOKE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Tolerance for a device clock that is slightly ahead of when we wrote. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const HOSTS_ALLOWED_OVER_HTTP = ["localhost", "127.0.0.1", "::1", "[::1]"];

/**
 * Canonical origin for a journal entry.
 *
 * THROWS rather than returning null: a revocation aimed at an origin we cannot
 * canonicalise must never be silently queued against a different one, and the
 * callers all treat the throw as "do not record this".
 */
export function normalizePushServerBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid push revocation server origin.");
  }
  const local = HOSTS_ALLOWED_OVER_HTTP.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Push revocation server must use HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

/** The device possession key: 32 random bytes, lowercase hex. */
export function validDeviceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export interface ParsedRevocationJournal {
  records: PendingPushRevocation[];
  /**
   * True when at least one stored record was dropped, so the caller knows to
   * rewrite the journal. Distinguishing this from "nothing changed" avoids a
   * SecureStore write on every single read.
   */
  changed: boolean;
}

/**
 * Validate a decoded journal.
 *
 * Accepts the original single-record format as well as the array, so an
 * already-installed build upgrades without losing a pending cleanup. A record
 * is dropped when it has no valid possession key, no usable origin, a
 * non-finite or future timestamp, or has simply aged out.
 *
 * THROWS only when the container itself is over its bound — that is corruption,
 * and the caller responds by clearing the journal rather than trusting part of
 * it.
 */
export function parseRevocationJournal(
  decoded: unknown,
  now = Date.now(),
): ParsedRevocationJournal {
  const records = Array.isArray(decoded) ? decoded : [decoded];
  if (records.length > MAX_PENDING_REVOKES) {
    throw new Error("pending push revocation journal exceeds its bound");
  }
  const valid: PendingPushRevocation[] = [];
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const parsed = record as Partial<PendingPushRevocation>;
    if (
      !validDeviceKey(parsed.deviceKey) ||
      typeof parsed.baseUrl !== "string" ||
      typeof parsed.createdAt !== "number" ||
      !Number.isFinite(parsed.createdAt) ||
      parsed.createdAt > now + CLOCK_SKEW_TOLERANCE_MS ||
      now - parsed.createdAt > PENDING_REVOKE_MAX_AGE_MS
    ) {
      continue;
    }
    let baseUrl: string;
    try {
      baseUrl = normalizePushServerBaseUrl(parsed.baseUrl);
    } catch {
      // An origin we cannot canonicalise cannot be revoked against; dropping it
      // is the only honest outcome, and `changed` makes the drop durable.
      continue;
    }
    valid.push({ baseUrl, deviceKey: parsed.deviceKey, createdAt: parsed.createdAt });
  }
  return { records: valid, changed: valid.length !== records.length };
}

/**
 * Insert (or refresh) one entry. Deduplicates on origin + device key, because
 * re-queueing the same cleanup must not consume one of the eight slots.
 *
 * THROWS when the journal is full: an older unfulfilled server cleanup is never
 * discarded to make room for a newer one — that would silently leave a server
 * able to push to this phone forever.
 */
export function withQueuedRevocation(
  current: readonly PendingPushRevocation[],
  next: PendingPushRevocation,
): PendingPushRevocation[] {
  const deduplicated = current.filter(
    (entry) =>
      entry.deviceKey !== next.deviceKey || entry.baseUrl !== next.baseUrl,
  );
  deduplicated.push(next);
  if (deduplicated.length > MAX_PENDING_REVOKES) {
    throw new Error("Too many pending push revocations.");
  }
  return deduplicated;
}
