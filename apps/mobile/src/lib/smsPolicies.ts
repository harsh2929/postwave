/**
 * smsPolicies — the two SMS operator-safety policies mobile could not see:
 * quiet-hours windows and keyword auto-responses.
 *
 * Empty-country rules are enforced by the internal eligibility gate. The
 * evaluator mirrors their stored policy math but never claims a provider send,
 * callback, recipient-local jurisdiction, scheduling, or delivery outcome:
 * those hosted/downstream paths remain release-held independently.
 *
 * WHAT THE SERVER ACTUALLY RETURNS (read from the Go, not from a doc):
 *   GET /api/v1/sms/quiet-hours       → {"tenantId", "items"}       exact admin
 *   PATCH /api/v1/sms/quiet-hours/{id}                               exact admin
 *   GET /api/v1/sms/keyword-responses → {"tenantId", "items"}       exact admin
 *   PATCH /api/v1/sms/keyword-responses/{id}                   exact admin
 * Every read and write uses `protectSMSInboxResponse` plus
 * `RequireExactTenantAdmin`. The response rows are therefore private policy
 * state and must be tenant-bound before they can enter a cache.
 *
 * THE WINDOW MATH IS CONSERVATIVE. `quietRuleActive` mirrors ordinary
 * whole-day, same-day and overnight evaluation, with `days` naming the local
 * weekday a window STARTS on. The backend also resolves nonexistent and
 * repeated DST wall minutes when calculating the authoritative end instant.
 * Mobile returns unknown around an offset transition instead of approximating
 * that resolution and risking a false inactive verdict.
 *
 * ABSENCE IS NOT ZERO. Evaluating a window needs the rule's IANA zone, and a
 * device whose `Intl` cannot resolve that zone must say "can't tell from this
 * device" — never "not holding". Every evaluator here returns `null` for
 * unknown and the cards render that as a sentence, not as a green pill.
 *
 * Import-free (only the `Intl` global), so all of it is node-testable.
 */

/* ------------------------------------------------------------- contracts -- */

export interface SmsQuietHoursRule {
  id: string;
  label: string;
  countryCode: string;
  /** Minutes-of-day [0,1439], local to `timezone`. */
  startMinute: number;
  endMinute: number;
  /** Local weekdays the window STARTS on. 0 = Sunday. */
  days: number[];
  timezone: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SmsKeywordAction = "reply_only" | "opt_out";

export interface SmsKeywordResponse {
  id: string;
  keyword: string;
  responseBody: string;
  action: SmsKeywordAction;
  enabled: boolean;
  /** Historical count only; it is never evidence of current consent. */
  optInCount: number;
  /** Outbound confirmation evidence is independent from inbound state work. */
  autoReplyDispatchAvailable: boolean;
  autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held";
  createdAt: string;
  updatedAt: string;
}

const MINUTES_PER_DAY = 24 * 60;

export {
  parseKeywordResponses,
  parseQuietHoursRules,
  RESERVED_SMS_KEYWORDS,
} from "./smsPolicyContracts";

/* ------------------------------------------------------------- rendering -- */

export function minuteLabel(minute: number): string {
  if (!Number.isFinite(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
    return "—";
  }
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Every day" / "Weekdays" / "Weekends" / "Mon, Wed, Fri" / "No days". */
export function daysLabel(days: readonly number[]): string {
  const set = [...new Set(days.filter((d) => d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
  if (set.length === 0) return "No days";
  if (set.length === 7) return "Every day";
  if (set.join() === "1,2,3,4,5") return "Weekdays";
  if (set.join() === "0,6") return "Weekends";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}

/**
 * The window as words. A rule whose start equals its end covers the WHOLE
 * listed day server-side, and rendering that as "09:00 – 09:00" reads as a
 * zero-length window — the exact opposite of what it does.
 */
export function windowLabel(rule: SmsQuietHoursRule): string {
  if (rule.startMinute === rule.endMinute) return "All day";
  return `${minuteLabel(rule.startMinute)} – ${minuteLabel(rule.endMinute)}`;
}

/* ------------------------------------------------------------ evaluation -- */

export interface ZonedNow {
  /** Minute-of-day in the target zone, [0,1439]. */
  minute: number;
  /** Weekday in the target zone, 0 = Sunday. */
  weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Wall-clock minute + weekday in an IANA zone, or `null` when this device
 * cannot resolve it.
 *
 * `Intl.DateTimeFormat` throws a RangeError on an unknown zone, and a runtime
 * built without the timezone database can silently fall back to the device
 * zone — which would produce a confidently WRONG "not holding". Both cases
 * return null so the caller reports "can't tell" instead.
 */
export function zonedNow(nowMs: number, timeZone: string): ZonedNow | null {
  const zone = timeZone.trim();
  if (!zone || !Number.isFinite(nowMs)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    let hour: number | null = null;
    let minute: number | null = null;
    let weekday: number | null = null;
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value) % 24;
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") {
        const index = WEEKDAY_INDEX[part.value];
        if (index !== undefined) weekday = index;
      }
    }
    if (
      hour === null ||
      minute === null ||
      weekday === null ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    return { minute: hour * 60 + minute, weekday };
  } catch {
    return null;
  }
}

function zoneOffsetMinutes(nowMs: number, timeZone: string): number | null {
  try {
    const instant = Math.floor(nowMs / 60_000) * 60_000;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values: Record<string, number> = {};
    for (const part of parts) {
      if (
        part.type === "year" ||
        part.type === "month" ||
        part.type === "day" ||
        part.type === "hour" ||
        part.type === "minute"
      ) {
        values[part.type] = Number(part.value);
      }
    }
    if (
      !Number.isInteger(values.year) ||
      !Number.isInteger(values.month) ||
      !Number.isInteger(values.day) ||
      !Number.isInteger(values.hour) ||
      !Number.isInteger(values.minute)
    ) {
      return null;
    }
    const localAsUtc = Date.UTC(
      values.year as number,
      (values.month as number) - 1,
      values.day as number,
      (values.hour as number) % 24,
      values.minute as number,
    );
    const offset = (localAsUtc - instant) / 60_000;
    return Number.isInteger(offset) && Math.abs(offset) <= 14 * 60
      ? offset
      : null;
  } catch {
    return null;
  }
}

/**
 * The mobile projection deliberately becomes unknown on a transition day.
 * The backend resolves a spring gap to the first real minute after the gap and
 * a repeated fall minute to its latest occurrence; local weekday/minute alone
 * cannot prove those boundaries. A 24-hour bracket covers the transition day
 * without weakening ordinary evaluation away from it.
 */
function timezoneStableNear(nowMs: number, timeZone: string): boolean | null {
  const offsets = [-12, 0, 12].map((hours) =>
    zoneOffsetMinutes(nowMs + hours * 60 * 60 * 1_000, timeZone),
  );
  if (offsets.some((offset) => offset === null)) return null;
  return offsets.every((offset) => offset === offsets[0]);
}

/**
 * Would this stored rule evaluate active at this device's current instant?
 *
 * `true` / `false` describe stored-rule math only; `null` means this device
 * cannot safely evaluate it and must never become a reassuring live-outcome
 * claim. A disabled rule or an out-of-range minute is a definite `false`.
 */
export function quietRuleActive(
  rule: SmsQuietHoursRule,
  nowMs: number,
): boolean | null {
  if (!rule.enabled) return false;
  if (
    rule.countryCode !== "" ||
    rule.startMinute < 0 ||
    rule.startMinute >= MINUTES_PER_DAY ||
    rule.endMinute < 0 ||
    rule.endMinute >= MINUTES_PER_DAY ||
    !Number.isInteger(rule.startMinute) ||
    !Number.isInteger(rule.endMinute) ||
    !Array.isArray(rule.days) ||
    rule.days.length < 1 ||
    rule.days.length > 7 ||
    rule.days.some(
      (day, index) =>
        !Number.isInteger(day) ||
        day < 0 ||
        day > 6 ||
        (index > 0 && day <= (rule.days[index - 1] ?? -1)),
    )
  ) {
    return null;
  }
  const local = zonedNow(nowMs, rule.timezone);
  if (!local) return null;
  if (timezoneStableNear(nowMs, rule.timezone) !== true) return null;
  const startsToday = rule.days.includes(local.weekday);
  const startedYesterday = rule.days.includes((local.weekday + 6) % 7);

  // Whole-day window on the listed days.
  if (rule.startMinute === rule.endMinute) return startsToday;
  // Same-day window, e.g. 09:00 → 17:00.
  if (rule.startMinute < rule.endMinute) {
    return (
      startsToday &&
      local.minute >= rule.startMinute &&
      local.minute < rule.endMinute
    );
  }
  // Overnight window crossing midnight, e.g. 21:00 → 09:00.
  if (startsToday && local.minute >= rule.startMinute) return true;
  return startedYesterday && local.minute < rule.endMinute;
}

export interface QuietHoursSummary {
  /** True when at least one enabled stored rule evaluates active. */
  holding: boolean | null;
  /** One spoken sentence — the card's accessibility summary. */
  sentence: string;
  tone: "success" | "warning" | "neutral";
}

/**
 * Fold every rule into the one sentence the operator came for.
 *
 * Unknown beats an inactive verdict: if any enabled rule cannot be evaluated
 * and none of the evaluable ones is active, the answer is "can't tell". No arm
 * is evidence of a provider hold, dispatch, callback, or delivery outcome.
 */
export function quietHoursSummary(
  rules: readonly SmsQuietHoursRule[],
  nowMs: number,
): QuietHoursSummary {
  const enabled = rules.filter((rule) => rule.enabled);
  if (rules.length === 0) {
    return {
      holding: false,
      sentence:
        "No stored quiet-hours rule is configured. This makes no live-delivery claim; SMS dispatch remains release-held.",
      tone: "neutral",
    };
  }
  if (enabled.length === 0) {
    return {
      holding: false,
      sentence: `${rules.length} stored quiet-hours ${rules.length === 1 ? "rule is" : "rules are"} switched off. This makes no live-delivery claim; SMS dispatch remains release-held.`,
      tone: "neutral",
    };
  }
  let unknown = 0;
  const active: SmsQuietHoursRule[] = [];
  for (const rule of enabled) {
    const state = quietRuleActive(rule, nowMs);
    if (state === null) unknown += 1;
    else if (state) active.push(rule);
  }
  if (active.length > 0) {
    const first = active[0];
    const name =
      first && first.label.trim()
        ? first.label.trim()
        : first
          ? windowLabel(first)
          : "A window";
    return {
      holding: true,
      sentence:
        active.length === 1
          ? `${name} is active at this device evaluation time and would hold an otherwise eligible outbound text. SMS dispatch remains release-held.`
          : `${active.length} windows, including ${name}, are active as stored tenant-global rules at this device evaluation time and would hold an otherwise eligible outbound text. SMS dispatch remains release-held.`,
      tone: "warning",
    };
  }
  if (unknown > 0) {
    return {
      holding: null,
      sentence: `Evaluation is unknown: this device can't evaluate ${unknown === enabled.length ? "these stored rules'" : "one stored rule's"} timezone. No live hold or delivery outcome can be inferred.`,
      tone: "neutral",
    };
  }
  return {
    holding: false,
    sentence: `No stored quiet-hours rule evaluates active at this device evaluation time. ${enabled.length === 1 ? "One rule remains" : `${enabled.length} rules remain`} enabled; this makes no live-delivery claim and SMS dispatch remains release-held.`,
    tone: "success",
  };
}

/* ------------------------------------------------------- keyword helpers -- */

export function keywordActionLabel(action: SmsKeywordAction): string {
  if (action === "opt_out") return "Opt-out state rule";
  return "Stored reply — dispatch held";
}

export function canToggleSmsKeywordResponse(
  row: Pick<SmsKeywordResponse, "action">,
): boolean {
  return row.action === "opt_out";
}
