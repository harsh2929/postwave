/**
 * lib/offlineEntityWriteContract.ts — the PURE half of the generic offline
 * write (NATIVE#1).
 *
 * Kept free of every module that transitively reaches react-native so both the
 * executor (lib/offlineEntityWrite.ts, which needs the SDK client and the auth
 * store) and the queue inspector (lib/offlineMutationQueue.ts, which is unit
 * tested in the node environment) can share the same variable shape and the
 * same sanitisers.
 */
import type { OfflineMutationAuthScope } from "./offlineMutationContract";

export type EntityWriteMethod = "POST" | "PATCH" | "PUT";

/** Variables persisted with a queued entity write. JSON-round-trip safe. */
export interface EntityWriteVars {
  auth: OfflineMutationAuthScope;
  operationId: string;
  method: EntityWriteMethod;
  /** Absolute API path, e.g. `/api/v1/tags/12`. Never an origin. */
  path: string;
  body?: unknown;
  /**
   * When this write was queued, ISO-8601. Read at replay to decide whether the
   * target was deleted AFTER it was queued, in which case replaying it would
   * recreate a record the user deleted and watched go.
   *
   * Optional because a record persisted by an older build does not carry it. A
   * missing value cannot be suppressed — the rule needs the comparison — which
   * is a bounded gap that drains with the queue rather than a standing one.
   */
  queuedAt?: string;
  /**
   * Query-key ROOTS to invalidate once the write lands. Roots only (the first
   * element of a key) so a rehydrated record cannot carry an arbitrary
   * structured key across a schema change.
   */
  invalidateRoots?: string[];
  /**
   * Short human label for the queue inspector and the failure banner. Bounded
   * and stripped of anything but plain text — it is rendered in a shared UI.
   */
  label?: string;
}

const MAX_LABEL_CHARS = 48;
const MAX_INVALIDATE_ROOTS = 8;
const ROOT_RE = /^[a-z][a-z0-9-]{0,48}$/;

/** Sanitised label, or a safe generic one. Never renders user content. */
export function entityWriteLabel(vars: {
  label?: string | undefined;
  method?: string | undefined;
}): string {
  const raw = typeof vars.label === "string" ? vars.label.trim() : "";
  if (raw && raw.length <= MAX_LABEL_CHARS && /^[A-Za-z0-9 ().,'-]+$/.test(raw)) {
    return raw;
  }
  return vars.method === "POST" ? "Queued creation" : "Queued edit";
}

/** Only well-formed key roots survive a disk round trip. */
export function safeInvalidateRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((root): root is string => typeof root === "string" && ROOT_RE.test(root))
    .slice(0, MAX_INVALIDATE_ROOTS);
}
