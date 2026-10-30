/**
 * suppressionOpsContracts — the PURE half of the suppression hook surface.
 *
 * WHAT LIVES HERE vs WHERE IT CAME FROM.
 *
 * `hooks/useSuppressionOps.ts` (email) and `hooks/useSmsSuppressionOps.ts`
 * (SMS) are React modules: they import TanStack Query, the SDK client and the
 * auth store, so nothing in them can be exercised in the node vitest
 * environment. Everything they do that is a DECISION rather than an effect —
 * the cache keys every mutation invalidates, the predicate that decides
 * whether a query can be filtered server-side, the phone shape the SMS read
 * refuses to send, the refusal copy an operator actually reads — is here
 * instead, so each one is a plain function a node test can call.
 *
 * This module imports nothing but a type. Keep it that way: the moment it
 * pulls in the client or a react hook it stops being testable and the split
 * has bought nothing.
 *
 * Split out of useSuppressionOps.ts when the paged list pushed that file past
 * the 450-line source budget — same idiom as api/eventBus.ts →
 * eventBusStream.ts / eventBusConnection.ts.
 */
import type { ClassifiedQuery } from "@/lib/suppressionSearch";

/** The identity fields every suppression cache key is scoped by. */
export interface SuppressionKeyScope {
  tenantId: string | null;
  userId: string | null;
}

/** Cache key for the list, so every mutation can invalidate the same family. */
export function suppressionListKey(gate: SuppressionKeyScope) {
  return ["suppressions", gate.tenantId, gate.userId] as const;
}

/**
 * Whether the gateway can do the filtering for us.
 *
 * `email=` (exact) and `q=` (prefix) have both been accepted since the A20
 * change; a 1-2 character query is narrowed on the client instead, and "none"
 * is the unfiltered list.
 */
export function isServerFilteredQuery(classified: ClassifiedQuery): boolean {
  return classified.mode === "exact" || classified.mode === "prefix";
}

/**
 * The full query key for one read of the list.
 *
 * The role and the online/offline arm are part of the key because a snapshot
 * read and a network read are different answers to the same question, and a
 * demoted session must not inherit the previous role's rows. `variant`
 * separates the single-page hook from the paged one, which merge differently
 * and must never share an entry.
 */
export function suppressionListQueryKey(
  gate: SuppressionKeyScope & {
    effectiveRole: string | null;
    enabled: boolean;
  },
  classified: ClassifiedQuery,
  variant: 1 | "paged",
) {
  return [
    ...suppressionListKey(gate),
    gate.effectiveRole,
    gate.enabled ? "network" : "snapshot",
    isServerFilteredQuery(classified)
      ? `${classified.mode}:${classified.value}`
      : "unfiltered",
    variant,
  ] as const;
}

/** Shown instead of an empty list when the vault has never seen this tenant. */
export const SUPPRESSION_SNAPSHOT_UNAVAILABLE =
  "No saved suppression snapshot is available offline.";

/**
 * Compliance writes are intentionally ONLINE-ONLY: never queue a suppression
 * change to replay later from a stale phone. Both mutations reject early with
 * a message the screen can show verbatim.
 */
export class OfflineWriteRefusedError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super(
      "Suppressions can only be changed while connected. Reconnect and try again.",
    );
    this.name = "OfflineWriteRefusedError";
  }
}

/**
 * The export is a live stream off the server rather than anything the vault
 * holds, so it gets its own refusal: "reconnect and try again" would be a
 * lie about a cached copy that does not exist.
 */
export class SuppressionExportOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super(
      "The suppression export streams live from the server, so it needs a connection.",
    );
    this.name = "SuppressionExportOfflineError";
  }
}

/** Cache key family for the SMS opt-out table (its own routes, its own role). */
export const SMS_SUPPRESSIONS_KEY_ROOT = "sms-suppressions-v2";

/** Cache key for one SMS opt-out read: identity fingerprint + phone scope. */
export function smsSuppressionsKey(
  fingerprint: string | null,
  phone: string,
): readonly [string, string | null, string] {
  return [SMS_SUPPRESSIONS_KEY_ROOT, fingerprint, phone || "all"] as const;
}

/**
 * The SMS read filters by an EXACT E.164 US/Canada number or not at all — the
 * route has no prefix search, so a half-typed number would silently return the
 * unfiltered table and read as "this person has not opted out".
 */
export function isExactNanpNumber(phone: string): boolean {
  return /^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(phone);
}

/** An empty box means "no phone filter", which is allowed; a partial one is not. */
export function smsSuppressionPhoneAccepted(phone: string): boolean {
  return !phone || isExactNanpNumber(phone);
}
