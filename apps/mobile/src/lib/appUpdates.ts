/**
 * lib/appUpdates.ts — the thin expo-updates boundary.
 *
 * Everything here is a native call or a native constant. The decisions
 * (throttling, copy, diagnostics rows) live in `lib/appUpdatePolicy.ts` so
 * they are tested in the node environment; this file exists so exactly one
 * module imports `expo-updates`.
 *
 * Guarding on `Updates.isEnabled` is not optional politeness: in a dev client
 * or any binary built without an update channel, `checkForUpdateAsync()`
 * REJECTS. Calling it unguarded would show every developer — and every user
 * of a store build published before the channel existed — a permanent
 * "Couldn't check for updates" error for a condition that is not an error.
 */
import * as Updates from "expo-updates";

import type { AppUpdateOrigin } from "./appUpdatePolicy";

/** True when this binary can actually download and apply a JS update. */
export function appUpdatesEnabled(): boolean {
  try {
    return Updates.isEnabled === true;
  } catch {
    return false;
  }
}

function toEpochMs(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Provenance of the JS bundle this process is running. */
export function appUpdateOrigin(): AppUpdateOrigin {
  const enabled = appUpdatesEnabled();
  if (!enabled) {
    return {
      enabled: false,
      channel: null,
      runtimeVersion: null,
      updateId: null,
      createdAt: null,
      isEmbedded: true,
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    };
  }
  try {
    return {
      enabled: true,
      channel: Updates.channel ?? null,
      runtimeVersion: Updates.runtimeVersion ?? null,
      updateId: Updates.updateId ?? null,
      createdAt: toEpochMs(Updates.createdAt),
      isEmbedded: Updates.isEmbeddedLaunch === true,
      isEmergencyLaunch: Updates.isEmergencyLaunch === true,
      emergencyLaunchReason: Updates.emergencyLaunchReason ?? null,
    };
  } catch {
    // A constant read should never throw, but a broken native module must not
    // take the diagnostics screen down with it.
    return {
      enabled: true,
      channel: null,
      runtimeVersion: null,
      updateId: null,
      createdAt: null,
      isEmbedded: false,
      isEmergencyLaunch: false,
      emergencyLaunchReason: null,
    };
  }
}

export type AppUpdateCheckOutcome =
  | { kind: "unsupported" }
  | { kind: "up-to-date" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The update server could not be reached.";
}

/**
 * Check, and download in the same breath.
 *
 * Deliberately NOT two user-facing steps. An "available" state the user has to
 * act on is a second decision about something they cannot evaluate — the only
 * sensible answer to "a fix is available" is "get it" — and splitting them
 * leaves a window where the app knows about a fix it has not fetched. The
 * download is silent; the RESTART is the only thing we ask for, because that
 * is the only part with a cost (losing what is on screen).
 */
export async function checkAndFetchAppUpdate(): Promise<AppUpdateCheckOutcome> {
  if (!appUpdatesEnabled()) return { kind: "unsupported" };
  let available = false;
  try {
    const result = await Updates.checkForUpdateAsync();
    available = result.isAvailable === true;
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
  if (!available) return { kind: "up-to-date" };
  try {
    const fetched = await Updates.fetchUpdateAsync();
    // `isNew: false` means the server answered with something we already have
    // staged — not a failure, and not something to ask the user to restart for
    // twice.
    return fetched.isNew === true ? { kind: "ready" } : { kind: "up-to-date" };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

/**
 * Apply a staged update by reloading the JS.
 *
 * Throws on failure so the caller can tell the user rather than leaving them
 * looking at a button that did nothing.
 */
export async function restartWithAppUpdate(): Promise<void> {
  if (!appUpdatesEnabled()) {
    throw new Error("This build cannot apply updates.");
  }
  await Updates.reloadAsync();
}
