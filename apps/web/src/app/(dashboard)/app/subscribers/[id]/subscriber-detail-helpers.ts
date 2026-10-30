// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError } from "@/lib/api";
import type {
  SubscriberTimeline,
  SubscriberTimelineEvent,
} from "@/lib/subscriber-timeline-api";

export type StatusBadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline";

export interface TimelineBucket {
  date: string;
  opens: number;
  clicks: number;
}

export interface MembershipChip {
  kind: "tag" | "list";
  name: string;
}

export interface TimelineAttemptGate {
  /**
   * Claim one exact request. A repeated same-tick claim is refused. The
   * returned release only clears its own claim, so an old subscriber's late
   * completion cannot unlock a newer subscriber's request.
   */
  begin(key: string): (() => void) | null;
}

const UNAVAILABLE_TIMELINE_STATUSES = new Set([405, 501]);

export function fmtDate(s: string | undefined | null): string {
  if (!s) return "-";
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  } catch {
    return s;
  }
}

/**
 * How the profile header dates the contact's place on the list.
 *
 * The date beside it is the profile's creation time, which for a contact who
 * has never confirmed — a double opt-in still waiting on its emailed link — is
 * only when they were added. Calling that "Subscribed" contradicted the
 * unconfirmed badge immediately beside it and the email health below, and told
 * the operator this address had opted in when nobody had.
 *
 * It reads the stored status, not the header's optimistic one: suppressing an
 * unconfirmed contact in place does not make them a past subscriber.
 */
export function profileSinceLabel(status: string | undefined | null): string {
  return (status ?? "").trim().toLowerCase() === "unconfirmed"
    ? "Added"
    : "Subscribed";
}

export function relTime(
  s: string | undefined | null,
  now = Date.now(),
): string {
  if (!s) return "-";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const diff = now - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

export function fmtPercent(rate: number | undefined): string {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "0%";
  return `${Math.round(rate * 100)}%`;
}

export function statusVariant(s: string | undefined): StatusBadgeVariant {
  switch ((s ?? "").toLowerCase()) {
    case "active":
    case "enabled":
    case "subscribed":
      return "default";
    case "suppressed":
    case "blocklisted":
    case "bounced":
      return "destructive";
    case "unsubscribed":
    case "disabled":
    case "unconfirmed":
      return "secondary";
    default:
      return "outline";
  }
}

export function isSuppressedStatus(s: string | undefined | null): boolean {
  const normalized = (s ?? "").toLowerCase();
  return normalized === "suppressed" || normalized === "blocklisted";
}

export function initialsOf(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._\-+]/).filter(Boolean);
  if (parts.length === 0) return (email[0] ?? "?").toUpperCase();
  if (parts.length === 1) {
    const first = parts[0] ?? "";
    return (first.slice(0, 2) || "?").toUpperCase();
  }
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function avatarHue(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

export function bucketTimeline(
  events: Pick<SubscriberTimelineEvent, "type" | "occurred_at">[] | undefined,
  now = new Date(),
): TimelineBucket[] {
  if (!events || events.length === 0) return [];
  const horizon = 90;
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const map = new Map<string, { opens: number; clicks: number }>();
  for (let i = horizon - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    map.set(d.toISOString().slice(0, 10), { opens: 0, clicks: 0 });
  }
  for (const ev of events) {
    const t = new Date(ev.occurred_at);
    if (Number.isNaN(t.getTime())) continue;
    const key = t.toISOString().slice(0, 10);
    const slot = map.get(key);
    if (!slot) continue;
    if (ev.type === "opened") slot.opens++;
    if (ev.type === "clicked") slot.clicks++;
  }
  return Array.from(map.entries()).map(([date, v]) => ({
    date,
    opens: v.opens,
    clicks: v.clicks,
  }));
}

export function mergeTimelinePages(
  pages: SubscriberTimeline[] | undefined,
): SubscriberTimeline | null {
  const first = pages?.[0];
  if (!first) return null;
  const seen = new Set<string>();
  const events: SubscriberTimelineEvent[] = [];
  for (const page of pages ?? []) {
    for (const event of page.events ?? []) {
      const key = `${event.type}::${event.occurred_at}::${
        event.subject_id ?? ""
      }::${event.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  const last = pages?.at(-1) ?? first;
  return {
    ...first,
    events,
    pagination: last.pagination,
  };
}

export function createTimelineAttemptGate(): TimelineAttemptGate {
  const activeKeys = new Set<string>();
  return {
    begin(key) {
      if (activeKeys.has(key)) return null;
      activeKeys.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeKeys.delete(key);
      };
    },
  };
}

export function nextTimelineCursor(
  timeline: Pick<SubscriberTimeline, "events" | "pagination">,
): string | undefined {
  if (!timeline.pagination?.has_more) return undefined;
  return timeline.pagination.next_cursor;
}

export function isTimelineUnavailableError(err: unknown): boolean {
  return (
    err instanceof ApiError && UNAVAILABLE_TIMELINE_STATUSES.has(err.status)
  );
}

export function membershipChipsFromEvents(
  events: Pick<SubscriberTimelineEvent, "type" | "occurred_at" | "detail">[],
): MembershipChip[] {
  const tags = new Set<string>();
  const lists = new Set<string>();
  const chronological = [...events].sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
  );

  for (const ev of chronological) {
    const name =
      typeof ev.detail?.name === "string"
        ? ev.detail.name
        : typeof ev.detail?.tag === "string"
          ? ev.detail.tag
          : null;
    if (!name) continue;

    if (ev.type === "tag_added") tags.add(name);
    else if (ev.type === "tag_removed") tags.delete(name);
    else if (ev.type === "list_added") lists.add(name);
    else if (ev.type === "list_removed") lists.delete(name);
  }

  return [
    ...Array.from(tags, (name): MembershipChip => ({ kind: "tag", name })),
    ...Array.from(lists, (name): MembershipChip => ({ kind: "list", name })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
