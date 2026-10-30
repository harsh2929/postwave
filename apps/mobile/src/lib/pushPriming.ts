/**
 * pushPriming — what to say BEFORE spending iOS's one-shot permission dialog.
 *
 * iOS shows the notification prompt exactly once per install. Moosewave's only
 * priming was the switch's own one-line hint ("Registers or unregisters this
 * device for push notification delivery"), which describes the mechanism and
 * not the value — so the prompt arrived cold, and a "Don't Allow" tapped
 * there is permanent as far as the app is concerned: `requestPermissionsAsync`
 * resolves denied forever after, with no second chance to explain.
 *
 * Two prompts, because the two situations are genuinely different:
 *
 *   undetermined — the OS dialog is still available. Explain the value in our
 *                  own UI first; if the user declines HERE, nothing is spent
 *                  and they can turn the switch on again later.
 *   denied       — the OS dialog is gone. Do NOT pretend otherwise by calling
 *                  requestPermissionsAsync and silently failing; send them to
 *                  system settings, which is the only place that can undo it.
 *
 * Pure, and free of react-native/expo — its only import is `lib/direction`,
 * which is itself import-free — so both branches are testable under node.
 */

import { pathLabel } from "./direction";

export type PushPermissionState = "granted" | "undetermined" | "denied";

export interface PushPrimingPrompt {
  title: string;
  message: string;
  consequence?: string;
  confirmLabel: string;
  cancelLabel: string;
  /**
   * `os_prompt` — the next step shows the system dialog.
   * `open_settings` — the system dialog is spent; only Settings can change it.
   */
  outcome: "os_prompt" | "open_settings";
}

/**
 * Normalise the value expo-notifications reports. Anything unrecognised is
 * treated as `undetermined`, which fails SAFE: the worst case is that the app
 * explains itself once more than strictly necessary.
 */
export function normalizePushPermissionState(
  status: string | undefined,
  granted: boolean,
): PushPermissionState {
  if (granted) return "granted";
  const value = (status ?? "").trim().toLowerCase();
  if (value === "denied") return "denied";
  if (value === "granted") return "granted";
  return "undetermined";
}

/**
 * The rationale to show before the OS prompt, or null when there is nothing
 * useful to say (permission is already granted — go straight to registering).
 */
export function pushPrimingPrompt(
  state: PushPermissionState,
): PushPrimingPrompt | null {
  if (state === "granted") return null;
  if (state === "denied") {
    return {
      title: "Notifications are turned off for Moosewave",
      message:
        "iOS only asks once, and notifications were declined for this app. Moosewave can't ask again from here.",
      consequence: `Turn them back on in ${pathLabel([
        "Settings",
        "Notifications",
        "Moosewave",
      ])}, then come back and flip this switch.`,
      confirmLabel: "Open Settings",
      cancelLabel: "Not now",
      outcome: "open_settings",
    };
  }
  return {
    title: "Get told when it actually matters",
    message:
      "Moosewave notifies you about approval requests waiting on you, sends that finish or fail, and deliverability problems while a campaign is going out.",
    consequence:
      "You choose the topics on the next screen, and iOS will ask for permission once — declining here costs nothing.",
    confirmLabel: "Continue",
    cancelLabel: "Not now",
    outcome: "os_prompt",
  };
}
