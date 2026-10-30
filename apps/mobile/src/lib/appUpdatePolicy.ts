/**
 * lib/appUpdatePolicy.ts — when to look for a JS update, and what to say.
 *
 * Two separate things were missing (NATIVE#3, SHELL#29) and only one of them
 * has been closed until now:
 *
 *   1. A build BELOW the server's version floor gets HTTP 426 and is shown
 *      `components/UpgradeRequiredScreen`, which sends the user to the store.
 *      That path exists and is wired from both SDK transports.
 *   2. There was no path for the far more common case — a build that still
 *      works but is missing a fix. expo-updates is now a dependency and
 *      `app.config.js` derives an `updates.url` from the EAS project id, but
 *      a channel with nothing checking it never delivers anything: the client
 *      only downloads on `checkForUpdateAsync` (the automatic launch check is
 *      best-effort and invisible), and it only APPLIES on a full reload, which
 *      users do not perform on purpose.
 *
 * This module owns the decisions so they can be tested without the native
 * module: `lib/appUpdates.ts` is the thin expo-updates wrapper,
 * `hooks/useAppUpdate.ts` drives the state machine, and the diagnostics screen
 * renders it.
 *
 * The load-bearing rule is THROTTLING. `checkForUpdateAsync` is a network
 * round trip to the update server; running it on every foreground would spend
 * a user's cellular data on a poll that almost always answers "no". Once every
 * six hours, only while online, only when a check is not already in flight.
 */
import { relativeTime } from "./format";

export type AppUpdatePhase =
  /** expo-updates is compiled out (Expo Go / dev client / no channel). */
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "downloading"
  /** Downloaded and staged; it applies on the next reload. */
  | "ready"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  /** Epoch ms of the last COMPLETED check, successful or not. */
  lastCheckedAt: number | null;
  /** Human-readable failure detail, only meaningful when phase is "error". */
  error: string | null;
}

export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const INITIAL_APP_UPDATE_STATE: AppUpdateState = {
  phase: "idle",
  lastCheckedAt: null,
  error: null,
};

export interface AppUpdateCheckContext {
  /** `Updates.isEnabled` — false in dev builds and any binary without OTA. */
  enabled: boolean;
  online: boolean;
  phase: AppUpdatePhase;
  lastCheckedAt: number | null;
  now: number;
  intervalMs?: number;
}

/**
 * Should an AUTOMATIC (foreground) check run right now?
 *
 * Never while a check or download is in flight, never once an update is
 * already staged (there is nothing more to learn — the user has to restart),
 * never offline, never in a build that cannot apply one.
 */
export function shouldAutoCheckForUpdate(ctx: AppUpdateCheckContext): boolean {
  if (!ctx.enabled || !ctx.online) return false;
  if (ctx.phase === "checking" || ctx.phase === "downloading") return false;
  if (ctx.phase === "ready" || ctx.phase === "unsupported") return false;
  if (ctx.lastCheckedAt === null) return true;
  const interval = ctx.intervalMs ?? APP_UPDATE_CHECK_INTERVAL_MS;
  // A clock that has moved BACKWARDS (timezone edit, NTP correction) must not
  // lock out checking until the phone catches up.
  if (ctx.now < ctx.lastCheckedAt) return true;
  return ctx.now - ctx.lastCheckedAt >= interval;
}

export type AppUpdateTone = "neutral" | "info" | "success" | "warning";

export interface AppUpdateDescription {
  headline: string;
  detail: string;
  tone: AppUpdateTone;
  /** Label for the primary control, or null when there is nothing to press. */
  action: "check" | "restart" | null;
  actionLabel: string | null;
}

/**
 * Phase → copy. Every state says what happened AND what the user can do,
 * because "Up to date" with a dead button is indistinguishable from a broken
 * screen.
 */
export function describeAppUpdate(
  state: AppUpdateState,
  now = Date.now(),
): AppUpdateDescription {
  const checked =
    state.lastCheckedAt === null
      ? "Not checked yet"
      : `Checked ${relativeTime(state.lastCheckedAt, { now })}`;

  switch (state.phase) {
    case "unsupported":
      return {
        headline: "Updates not available in this build",
        detail:
          "This build has no update channel, so it can only change by installing a new one from the store.",
        tone: "neutral",
        action: null,
        actionLabel: null,
      };
    case "checking":
      return {
        headline: "Checking for updates…",
        detail: checked,
        tone: "info",
        action: null,
        actionLabel: null,
      };
    case "downloading":
      return {
        headline: "Downloading update…",
        detail: "Moosewave will ask you to restart once it has finished.",
        tone: "info",
        action: null,
        actionLabel: null,
      };
    case "ready":
      return {
        headline: "Update ready",
        detail: "Restart Moosewave to finish installing it.",
        tone: "success",
        action: "restart",
        actionLabel: "Restart now",
      };
    case "up-to-date":
      return {
        headline: "Moosewave is up to date",
        detail: checked,
        tone: "neutral",
        action: "check",
        actionLabel: "Check again",
      };
    case "error":
      return {
        headline: "Couldn't check for updates",
        detail: state.error ?? "The update server could not be reached.",
        tone: "warning",
        action: "check",
        actionLabel: "Try again",
      };
    case "idle":
    default:
      return {
        headline: "Check for updates",
        detail: checked,
        tone: "neutral",
        action: "check",
        actionLabel: "Check now",
      };
  }
}

export interface AppUpdateOrigin {
  enabled: boolean;
  channel: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  /** Epoch ms the running update was published, or null for the embedded JS. */
  createdAt: number | null;
  isEmbedded: boolean;
  isEmergencyLaunch: boolean;
  emergencyLaunchReason: string | null;
}

/**
 * The running JS bundle's provenance, as diagnostics rows.
 *
 * ABSENCE IS NOT ZERO: a build with no channel says so in words rather than
 * rendering an empty value that reads as a bug.
 */
export function appUpdateOriginRows(
  origin: AppUpdateOrigin,
  now = Date.now(),
): { label: string; value: string }[] {
  if (!origin.enabled) {
    return [{ label: "Update channel", value: "none (store build only)" }];
  }
  const rows = [
    { label: "Update channel", value: origin.channel ?? "unset" },
    { label: "Runtime version", value: origin.runtimeVersion ?? "unset" },
    {
      label: "Running bundle",
      value: origin.isEmbedded
        ? "embedded (shipped with the app)"
        : (origin.updateId ?? "downloaded"),
    },
  ];
  if (origin.createdAt !== null) {
    rows.push({
      label: "Bundle published",
      value: relativeTime(origin.createdAt, { now }),
    });
  }
  if (origin.isEmergencyLaunch) {
    // The single most important thing a support agent can be told: this phone
    // fell back to the embedded bundle because the downloaded one crashed.
    rows.push({
      label: "Emergency launch",
      value: origin.emergencyLaunchReason ?? "recovered from a failed update",
    });
  }
  return rows;
}
