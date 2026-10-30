/**
 * subscriberStatus — the ONE engine ↔ UI status vocabulary for mobile.
 *
 * Before this module existed, mobile disagreed with desktop AND with web
 * about what the same button does:
 *
 *   - desktop `uiStatusToEngine`: "unsubscribed" → `blocklisted`
 *   - web `subscribers-list-helpers`: "suppressed" → `blocklisted`
 *   - mobile: the Unsubscribe button PATCHed `disabled`
 *
 * So the same person, unsubscribed on a phone and on a laptop, ended up
 * in two different engine states. Mobile also shipped a "Bounced" chip
 * that sent `status=blocklisted` — the engine has NO bounced status
 * (bounce state lives in the deliverability suppression table; the
 * server's genuine `status=bounced` filter maps to
 * `mailchimp_status='cleaned'`), so the chip silently returned suppressed
 * contacts under a label that promised bounces.
 *
 * This module is a port of apps/desktop/src/components/subscribers/
 * subscriber-status.ts so all three clients now agree. It is deliberately
 * dependency-free (no react-native import) so it can be unit tested.
 *
 * Engine vocabulary (apps/api migration 0003 CHECK):
 *   enabled | disabled | blocklisted | unconfirmed
 *
 * All four are accepted by GET /api/v1/subscribers?status= (verified at
 * apps/api/internal/subscribers/repo_helpers.go statusFilterClause).
 */

export const ENGINE_STATUSES = [
  "enabled",
  "disabled",
  "blocklisted",
  "unconfirmed",
] as const;
export type EngineStatus = (typeof ENGINE_STATUSES)[number];

/** Canonical UI buckets used by the filter chips and the status pill. */
export const UI_STATUSES = [
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
] as const;
export type MutableSubscriberUiStatus = (typeof UI_STATUSES)[number];

/**
 * Read-side status. `unknown` is deliberately NOT part of UI_STATUSES: it
 * is displayable but can never be translated back into a sendable engine
 * state.
 */
export type SubscriberUiStatus = MutableSubscriberUiStatus | "unknown";

/**
 * Human labels. "disabled" renders as "Inactive" so operators don't read
 * it as an RBAC/account state — the same reasoning desktop documents.
 */
export const UI_STATUS_LABELS: Record<SubscriberUiStatus, string> = {
  subscribed: "Subscribed",
  unsubscribed: "Unsubscribed",
  disabled: "Inactive",
  unconfirmed: "Unconfirmed",
  unknown: "Unknown",
};

export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** Pill tone per UI bucket. Every tone is paired with its text label at
 *  the call site, so colour is never the only carrier of meaning. */
const UI_STATUS_TONES: Record<SubscriberUiStatus, StatusTone> = {
  subscribed: "success",
  unsubscribed: "danger",
  disabled: "warning",
  unconfirmed: "warning",
  unknown: "neutral",
};

/**
 * One-way translator applied at every WRITE boundary (PATCH body, filter
 * value). Returns null for anything we cannot honestly map — callers must
 * reconcile rather than convert an unknown string into a sendable state.
 */
export function uiStatusToEngine(s: string | undefined): EngineStatus | null {
  const v = (s ?? "").trim().toLowerCase();
  switch (v) {
    case "subscribed":
    case "enabled":
    case "active":
      return "enabled";
    case "unsubscribed":
    case "bounced": // legacy vocabulary — the engine has no bounced status
    case "blocklisted":
      return "blocklisted";
    case "disabled":
    case "inactive":
      return "disabled";
    case "unconfirmed":
      return "unconfirmed";
    default:
      return null;
  }
}

/**
 * Read-side inverse. The mapping is one-to-many on read
 * (`blocklisted` → "unsubscribed") because bounce/complaint detail lives
 * in Suppressions, not on the subscriber row.
 */
export function engineStatusToUi(s: string | undefined): SubscriberUiStatus {
  const v = (s ?? "").trim().toLowerCase();
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
    case "inactive":
      return "disabled";
    case "unconfirmed":
      return "unconfirmed";
    default:
      return "unknown";
  }
}

/** The label a user should see for a raw engine value. Never renders the
 *  Postgres enum ("blocklisted", "enabled") straight to a human. */
export function subscriberStatusLabel(s: string | undefined): string {
  return UI_STATUS_LABELS[engineStatusToUi(s)];
}

/** Pill tone for a raw engine value. */
export function subscriberStatusTone(s: string | undefined): StatusTone {
  return UI_STATUS_TONES[engineStatusToUi(s)];
}

/**
 * A spoken description for assistive tech. Includes the engine value in
 * parentheses only when it differs from the label, so a support call can
 * still reference the underlying state without misleading the reader.
 */
export function subscriberStatusAccessibilityLabel(
  s: string | undefined,
): string {
  const label = subscriberStatusLabel(s);
  const raw = (s ?? "").trim().toLowerCase();
  if (!raw || raw === label.toLowerCase()) return `Status: ${label}`;
  return `Status: ${label} (${raw})`;
}

export interface SubscriberStatusFilter {
  key: string;
  label: string;
  /** Omitted for "all" — the query then sends no status predicate. */
  engineStatus?: EngineStatus;
}

/**
 * The filter chip row. Mirrors desktop's UI_STATUSES exactly, plus "All".
 * There is no Bounced chip: see the module doc.
 */
export const SUBSCRIBER_STATUS_FILTERS: readonly SubscriberStatusFilter[] = [
  { key: "all", label: "All" },
  { key: "subscribed", label: "Subscribed", engineStatus: "enabled" },
  { key: "unsubscribed", label: "Unsubscribed", engineStatus: "blocklisted" },
  { key: "disabled", label: "Inactive", engineStatus: "disabled" },
  { key: "unconfirmed", label: "Unconfirmed", engineStatus: "unconfirmed" },
];

/** Resolve a chip key back to its definition, falling back to "All". */
export function statusFilterByKey(key: string): SubscriberStatusFilter {
  return (
    SUBSCRIBER_STATUS_FILTERS.find((f) => f.key === key) ??
    SUBSCRIBER_STATUS_FILTERS[0]!
  );
}

/**
 * The noun used in the count line ("12 unsubscribed subscribers"). "all"
 * has no adjective.
 */
export function statusFilterNoun(key: string): string {
  const filter = statusFilterByKey(key);
  return filter.key === "all" ? "" : filter.label.toLowerCase();
}
