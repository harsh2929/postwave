/**
 * lib/complianceOps.ts — two desk-shaped systems, reduced to the one question
 * each that belongs on a phone.
 *
 * ── DSAR: A STATUTORY CLOCK NOBODY COULD SEE ───────────────────────────────
 * `apps/api/internal/sar/sar.go` mounts create / list / fetch / `{id}.zip` /
 * store-responses, all admin. Desktop has a `DSARModal`; mobile had
 * `privacyIncidents.ts` and `compliance.ts` and no SAR path at all.
 *
 * The honest mobile slice is the QUEUE WITH ITS DEADLINES — "3 requests, the
 * oldest 21 days old" — and nothing else. GDPR Art. 12(3) gives one month, and
 * the number that matters away from a desk is how close the oldest one is to
 * it. Fulfilling a request is desk work; noticing you are about to miss the
 * deadline is not.
 *
 * `{id}.zip` IS DELIBERATELY ABSENT AND STAYS ABSENT. It is a data-egress
 * action that hands over a bundle of one person's personal data, and a phone is
 * the worst place to receive it: it lands in a shared Downloads folder, on a
 * device that may be someone's personal handset, with no chain of custody.
 *
 * ── MAINTENANCE WINDOWS: HALF OF "WHY IS NOTHING SENDING?" ─────────────────
 * `maintenance.go` is desktop-only. Authoring a window on a phone is not worth
 * building, but "is a window open RIGHT NOW" belongs on the same banner as a
 * tenant pause, because both answer the same 2am question and an operator who
 * checks only one of them draws the wrong conclusion from the other.
 *
 * No react-native imports — imported by node-run vitest.
 */
import { num } from "./format";

// ---------------------------------------------------------------------------
// DSAR queue
// ---------------------------------------------------------------------------

export interface SarRequestLike {
  id: string;
  kind: string;
  status: string;
  requested_at: string;
  ready_at?: string | null;
  error?: string | undefined;
}

const DAY_MS = 86_400_000;

/**
 * The regulatory response window. GDPR Art. 12(3) is one month; 30 days is the
 * conservative reading of it and the one every DSAR tool uses, so a workspace
 * acting on this number is never late by treating a long month as short.
 */
export const DSAR_RESPONSE_DAYS = 30;

function at(value: string | null | undefined): number {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** A request still owing an answer. Anything terminal stops the clock. */
export function sarIsOpen(request: SarRequestLike): boolean {
  const status = request.status.trim().toLowerCase();
  if (status === "ready" || status === "complete" || status === "completed") {
    return false;
  }
  if (status === "failed" || status === "error") {
    // A failed request still owes the subject an answer — it has not been
    // fulfilled, it has broken. Treating it as closed would hide the case most
    // likely to run out the clock.
    return true;
  }
  return !request.ready_at;
}

/** Whole days since the request arrived. Never negative. */
export function sarAgeDays(
  request: SarRequestLike,
  now: number = Date.now(),
): number {
  const requested = at(request.requested_at);
  if (requested <= 0) return 0;
  return Math.max(0, Math.floor((now - requested) / DAY_MS));
}

export function sarDaysRemaining(
  request: SarRequestLike,
  now: number = Date.now(),
): number {
  return DSAR_RESPONSE_DAYS - sarAgeDays(request, now);
}

export type SarUrgency = "ok" | "due_soon" | "overdue";

/**
 * How close this one is to the statutory deadline.
 *
 * `due_soon` starts at a week out rather than a day: a DSAR takes real work to
 * fulfil, so a warning that arrives with 24 hours left is not actionable — it
 * is just a record of having missed it.
 */
export function sarUrgency(
  request: SarRequestLike,
  now: number = Date.now(),
): SarUrgency {
  const remaining = sarDaysRemaining(request, now);
  if (remaining < 0) return "overdue";
  return remaining <= 7 ? "due_soon" : "ok";
}

/**
 * The one line the phone exists to show.
 *
 * Names the count AND the oldest, because the count alone cannot distinguish
 * "three arrived this morning" from "one has been sitting for 29 days" — and
 * those call for completely different reactions.
 */
export function sarQueueSummary(
  requests: readonly SarRequestLike[],
  now: number = Date.now(),
): string | null {
  // Defensive about the ARRAY, not just its contents. These two functions sit
  // between wire data and the two screens an operator opens first, and the
  // failure mode of trusting the shape is a crashed dashboard rather than a
  // missing banner. A non-array means "nothing to say", never a thrown error.
  const open = (Array.isArray(requests) ? requests : []).filter(sarIsOpen);
  if (open.length === 0) return null;
  const oldest = open.reduce((worst, r) =>
    sarAgeDays(r, now) > sarAgeDays(worst, now) ? r : worst,
  );
  const age = sarAgeDays(oldest, now);
  const remaining = sarDaysRemaining(oldest, now);
  const clock =
    remaining < 0
      ? `the oldest is ${num(age)} days old and PAST the ${DSAR_RESPONSE_DAYS}-day deadline`
      : `the oldest is ${num(age)} days old, ${num(remaining)} days before the ${DSAR_RESPONSE_DAYS}-day deadline`;
  return `${num(open.length)} open subject request${open.length === 1 ? "" : "s"} — ${clock}.`;
}

/** The worst urgency in the queue, for the banner's tone. */
export function sarQueueUrgency(
  requests: readonly SarRequestLike[],
  now: number = Date.now(),
): SarUrgency | null {
  const open = (Array.isArray(requests) ? requests : []).filter(sarIsOpen);
  if (open.length === 0) return null;
  if (open.some((r) => sarUrgency(r, now) === "overdue")) return "overdue";
  if (open.some((r) => sarUrgency(r, now) === "due_soon")) return "due_soon";
  return "ok";
}

// ---------------------------------------------------------------------------
// Maintenance windows
// ---------------------------------------------------------------------------

export interface MaintenanceWindowLike {
  id: string;
  title: string;
  components: string[];
  starts_at: string;
  ends_at: string;
  status: string;
}

/** Open right now — the only maintenance question a phone needs answered. */
export function windowIsOpen(
  window: MaintenanceWindowLike,
  now: number = Date.now(),
): boolean {
  const status = window.status.trim().toLowerCase();
  if (status === "cancelled" || status === "canceled" || status === "completed") {
    return false;
  }
  const starts = at(window.starts_at);
  const ends = at(window.ends_at);
  // An unparseable bound must not silently read as "open forever" or "never
  // open"; requiring both to parse keeps a malformed row out of the banner
  // rather than letting it assert something false.
  if (starts <= 0 || ends <= 0) return false;
  return starts <= now && now < ends;
}

/** Scheduled, hasn't started. Worth knowing, not worth alarming about. */
export function windowIsUpcoming(
  window: MaintenanceWindowLike,
  now: number = Date.now(),
  withinMs: number = DAY_MS,
): boolean {
  const status = window.status.trim().toLowerCase();
  if (status === "cancelled" || status === "canceled" || status === "completed") {
    return false;
  }
  const starts = at(window.starts_at);
  if (starts <= 0) return false;
  return starts > now && starts - now <= withinMs;
}

/**
 * The banner sentence, or null when there is nothing to say.
 *
 * An OPEN window outranks an upcoming one: "maintenance is happening now" is
 * the answer to "why is nothing sending", and burying it under a schedule
 * notice would defeat the purpose of the banner.
 */
export function maintenanceBanner(
  windows: readonly MaintenanceWindowLike[],
  now: number = Date.now(),
): string | null {
  const list: readonly MaintenanceWindowLike[] = Array.isArray(windows)
    ? windows
    : [];
  const open = list.find((w) => windowIsOpen(w, now));
  if (open) {
    const parts = open.components.filter((c) => c.trim());
    const scope = parts.length > 0 ? ` Affects ${parts.join(", ")}.` : "";
    return `Maintenance in progress: ${open.title}.${scope}`;
  }
  const soon = list.find((w) => windowIsUpcoming(w, now));
  if (soon) return `Maintenance scheduled: ${soon.title}.`;
  return null;
}
