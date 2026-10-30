/** Root contextual-help launcher driven by the semantic desktop shortcut. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDesktopShortcut } from "../../hooks/useDesktopShortcut";
import {
  requestOnboardingWizardRestart,
  useOnboardingState,
  useOnboardingUiBlockers,
} from "../../hooks/useOnboardingState";
import { buildContextualHelpSnapshot } from "../../lib/contextual-help";
import { useDesktopRoute } from "../../lib/desktop-router";
import {
  closeHelpLauncher,
  requestHelpLauncherToggle,
  useHelpLauncherState,
} from "../../lib/help-launcher";
import { useConnectivity } from "../../lib/online-manager";
import { ContextualHelpPanel } from "./ContextualHelpPanel";
import { useTour } from "./TourProvider";

export function TourLauncher(): ReactElement | null {
  const dialogId = useId();
  const tour = useTour();
  const onboarding = useOnboardingState();
  const blockers = useOnboardingUiBlockers(dialogId);
  const launcher = useHelpLauncherState();
  const route = useDesktopRoute();
  const connectivity = useConnectivity();
  const [side, setSide] = useState<"left" | "right">("right");
  const commandShortcut = useDesktopShortcut("app.command-palette");
  const helpShortcut = useDesktopShortcut("app.help");
  const onboardingShortcut = useDesktopShortcut("app.onboarding");
  const dashboardShortcut = useDesktopShortcut("nav.dashboard");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((restoreFocus: boolean): void => {
    closeHelpLauncher();
    if (restoreFocus) queueMicrotask(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if ((blockers.blocked || tour.isOpen) && launcher.open) close(false);
  }, [blockers.blocked, close, launcher.open, tour.isOpen]);

  useEffect(() => {
    if (!launcher.open) return;
    document.documentElement.dataset.contextualHelpSide = side;
    return () => {
      delete document.documentElement.dataset.contextualHelpSide;
    };
  }, [launcher.open, side]);

  if (tour.isOpen || blockers.blocked) return null;

  const snapshot = buildContextualHelpSnapshot({
    section: launcher.destination ?? route.section,
    connectivity: connectivity.reason,
    request: launcher.request,
  });

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="tour-launcher"
        aria-label={`${launcher.open ? "Close" : "Open"} help for this screen${helpShortcut ? ` (${helpShortcut.label})` : ""}`}
        aria-keyshortcuts={helpShortcut?.ariaKeyShortcuts}
        aria-expanded={launcher.open}
        aria-controls={launcher.open ? "desktop-contextual-help" : undefined}
        aria-haspopup="dialog"
        onClick={requestHelpLauncherToggle}
      >
        <span aria-hidden="true">?</span>
      </button>

      {launcher.open ? (
        <ContextualHelpPanel
          dialogId={dialogId}
          panelRef={panelRef}
          triggerRef={buttonRef}
          snapshot={snapshot}
          side={side}
          commandShortcut={commandShortcut}
          helpShortcut={helpShortcut}
          onboardingShortcut={onboardingShortcut}
          dashboardShortcut={dashboardShortcut}
          canRestartSetup={onboarding.stepsFor("wizard").length > 0}
          onClose={close}
          onMove={() =>
            setSide((value) => (value === "right" ? "left" : "right"))
          }
          onStartTour={() => {
            close(false);
            tour.start();
          }}
          onReplayTour={() => {
            close(false);
            tour.replay();
          }}
          onRestartSetup={() => {
            close(false);
            requestOnboardingWizardRestart();
          }}
        />
      ) : null}
    </>
  );
}
