/**
 * lib/pushQuietHours.ts — the do-not-disturb window for THIS installation's push.
 *
 * ── WHY THIS EXISTS AND WHY IT IS SERVER-BACKED ────────────────────────────
 * Mobile has had a quiet-hours card for SMS for a long time and none for its own
 * notifications, so an operator woken at 3am by an approval push had nowhere to say
 * "not overnight". The server half shipped to close mobile finding SHELL#12 —
 * migration 1814_mobile_push_quiet_hours.sql plus
 * apps/api/internal/mobilepush/quiet_hours.go and
 * POST /api/v1/mobile/push/devices/quiet-hours (devices.go:75) — and the client
 * half never landed, so the endpoint had no caller on any surface. The finding is
 * recorded `confirmed` in the 2026-07-25 remediation ledger, which is how a
 * capability can be simultaneously "closed" and unreachable.
 *
 * The window MUST be server-side, and that is the reason the route exists rather
 * than a local switch: APNs/FCM deliver from the API, not from the app, so a purely
 * local toggle would be a control that controls nothing. SHELL#12's own note makes
 * exactly that argument.
 *
 * ── WHY IT MIRRORS SMS ─────────────────────────────────────────────────────
 * The window semantics are deliberately identical to SMS quiet hours — the Go
 * migration says so in as many words ("Window semantics mirror
 * apps/api/internal/sms/quiet_hours.go so the platform..."). So this module reuses
 * `minuteLabel` rather than growing a second, subtly different projection: two
 * formatters for one concept is how 21:00 becomes 9:00 PM on one screen and 21:00
 * on the next.
 *
 * Import-free of react-native, so every rule here is node-tested.
 */
import { minuteLabel } from "@/lib/smsPolicies";

export const MINUTES_PER_DAY = 1440;

/** The server's defaults (migration 1814): 21:00 → 09:00 local, disabled. */
export const PUSH_QUIET_HOURS_DEFAULT = {
  enabled: false,
  startMinute: 1260,
  endMinute: 540,
  timezone: "UTC",
} as const;

export interface PushQuietHours {
  enabled: boolean;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

/** The server's wire shape for a window. */
export interface PushQuietHoursWire {
  enabled?: unknown;
  start_minute?: unknown;
  end_minute?: unknown;
  timezone?: unknown;
}

function usableMinute(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= MINUTES_PER_DAY) return fallback;
  return n;
}

/**
 * Read a window off the wire, falling back to the server's own defaults per field.
 *
 * Defensive per FIELD rather than per object: a response that carries a good
 * `enabled` and a nonsense `end_minute` should keep the part it got right, because
 * the alternative is telling the user their window is off when the server says it
 * is on.
 */
export function parsePushQuietHours(
  wire: PushQuietHoursWire | null | undefined,
): PushQuietHours {
  return {
    enabled: wire?.enabled === true,
    startMinute: usableMinute(
      wire?.start_minute,
      PUSH_QUIET_HOURS_DEFAULT.startMinute,
    ),
    endMinute: usableMinute(
      wire?.end_minute,
      PUSH_QUIET_HOURS_DEFAULT.endMinute,
    ),
    timezone:
      typeof wire?.timezone === "string" && wire.timezone.trim() !== ""
        ? wire.timezone.trim()
        : PUSH_QUIET_HOURS_DEFAULT.timezone,
  };
}

/** True when the window runs past local midnight, as the default 21:00→09:00 does. */
export function pushQuietHoursWraps(window: PushQuietHours): boolean {
  return window.endMinute <= window.startMinute;
}

/**
 * One sentence naming exactly what is suppressed and when.
 *
 * Says "wrapping to the next day" explicitly for a midnight-crossing window: a bare
 * "21:00 – 09:00" reads to some people as a nine-hour daytime span, and a window
 * the user misreads is a window they will blame for a missed alert.
 */
export function pushQuietHoursSummary(window: PushQuietHours): string {
  if (!window.enabled) {
    return "Notifications arrive at any time of day.";
  }
  const span = `${minuteLabel(window.startMinute)} – ${minuteLabel(window.endMinute)}`;
  const wrap = pushQuietHoursWraps(window) ? ", wrapping to the next day" : "";
  return `Notifications are held between ${span}${wrap} (${window.timezone}).`;
}

/**
 * Whether a window is one the server will accept.
 *
 * Mirrors applyQuietHoursInput's checks (quiet_hours.go:182-196) so the save button
 * is not offered for a body that can only come back 422: minutes in range, and a
 * non-empty timezone within the length limit and free of control characters.
 * IANA-name validity is NOT checked here — only the server can do that with
 * time.LoadLocation, and pretending otherwise would be a client-side lie.
 */
export function pushQuietHoursSavable(window: PushQuietHours): boolean {
  if (
    !Number.isInteger(window.startMinute) ||
    window.startMinute < 0 ||
    window.startMinute >= MINUTES_PER_DAY
  ) {
    return false;
  }
  if (
    !Number.isInteger(window.endMinute) ||
    window.endMinute < 0 ||
    window.endMinute >= MINUTES_PER_DAY
  ) {
    return false;
  }
  const zone = window.timezone.trim();
  if (zone === "") return false;
  // BYTE length, not `.length`: the Go check is `len(out.Timezone) > 64`
  // (quiet_hours.go:191), which counts bytes. Identical for the ASCII IANA names
  // this will ever hold, but comparing the same quantity removes a divergence
  // class rather than relying on the input staying ASCII.
  if (new TextEncoder().encode(zone).byteLength > 64) return false;
  // Mirrors Go hasControl (sender.go:531-538): `r < 0x20 || r == 0x7f`. The DEL at
  // the end is not decorative — omitting it lets a body through here that the
  // server answers 422 for, which is the "control that cannot succeed" this
  // function exists to prevent.
  return !/[\u0000-\u001f\u007f]/.test(zone);
}

/** The request body for a full save. */
export function pushQuietHoursBody(
  deviceKey: string,
  window: PushQuietHours,
): {
  device_key: string;
  enabled: boolean;
  start_minute: number;
  end_minute: number;
  timezone: string;
} {
  return {
    device_key: deviceKey,
    enabled: window.enabled,
    start_minute: window.startMinute,
    end_minute: window.endMinute,
    timezone: window.timezone.trim(),
  };
}

/**
 * The operator-facing sentence for a failed save or test.
 *
 * Each code is a distinct situation with a distinct remedy, and `device_not_registered`
 * is the one that matters most: it means the row this window would attach to is gone,
 * so the answer is to re-enable notifications rather than to retry.
 */
export function pushDeviceErrorMessage(
  code: string,
  fallback: string,
): string {
  switch (code) {
    case "device_not_registered":
      return "This device isn't registered for notifications. Turn notifications off and on again to re-register, then retry.";
    case "invalid_device_key":
      return "This installation's notification key is unusable. Turn notifications off and on again to mint a new one.";
    case "invalid_quiet_hours":
      return "That quiet-hours window was rejected. Check the times and the time zone.";
    case "mobile_push_disabled":
      return "Push delivery isn't configured for this deployment, so there is nothing to schedule yet.";
    case "test_push_throttled":
      return "A test notification already went to this device in the last minute. Wait a moment and try again.";
    case "test_push_rejected":
      return "The push service rejected this device. Turn notifications off and on again on this handset.";
    case "test_push_failed":
      return "The push service couldn't be reached. Try again shortly.";
    case "no_session":
      return "Sign in with a user session to manage notifications on this device.";
    default:
      return fallback;
  }
}
