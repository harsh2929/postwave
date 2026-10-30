/**
 * DashboardOnboarding — the single mount point the dashboard renders for
 * all first-run onboarding surfaces. Owns the AsyncStorage gating so the
 * dashboard screen stays a one-liner.
 *
 * It decides:
 *  - whether to show the OnboardingChecklist (until the user dismisses it via
 *    the `postwave_onboarding_checklist_dismissed` flag). We intentionally do
 *    NOT gate on `all_done` here: the checklist owns its own all-done
 *    celebration branch (confetti + `checklist_completed` analytics + a Dismiss
 *    button). Gating on `all_done` here would unmount it on the very render it
 *    completes, so that celebration + event could never fire.
 *  - whether to show the first-run OnboardingWizard (workspace is empty,
 *    i.e. onboarding progress completed === 0, AND never dismissed via
 *    `postwave_onboarding_wizard_dismissed_at`).
 *
 * Both gates read the same shared progress query, so there's one request.
 *
 * The dismissal flags are re-read whenever this tab regains focus, not once per
 * mount. Expo Router keeps a visited tab MOUNTED, so a mount-only read meant
 * Settings' "Show setup checklist" control (which clears the flag and returns
 * here) did nothing visible until the app was restarted — the checklist stayed
 * hidden behind a flag the screen had already cached.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { isChecklistDismissed } from "@/lib/onboardingDecisions";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";

import { OnboardingChecklist } from "./OnboardingChecklist";
import {
  OnboardingWizard,
  WIZARD_DISMISSED_KEY,
} from "./OnboardingWizard";
import { useOnboardingProgressQuery } from "./useOnboardingProgress";

export function DashboardOnboarding() {
  const query = useOnboardingProgressQuery();
  const progress = query.data;
  const focused = useIsFocused();

  // Hydrate persisted dismissal flags once.
  const [checklistDismissed, setChecklistDismissed] = useState<boolean | null>(
    null,
  );
  const [wizardDismissed, setWizardDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The checklist decision is the person's, not this device's, so it
        // comes from the shared resolver (server first, local cache on
        // failure). The wizard flag is still per-device: it gates a first-run
        // tour of THIS app, which is a reasonable thing to show once per
        // install.
        const [dismissed, pairs] = await Promise.all([
          isChecklistDismissed(),
          AsyncStorage.multiGet([WIZARD_DISMISSED_KEY]),
        ]);
        if (cancelled) return;
        setChecklistDismissed(dismissed);
        setWizardDismissed(pairs[0]?.[1] != null);
      } catch {
        if (!cancelled) {
          setChecklistDismissed(false);
          setWizardDismissed(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-read on focus: the flag can be cleared from Settings while this tab
    // is mounted but not visible.
  }, [focused]);

  // First-run wizard: only when the workspace is genuinely empty AND the
  // user hasn't dismissed it. Gate on progress.completed === 0.
  const [wizardVisible, setWizardVisible] = useState(false);
  useEffect(() => {
    if (wizardDismissed == null || !progress) return;
    if (!wizardDismissed && progress.completed === 0) {
      setWizardVisible(true);
    }
  }, [wizardDismissed, progress]);

  // Note: no `!progress.all_done` here — the checklist renders its own all-done
  // celebration and persists dismissal via onDismissed, so it won't linger.
  const showChecklist = checklistDismissed === false && progress != null;

  return (
    <>
      {showChecklist ? (
        <OnboardingChecklist
          onDismissed={() => setChecklistDismissed(true)}
        />
      ) : null}
      <OnboardingWizard
        visible={wizardVisible}
        onClose={() => {
          setWizardVisible(false);
          setWizardDismissed(true);
        }}
      />
    </>
  );
}
