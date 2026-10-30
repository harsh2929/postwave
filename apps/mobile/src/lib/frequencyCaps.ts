/**
 * Per-subscriber frequency caps — parsing and presentation (DELIVERABILITY#54).
 *
 * WHY THIS IS A PHONE SCREEN AT ALL. When a send goes out to fewer people than
 * expected, "a cap deferred them" is one of the few explanations that is
 * invisible from every other surface: nothing in the campaign report says a
 * message was held back by a rule, and the workspace-wide throttle on
 * sending-settings is a different mechanism entirely. "What caps are in force,
 * and is this one on?" is a read plus one toggle, which is exactly the shape a
 * phone is good at. Authoring the rules — channel, message type, count, window,
 * audience — stays on desktop.
 *
 * WHICH ENDPOINT. There are TWO parallel cap surfaces in the API and they are
 * NOT the same table:
 *
 *   /api/v1/frequency-caps          apps/api/internal/freq_caps/handlers.go
 *   /api/v1/sending/frequency-caps  apps/api/internal/frequency/frequency.go
 *
 * This module targets the FIRST. `freq_caps.MountRoutes` is the one whose
 * `WouldDefer` is called by the send loop, and its list/patch pair is the
 * minimum needed for a read plus a toggle. Picking by coin-flip would have
 * shown one table and toggled the other.
 *
 * AUTHORISATION, READ FROM BOTH PLACES. The list is
 * `RequireScope(ScopeReadReports)` at the mount site and `viewer` /
 * `read:reports` in routeauth's manifest, so any session can read. The PATCH is
 * `RequireScope(ScopeAdmin)` at the mount site and `admin` in the manifest, so
 * the toggle is owner/admin only — the stricter of the two binds, and both say
 * admin. The toggle is therefore ABSENT, not disabled, for anyone else.
 *
 * Import-free: parsing and copy are unit-tested in the node environment.
 */

export interface FrequencyCap {
  id: string;
  label: string;
  channel: string;
  messageType: string;
  /** `null` when the server did not send a count — rendered as an em-dash. */
  maxCount: number | null;
  windowSeconds: number | null;
  appliesTo: string;
  active: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The list envelope is `{caps: [...], count: n}`. Tolerates a bare array and a
 * `{items}` envelope too, because this app talks to whatever API version the
 * workspace is pinned to and a shape drift must not silently empty the screen.
 */
export function parseFrequencyCaps(payload: unknown): FrequencyCap[] {
  const env = record(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(env.caps)
      ? env.caps
      : Array.isArray(env.items)
        ? env.items
        : [];
  const out: FrequencyCap[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = record(raw[i]);
    const id = text(row.id);
    if (id === "") continue;
    out.push({
      id,
      label: text(row.label) || "Untitled cap",
      channel: text(row.channel) || "all",
      messageType: text(row.message_type) || "all",
      maxCount: numberOrNull(row.max_count),
      windowSeconds: numberOrNull(row.window_seconds),
      appliesTo: text(row.applies_to) || "all",
      // A cap whose `active` the server did not state is NOT assumed on: an
      // operator reading "on" for a rule that is off would go looking for a
      // suppression that is not happening.
      active: row.active === true,
    });
  }
  return out;
}

/** The single cap the PATCH response wraps in `{cap: ...}`. */
export function parseFrequencyCap(payload: unknown): FrequencyCap | null {
  const env = record(payload);
  const one = parseFrequencyCaps({ caps: [env.cap ?? env] });
  return one[0] ?? null;
}

/**
 * "3 per 24 hours" — the sentence a rule actually means. Both halves can be
 * absent independently, and neither may be invented.
 */
export function capRuleLine(cap: FrequencyCap): string {
  const count = cap.maxCount === null ? "—" : String(cap.maxCount);
  const window = humanWindow(cap.windowSeconds);
  return `${count} per ${window}`;
}

export function humanWindow(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "—";
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "day" : `${days} days`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "minute" : `${minutes} minutes`;
  }
  return `${seconds} seconds`;
}

/** "Email · marketing · all subscribers" — the rule's scope, spelled out. */
export function capScopeLine(cap: FrequencyCap): string {
  const parts = [
    cap.channel === "all" ? "All channels" : titleCase(cap.channel),
    cap.messageType === "all" ? "all message types" : cap.messageType,
    cap.appliesTo === "all" ? "all subscribers" : cap.appliesTo,
  ];
  return parts.join(" · ");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * What the screen says above the list. An INACTIVE cap enforces nothing, so a
 * workspace with four rules that are all off is not "protected by four caps" —
 * saying "4 caps" there would be the single most misleading sentence this
 * screen could print.
 */
export function capsSummaryLine(caps: readonly FrequencyCap[]): string {
  if (caps.length === 0) return "No frequency caps are configured.";
  const active = caps.filter((c) => c.active).length;
  if (active === 0) {
    return `${caps.length} cap${caps.length === 1 ? "" : "s"} configured — none of them are enforcing.`;
  }
  return `${active} of ${caps.length} cap${caps.length === 1 ? "" : "s"} enforcing right now.`;
}

/**
 * The same line, but only when the read actually landed.
 *
 * `capsSummaryLine([])` says "No frequency caps are configured." — an all-clear
 * about how this workspace treats its subscribers. Computed off `data ?? []` it
 * gets said for a 500, for a closed gate and for a read that never ran, because
 * every one of those leaves the array empty. The list below the header goes
 * through QueryStates and shows the error; the header is an
 * `accessibilityLiveRegion` that was announcing the opposite over the top of it.
 *
 * `loaded` must be the query's own success, not "the array is non-empty": a
 * workspace with genuinely zero caps and a workspace whose read failed produce
 * the same array, and only the query knows which one this is.
 */
export function capsSummaryHeadline(input: {
  loaded: boolean;
  caps: readonly FrequencyCap[];
}): string {
  if (input.loaded) return capsSummaryLine(input.caps);
  return "Caps couldn't be read just now — this isn't a claim that none are set.";
}

/** Spoken confirmation for a toggle, so the result is not colour-only. */
export function capToggleAnnouncement(
  cap: FrequencyCap,
  nextActive: boolean,
): string {
  return nextActive
    ? `${cap.label} is now enforcing: ${capRuleLine(cap)}.`
    : `${cap.label} is now off and will not defer any message.`;
}
