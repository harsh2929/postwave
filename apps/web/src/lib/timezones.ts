// SPDX-License-Identifier: AGPL-3.0-only
//
// Full IANA timezone list for the workspace locale picker (SETC-009).
// Prefers the runtime's `Intl.supportedValuesOf("timeZone")` (the complete,
// up-to-date zone set the platform ships) and falls back to a curated list on
// engines that don't expose it, so the picker is never empty and a user in any
// zone (e.g. America/Chicago) can select and save it.

// Curated fallback — a broad, representative spread across every continent so
// the picker still works on runtimes without Intl.supportedValuesOf.
const FALLBACK_TIMEZONES: readonly string[] = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Toronto",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Atlantic/Reykjavik",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Asia/Jerusalem",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Tehran",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Perth",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

let cachedZones: string[] | null = null;

/** The full IANA zone set (from the runtime when available). Sorted, deduped. */
export function listTimeZones(): string[] {
  if (cachedZones) return cachedZones;
  const collected = new Set<string>();
  try {
    const withSupported = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    if (typeof withSupported.supportedValuesOf === "function") {
      const zones = withSupported.supportedValuesOf("timeZone");
      if (Array.isArray(zones)) {
        for (const zone of zones) if (zone) collected.add(zone);
      }
    }
  } catch {
    // Fall through to the curated list below.
  }
  if (collected.size === 0) {
    for (const zone of FALLBACK_TIMEZONES) collected.add(zone);
  }
  // "UTC" is guaranteed present so the default value is always selectable.
  collected.add("UTC");
  cachedZones = Array.from(collected).sort((a, b) => a.localeCompare(b));
  return cachedZones;
}

/** True when the runtime recognises `tz` as a valid IANA zone. */
export function isKnownTimeZone(tz: string): boolean {
  const value = tz.trim();
  if (!value) return false;
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
