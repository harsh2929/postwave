/**
 * subscriber-status — engine ↔ UI status mapping shared by the
 * Subscribers page, the stat strip, and tests.
 *
 * The backend's `validStatus()` only accepts `enabled / disabled /
 * blocklisted / unconfirmed`, but the UI historically emitted the
 * Listmonk-era vocabulary (`subscribed / unsubscribed / bounced`). A
 * raw `setRowStatus(row, "subscribed")` therefore round-tripped a 422
 * "invalid status" from the API.
 *
 * `uiStatusToEngine` is the one-way translator applied at every
 * write-boundary (PATCH body, filter compare, export query).
 * `engineStatusToUi` is its read-side inverse. The two are exact
 * round-trips for every UI status the page renders, so re-saving the
 * row `<select>` never silently flips a subscriber to a different
 * engine state.
 *
 * There is NO "bounced" status in the engine — bounce state lives in
 * the suppressions table. Legacy rows that still carry the string
 * "bounced" collapse onto `blocklisted` (write) / "unsubscribed"
 * (read), and the UI no longer offers a Bounced chip or option.
 */

export const ENGINE_STATUSES = [
  "enabled",
  "disabled",
  "blocklisted",
  "unconfirmed",
] as const;
export type EngineStatus = (typeof ENGINE_STATUSES)[number];

/** Canonical UI buckets used by the filter chips and the row select. */
export const UI_STATUSES = [
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
] as const;
export type MutableSubscriberUiStatus = (typeof UI_STATUSES)[number];
/**
 * Read-side status. `unknown` is deliberately not part of UI_STATUSES: it is
 * visible but cannot be selected as a write value or silently translated to a
 * sendable engine state.
 */
export type SubscriberUiStatus = MutableSubscriberUiStatus | "unknown";

/** Human labels for the UI buckets. "disabled" renders as "Inactive"
 * so operators don't read it as an RBAC/account state. */
export const UI_STATUS_LABELS: Record<SubscriberUiStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  disabled: "Inactive",
  unconfirmed: "Unconfirmed",
  unknown: "Unknown",
};

export function uiStatusToEngine(s: string): EngineStatus | null {
  const v = (s ?? "").toLowerCase();
  switch (v) {
    case "subscribed":
    case "enabled":
    case "active":
      return "enabled";
    case "unsubscribed":
    case "bounced": // legacy vocabulary — engine has no bounced status
    case "blocklisted":
      return "blocklisted";
    case "disabled":
      return "disabled";
    case "unconfirmed":
      return "unconfirmed";
    default:
      // Fail closed. Callers must reconcile an unrecognised status instead of
      // converting it into a sendable subscriber.
      return null;
  }
}

/**
 * Coerce whatever the row carries (engine value or legacy UI value) into
 * the canonical UI bucket. The mapping is one-to-many on read
 * (`blocklisted` → "unsubscribed") — bounce detection lives in
 * Suppressions, not on the subscriber row. `disabled` and `unconfirmed`
 * are first-class buckets so inactive/unconfirmed subscribers are never
 * presented (or re-saved) as Subscribed.
 */
export function engineStatusToUi(s: string | undefined): SubscriberUiStatus {
  const v = (s ?? "").toLowerCase();
  switch (v) {
    case "enabled":
    case "subscribed":
    case "active":
      return "subscribed";
    case "blocklisted":
    case "unsubscribed":
    case "bounced": // legacy rows only — see module doc
      return "unsubscribed";
    case "disabled":
      return "disabled";
    case "unconfirmed":
      return "unconfirmed";
    default:
      return "unknown";
  }
}

/**
 * Validate a persisted filter value (e.g. from a saved segment) into a
 * UI bucket. Returns null for values we can't honestly apply. The
 * retired "bounced" chip folds into "unsubscribed" the same way reads
 * do.
 */
export function coerceUiStatus(v: unknown): SubscriberUiStatus | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if ((UI_STATUSES as readonly string[]).includes(s)) {
    return s as SubscriberUiStatus;
  }
  if (s === "bounced" || s === "blocklisted") return "unsubscribed";
  if (s === "enabled" || s === "active") return "subscribed";
  return null;
}
