const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SEND_TIME_AUDIENCE_MINIMUM = 30;

export function isSubscriberUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export function normalizeSubscriberUuid(value: string): string {
  return value.trim().toLowerCase();
}

export type LocalDateTimeResult =
  | { ok: true; iso: string | undefined }
  | { ok: false; message: string };

export function parseOptionalLocalDateTime(value: string): LocalDateTimeResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, iso: undefined };
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message: "Enter a valid reference date and time.",
    };
  }
  return { ok: true, iso: parsed.toISOString() };
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function decomposeHourOfWeek(hour: number): {
  weekday: string;
  hourOfDay: number;
} {
  if (!Number.isInteger(hour) || hour < 0 || hour > 167) {
    return { weekday: "Unknown day", hourOfDay: -1 };
  }
  return {
    weekday: WEEKDAYS[Math.floor(hour / 24)] ?? "Unknown day",
    hourOfDay: hour % 24,
  };
}

export function formatHour(hour: number, minute = 0): string {
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return "—";
  }
  const meridiem = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

export function formatRelativeDate(
  value: string | undefined | null,
  now = Date.now(),
): string {
  if (!value) return "Unknown";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatAbsoluteDate(value: string | undefined | null): string {
  if (!value) return "Timestamp unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Timestamp unavailable";
  return parsed.toLocaleString();
}

export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1)
    return "Address protected";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const visibleLocal =
    local.length <= 2 ? local.slice(0, 1) : `${local.slice(0, 2)}…`;
  return `${visibleLocal}@${domain}`;
}

export function describeApiError(error: {
  code?: string;
  message: string;
}): string {
  return error.code ? `[${error.code}] ${error.message}` : error.message;
}
