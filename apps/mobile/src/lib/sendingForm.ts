/**
 * sendingForm — the pure decision layer behind the sending-settings form.
 *
 * Two things it fixes beyond being testable.
 *
 * 1. TIMEZONE VALIDATION. The field was free text on a phone keyboard, so
 *    "America/new_york", "EST" and a stray autocorrect capital all sailed
 *    through to a 400 — or worse, saved and silently mis-scheduled quiet hours.
 *    `timezoneError` asks the platform whether the zone actually resolves,
 *    which is the same check the server's `time.LoadLocation` performs.
 *
 * 2. DST. A quiet window that starts before a spring-forward transition and
 *    ends after it is one hour shorter than it reads — the operator sets
 *    22:00-07:00 and gets eight hours of quiet, once a year, silently. We
 *    cannot fix that (the server owns the semantics), but we can say it.
 *
 * Imports nothing from react-native, so it runs under the node vitest project.
 */

export interface SendingFormState {
  maxSendsPerHour: string;
  quietStart: string;
  quietEnd: string;
  quietTz: string;
  perRecipient: boolean;
}

export interface SendingFieldErrors {
  maxSendsPerHour?: string;
  quietStart?: string;
  quietEnd?: string;
  quietTz?: string;
}

/**
 * The server's hourly ceiling — mirrors
 * apps/api/internal/sendingsettings/sendingsettings.go:98 `MaxSendsPerHour`.
 * No generated contract carries it, so this is the ONE mobile copy: the form,
 * the row schema, the status parser and the reconcile proof all read it, and
 * sendingSettingsMutation.test.ts asks all four the same question at the edge.
 */
export const MAX_SENDS_PER_HOUR = 1_000_000;

/** 24-hour HH:MM, the only time shape the server stores. */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** A stored cap: absent or null (no cap), or a whole number in 1..MAX. */
export function isCanonicalSendsPerHour(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= MAX_SENDS_PER_HOUR)
  );
}

/**
 * A stored quiet window, as the server accepts it: all three fields empty, or
 * two DIFFERENT valid HH:MM times in a zone that resolves. An equal pair is no
 * window at all, and the server refuses it (equal_quiet_hours).
 */
export function isCoherentQuietHours(
  start: string,
  end: string,
  tz: string,
): boolean {
  if (!start && !end && !tz) return true;
  return (
    HHMM_RE.test(start) &&
    HHMM_RE.test(end) &&
    start !== end &&
    isKnownTimezone(tz)
  );
}

/**
 * `Intl.DateTimeFormat` throws a RangeError for an unknown IANA zone. Hermes
 * ships a full ICU build, but guard the whole call anyway: on a stripped
 * runtime the constructor may accept anything, in which case we must NOT
 * report a false error on a zone the server would have accepted.
 */
export function isKnownTimezone(value: string): boolean {
  const zone = value.trim();
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function validateSendingForm(
  form: SendingFormState,
): SendingFieldErrors {
  const errs = quietHoursErrors(form);
  const cap = capError(form.maxSendsPerHour);
  return cap ? { maxSendsPerHour: cap, ...errs } : errs;
}

function capError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return "Enter a positive whole number, or leave blank.";
  }
  if (n > MAX_SENDS_PER_HOUR) {
    return "Above 1,000,000/hour is almost certainly wrong.";
  }
  return null;
}

function quietHoursErrors(form: SendingFormState): SendingFieldErrors {
  const errs: SendingFieldErrors = {};
  const start = form.quietStart.trim();
  const end = form.quietEnd.trim();
  const tz = form.quietTz.trim();
  if (start && !HHMM_RE.test(start)) {
    errs.quietStart = "Use 24-hour HH:MM (e.g. 22:00).";
  }
  if (end && !HHMM_RE.test(end)) {
    errs.quietEnd = "Use 24-hour HH:MM (e.g. 07:00).";
  }
  if (tz && !isKnownTimezone(tz)) {
    errs.quietTz =
      "Not a timezone this device recognises (e.g. America/New_York).";
  }

  // All-or-nothing: a partial quiet-hours config is rejected server-side.
  const anyQuiet = Boolean(start || end || tz);
  const allQuiet = Boolean(start && end && tz);
  if (anyQuiet && !allQuiet) {
    if (!start && !errs.quietStart) {
      errs.quietStart = "Required when quiet hours are set.";
    }
    if (!end && !errs.quietEnd) {
      errs.quietEnd = "Required when quiet hours are set.";
    }
    if (!tz && !errs.quietTz) {
      errs.quietTz = "Required when quiet hours are set.";
    }
  }

  // A window that ends when it starts is no window. The server refuses it
  // (equal_quiet_hours) and so does isCoherentQuietHours on both wire schemas;
  // without this the PUT went out and came back as an unmarked toast.
  if (start && start === end && !errs.quietStart && !errs.quietEnd) {
    errs.quietEnd = "End time must differ from the start time.";
  }

  return errs;
}

export function firstSendingError(errs: SendingFieldErrors): string | null {
  return (
    errs.maxSendsPerHour ??
    errs.quietStart ??
    errs.quietEnd ??
    errs.quietTz ??
    null
  );
}

export function sendingFormDirty(
  a: SendingFormState,
  b: SendingFormState,
): boolean {
  return (
    a.maxSendsPerHour !== b.maxSendsPerHour ||
    a.quietStart !== b.quietStart ||
    a.quietEnd !== b.quietEnd ||
    a.quietTz !== b.quietTz ||
    a.perRecipient !== b.perRecipient
  );
}

export interface SendingRowLike {
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  updated_at?: string;
}

export function sendingFormFromRow(
  row: SendingRowLike | undefined,
): SendingFormState {
  return {
    maxSendsPerHour:
      row?.max_sends_per_hour != null ? String(row.max_sends_per_hour) : "",
    quietStart: row?.quiet_hours_start ?? "",
    quietEnd: row?.quiet_hours_end ?? "",
    quietTz: row?.quiet_hours_tz ?? "",
    perRecipient: row?.quiet_hours_per_recipient ?? true,
  };
}

/** True when the saved row actually has a cap or quiet hours configured. */
export function isThrottleConfigured(row: SendingRowLike | undefined): boolean {
  if (!row) return false;
  return Boolean(
    (row.max_sends_per_hour ?? 0) > 0 ||
    row.quiet_hours_start ||
    row.quiet_hours_end ||
    row.quiet_hours_tz,
  );
}

/**
 * The Go handler returns updated_at = epoch zero ("0001-01-01") before a row
 * exists. Don't render "1/1/1, 12:00:00 AM" — only report a real save.
 */
export function savedAtValue(updatedAt: string | undefined): string | null {
  if (!updatedAt) return null;
  const ms = new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return updatedAt;
}

/**
 * Exact compare-and-set token for a full-row settings replacement. The API's
 * Go zero timestamp means the row has never been written, which is asserted
 * with an empty token; a missing or malformed token is not safe to mutate.
 */
export function sendingSettingsExpectedRevision(
  updatedAt: string | undefined,
): string | null {
  const revision = updatedAt?.trim() ?? "";
  if (!revision) return null;
  if (revision === "0001-01-01T00:00:00Z") return "";
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      revision,
    );
  if (!match || !Number.isFinite(Date.parse(revision))) return null;

  // Date.parse normalises impossible calendar dates in some runtimes, so the
  // source tuple must be checked independently before it becomes a CAS token.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHours = Number(match[4] ?? 0);
  const offsetMinutes = Number(match[5] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    offsetHours > 14 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return null;
  }
  return revision;
}

/** A canonical settings row is usable only for the workspace that requested it. */
export function sendingSettingsMatchesTenant(
  row: { tenant_id?: unknown },
  expectedTenantId: string | null | undefined,
): boolean {
  return (
    typeof row.tenant_id === "string" &&
    row.tenant_id.length > 0 &&
    row.tenant_id === expectedTenantId
  );
}

/**
 * Whether a DST transition falls inside the next 14 days for this zone, so the
 * form can warn that the quiet window will be an hour short (or long) once.
 * Returns null when the zone is unknown or the platform can't answer.
 */
export function dstWarning(
  tz: string,
  { now = Date.now(), days = 14 } = {},
): string | null {
  const zone = tz.trim();
  if (!zone || !isKnownTimezone(zone)) return null;
  const offsetAt = (ms: number): number | null => {
    try {
      // The zone's wall-clock reading of an instant, compared with UTC's,
      // gives the offset without any Date parsing ambiguity.
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(new Date(ms));
      const get = (type: string) =>
        Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
      const asUTC = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
      );
      if (!Number.isFinite(asUTC)) return null;
      return Math.round((asUTC - ms) / 60_000);
    } catch {
      return null;
    }
  };
  const start = offsetAt(now);
  const end = offsetAt(now + days * 24 * 60 * 60 * 1000);
  if (start === null || end === null || start === end) return null;
  const forward = end > start;
  return forward
    ? `${zone} moves its clocks forward within the next ${days} days — the quiet window will be one hour shorter that night.`
    : `${zone} moves its clocks back within the next ${days} days — the quiet window will be one hour longer that night.`;
}

/**
 * Why operational coordination status is missing, in the user's terms.
 *
 * The status endpoint is a SIDE signal: it reports what is happening right
 * now, while the form below it reports what is configured. When the side
 * signal cannot be read, the screen must say so — silence there reads as
 * "nothing is throttling you", which is the opposite of unknown, and could
 * lead an operator to lift a cap that is in fact still holding.
 *
 * Every branch reasserts that the SAVED configuration is still accurate. The
 * current contract does not expose an authoritative shared usage counter.
 */
export function sendingStatusReason(input: {
  online: boolean;
  failed: boolean;
}): string {
  if (!input.online) {
    return "You're offline, so quiet-hours and cap-coordination status can't be read. The saved configuration below is still accurate; hourly usage telemetry is not available from this endpoint.";
  }
  if (input.failed) {
    return "Operational quiet-hours and cap-coordination status couldn't be loaded. The saved configuration below is still accurate; hourly usage telemetry is not available from this endpoint.";
  }
  return "Loading quiet-hours and cap-coordination status…";
}
