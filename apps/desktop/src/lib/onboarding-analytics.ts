import type { OnboardingAnalyticsIntent } from "./onboarding-state-machine";
import { track } from "./telemetry";

export const ONBOARDING_PLATFORM = "desktop" as const;

/**
 * Single onboarding analytics boundary. Only a committed local state-machine
 * transition yields an intent; hydration, migration, reset, and storage sync
 * are deliberately silent. Intent props contain structural IDs/counts only.
 */
export function emitOnboardingAnalyticsIntent(
  intent: OnboardingAnalyticsIntent,
): void {
  track(intent.name, { ...intent.props, platform: ONBOARDING_PLATFORM });
}
