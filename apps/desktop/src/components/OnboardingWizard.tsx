import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useDesktopShortcut } from "../hooks/useDesktopShortcut";
import { useOnboardingDialogBehavior } from "../hooks/useOnboardingDialogBehavior";
import { useOnboardingProgress } from "../hooks/useOnboardingProgress";
import {
  acknowledgeOnboardingWizardRestart,
  useOnboardingState,
  useOnboardingUiBlockers,
  useOnboardingWizardRestartRequest,
} from "../hooks/useOnboardingState";
import { navigateDesktopRoute } from "../lib/desktop-router";
import {
  CATALOG_STEPS,
  WIZARD_STEPS,
  type CatalogStepId,
  type WizardStepId,
} from "../lib/onboarding-manifest";
import { shouldAutoOpenOnboardingSurface } from "../lib/onboarding-state-machine";
import { ConfirmModal } from "./ConfirmModal";
import { StepCampaign } from "./onboarding/StepCampaign";
import { StepDomain } from "./onboarding/StepDomain";
import { StepDone } from "./onboarding/StepDone";
import { StepSubscribers } from "./onboarding/StepSubscribers";
import "../styles-onboarding.css";

const WIZARD_DIALOG_ID = "onboarding:wizard";
const CATALOG_DIALOG_ID = "onboarding:catalog";

interface FirstRunResult {
  shouldShow: boolean;
  loading: boolean;
  suspended: boolean;
}

function workspaceNeedsWizard(
  completedStepIds: readonly string[],
  available: boolean,
): boolean | null {
  if (!available) return null;
  return ["verify-domain", "import-subscribers", "send-first-campaign"].some(
    (stepId) => !completedStepIds.includes(stepId),
  );
}

export function useFirstRunCheck(): FirstRunResult {
  const onboarding = useOnboardingState();
  const progress = useOnboardingProgress();
  const blockers = useOnboardingUiBlockers(WIZARD_DIALOG_ID);
  const restartRequest = useOnboardingWizardRestartRequest();
  const workspaceNeedsSetup = workspaceNeedsWizard(
    onboarding.state.goals.completedStepIds,
    progress.available,
  );
  const record = onboarding.state.surfaces.wizard;

  useEffect(() => {
    if (!restartRequest || !onboarding.ready) return;
    const firstStep = onboarding.stepsFor("wizard")[0]?.id;
    if (!firstStep) {
      acknowledgeOnboardingWizardRestart(restartRequest);
      return;
    }
    if (blockers.blocked && record.outcome !== "in-progress") return;
    onboarding.resetSurface("wizard");
    onboarding.openSurface("wizard", "manual", firstStep);
    acknowledgeOnboardingWizardRestart(restartRequest);
  }, [blockers.blocked, onboarding, record.outcome, restartRequest]);

  useEffect(() => {
    if (
      !onboarding.ready ||
      progress.loading ||
      (!progress.liveConfirmed && record.outcome === "not-started")
    ) {
      return;
    }
    const eligible = shouldAutoOpenOnboardingSurface(
      onboarding.state,
      "wizard",
      {
        role: onboarding.role,
        blocked: blockers.blocked,
        workspaceNeedsSetup,
      },
    );
    if (eligible && record.outcome === "not-started") {
      onboarding.openSurface(
        "wizard",
        "auto",
        onboarding.stepsFor("wizard")[0]?.id,
      );
    }
  }, [
    blockers.blocked,
    onboarding,
    progress.liveConfirmed,
    progress.loading,
    record.outcome,
    workspaceNeedsSetup,
  ]);

  return {
    shouldShow: record.outcome === "in-progress",
    loading: !onboarding.ready || progress.loading,
    suspended: record.outcome === "in-progress" && blockers.blocked,
  };
}

function icon(path: ReactElement): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const STEP_ICONS: Readonly<Record<WizardStepId, ReactElement>> = {
  domain: icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.7 2.6 15.3 0 18c-2.6-2.7-2.6-15.3 0-18Z" />
    </>,
  ),
  subscribers: icon(
    <>
      <circle cx="9" cy="8" r="3.1" />
      <path d="M3.6 19a5.4 5.4 0 0 1 10.8 0" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8" />
      <path d="M17.6 13.4a5.4 5.4 0 0 1 2.8 4.8" />
    </>,
  ),
  campaign: icon(
    <>
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 14.8 21.5l-3.8-8.5-8.5-3.8 19-6.7Z" />
    </>,
  ),
  done: icon(
    <path d="M12 2.5 13.9 9 20.5 12 13.9 15 12 21.5 10.1 15 3.5 12 10.1 9 12 2.5Z" />,
  ),
};

const CHECK_ICON = icon(<path d="m4.5 12.5 4.5 4.5 10-11" />);

function WizardStepBody(props: {
  stepId: WizardStepId;
  onAdvance: () => void;
  onSkip: () => void;
  onDismiss: () => void;
  onJumpToDone: () => void;
  onComplete: () => void;
}): ReactElement {
  switch (props.stepId) {
    case "domain":
      return (
        <StepDomain
          onSkip={props.onSkip}
          onVerified={props.onAdvance}
          onDismiss={props.onDismiss}
        />
      );
    case "subscribers":
      return (
        <StepSubscribers
          onAdvance={props.onAdvance}
          onSkip={props.onSkip}
          onDismiss={props.onDismiss}
        />
      );
    case "campaign":
      return (
        <StepCampaign
          onAlreadyHasCampaigns={props.onJumpToDone}
          onSkip={props.onSkip}
          onDismiss={props.onDismiss}
        />
      );
    case "done":
      return <StepDone onClose={props.onComplete} />;
  }
}

function WizardRail(props: {
  currentStepId: WizardStepId;
  completedStepIds: readonly string[];
  skippedStepIds: readonly string[];
  onSelect: (stepId: WizardStepId) => void;
}): ReactElement {
  const currentIndex = WIZARD_STEPS.findIndex(
    (step) => step.id === props.currentStepId,
  );
  const pct = Math.round(
    (Math.max(0, currentIndex) / Math.max(1, WIZARD_STEPS.length - 1)) * 100,
  );
  const shortcut = useDesktopShortcut("app.onboarding");
  return (
    <aside className="onb2-aside">
      <div className="onb2-aside-glow" aria-hidden="true" />
      <div className="onb2-brand">
        <span className="onb2-brand-mark" aria-hidden="true">
          P
        </span>
        <span className="onb2-brand-word">Moosewave</span>
      </div>
      <div className="onb2-welcome">
        <h2 id="onboarding-title" className="onb2-welcome-title">
          Welcome to Moosewave
        </h2>
        <p id="onboarding-description" className="onb2-welcome-sub">
          Move from a new workspace to a ready first campaign in four guided
          steps. Progress resumes for this workspace and account.
        </p>
      </div>
      <ol className="onb2-steps" aria-label="Setup steps">
        {WIZARD_STEPS.map((step, index) => {
          const resolved =
            props.completedStepIds.includes(step.id) ||
            props.skippedStepIds.includes(step.id);
          const active = step.id === props.currentStepId;
          const reachable = active || resolved || index < currentIndex;
          const stateClass = resolved
            ? "is-done"
            : active
              ? "is-active"
              : "is-upcoming";
          return (
            <li
              key={step.id}
              className={"onb2-step-item " + stateClass}
            >
              <button
                type="button"
                className="onb2-step-row"
                disabled={!reachable}
                aria-current={active ? "step" : undefined}
                onClick={() => props.onSelect(step.id)}
              >
                <span className="onb2-step-bullet" aria-hidden="true">
                  {resolved ? CHECK_ICON : STEP_ICONS[step.id]}
                </span>
                <span className="onb2-step-copy">
                  <span className="onb2-step-name">{step.label}</span>
                  <span className="onb2-step-hint">{step.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="onb2-aside-foot">
        <div
          className="onb2-meter"
          role="progressbar"
          aria-label="Onboarding progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span
            className="onb2-meter-fill"
            style={{ width: String(pct) + "%" }}
          />
        </div>
        <p className="onb2-aside-note">
          Resume or reset later with{" "}
          <span className="mono">{shortcut?.label ?? "Restart setup"}</span>.
        </p>
      </div>
    </aside>
  );
}

export function OnboardingWizard(): ReactElement | null {
  const firstRun = useFirstRunCheck();
  const onboarding = useOnboardingState();
  const [skipPending, setSkipPending] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const record = onboarding.state.surfaces.wizard;
  const stepId = (record.currentStepId ?? WIZARD_STEPS[0]!.id) as WizardStepId;
  const stepIndex = WIZARD_STEPS.findIndex((step) => step.id === stepId);
  const nextStepId = WIZARD_STEPS[stepIndex + 1]?.id;
  const requestSkip = useCallback(() => setSkipPending(true), []);

  useEffect(() => {
    if (!firstRun.shouldShow) setSkipPending(false);
  }, [firstRun.shouldShow]);

  useOnboardingDialogBehavior({
    open: firstRun.shouldShow,
    suspended: firstRun.suspended,
    ownerId: WIZARD_DIALOG_ID,
    dialogRef: cardRef,
    initialFocusRef: cardRef,
    focusSignal: stepId,
    onEscape: requestSkip,
  });

  const advance = useCallback(() => {
    if (nextStepId) onboarding.completeStep("wizard", stepId, nextStepId);
  }, [nextStepId, onboarding, stepId]);
  const skipStep = useCallback(() => {
    if (nextStepId) onboarding.skipStep("wizard", stepId, nextStepId);
  }, [nextStepId, onboarding, stepId]);
  const jumpToDone = useCallback(() => {
    onboarding.completeStep("wizard", stepId, "done");
  }, [onboarding, stepId]);
  const dismiss = useCallback(() => {
    onboarding.dismissSurface("wizard", stepId, stepIndex);
  }, [onboarding, stepId, stepIndex]);
  const complete = useCallback(() => {
    onboarding.completeSurface("wizard");
  }, [onboarding]);

  if (firstRun.loading || !firstRun.shouldShow) return null;
  return (
    <>
      <div
        className="onboarding-backdrop"
        role="presentation"
        hidden={firstRun.suspended}
        aria-hidden={firstRun.suspended ? "true" : undefined}
      >
        <div
          ref={cardRef}
          className="onboarding-card onb2-card onb2-split"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
          aria-describedby="onboarding-description"
          tabIndex={-1}
        >
          <WizardRail
            currentStepId={stepId}
            completedStepIds={record.completedStepIds}
            skippedStepIds={record.skippedStepIds}
            onSelect={(selected) =>
              onboarding.setStep(
                "wizard",
                selected,
                WIZARD_STEPS.findIndex((step) => step.id === selected),
              )
            }
          />
          <section className="onb2-main">
            <button
              type="button"
              className="btn btn-ghost btn-sm onb2-skip"
              onClick={requestSkip}
              aria-label="Skip onboarding"
            >
              Skip
            </button>
            <span className="sr-only" role="status" aria-live="polite">
              Step {stepIndex + 1} of {WIZARD_STEPS.length}:{" "}
              {WIZARD_STEPS[stepIndex]?.label}
            </span>
            <div className="onboarding-body">
              <WizardStepBody
                stepId={stepId}
                onAdvance={advance}
                onSkip={skipStep}
                onDismiss={dismiss}
                onJumpToDone={jumpToDone}
                onComplete={complete}
              />
            </div>
          </section>
        </div>
      </div>
      <ConfirmModal
        open={skipPending}
        title="Skip setup for now?"
        description="Your current step is saved. Setup stays skipped until you resume or reset it from Help."
        confirmLabel="Skip setup"
        onConfirm={() => {
          onboarding.skipSurface("wizard", stepId, stepIndex);
          setSkipPending(false);
        }}
        onClose={() => setSkipPending(false)}
      />
    </>
  );
}

interface TourProps {
  onClose: () => void;
}

function CatalogShortcut(props: {
  shortcutIds: readonly string[];
}): ReactElement {
  const shortcuts = {
    "nav.lists": useDesktopShortcut("nav.lists")?.label,
    "nav.campaigns": useDesktopShortcut("nav.campaigns")?.label,
    "nav.domains": useDesktopShortcut("nav.domains")?.label,
    "nav.ai": useDesktopShortcut("nav.ai")?.label,
    "nav.approvals": useDesktopShortcut("nav.approvals")?.label,
    "nav.audit": useDesktopShortcut("nav.audit")?.label,
  } as const;
  return (
    <span className="badge mono" style={{ marginLeft: 8 }}>
      {props.shortcutIds
        .map((id) => shortcuts[id as keyof typeof shortcuts] ?? "Open")
        .join(" / ")}
    </span>
  );
}

export function OnboardingTour({ onClose }: TourProps): ReactElement | null {
  const onboarding = useOnboardingState();
  const blockers = useOnboardingUiBlockers(CATALOG_DIALOG_ID);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const record = onboarding.state.surfaces.catalog;
  const open = record.outcome === "in-progress";

  useEffect(() => {
    if (!onboarding.ready || blockers.blocked || open) return;
    onboarding.openSurface("catalog", "manual", CATALOG_STEPS[0]?.id);
  }, [blockers.blocked, onboarding, open]);

  const dismiss = useCallback(() => {
    onboarding.dismissSurface("catalog", record.currentStepId ?? undefined);
    onClose();
  }, [onClose, onboarding, record.currentStepId]);
  const complete = useCallback(() => {
    onboarding.completeSurface("catalog");
    onClose();
  }, [onClose, onboarding]);

  useOnboardingDialogBehavior({
    open,
    suspended: open && blockers.blocked,
    ownerId: CATALOG_DIALOG_ID,
    dialogRef: cardRef,
    initialFocusRef: cardRef,
    onEscape: dismiss,
  });

  const jump = (stepId: CatalogStepId): void => {
    const step = CATALOG_STEPS.find((candidate) => candidate.id === stepId);
    if (!step?.route) return;
    onboarding.completeStep("catalog", stepId);
    onboarding.completeSurface("catalog");
    navigateDesktopRoute(step.route);
    onClose();
  };

  if (!open) return null;
  return (
    <div
      className="onboarding-backdrop"
      role="presentation"
      hidden={blockers.blocked}
      aria-hidden={blockers.blocked ? "true" : undefined}
    >
      <div
        ref={cardRef}
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        aria-describedby="onboarding-tour-description"
        tabIndex={-1}
      >
        <header className="onboarding-header">
          <div>
            <h2 id="onboarding-tour-title" className="onboarding-title">
              A quick tour
            </h2>
            <p
              id="onboarding-tour-description"
              className="onboarding-subtitle"
            >
              Five routed surfaces worth knowing. Choose one to continue.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm onboarding-skip"
            onClick={dismiss}
            aria-label="Close quick tour"
          >
            Close
          </button>
        </header>
        <div className="onboarding-body">
          <div className="onboarding-goal-grid">
            {CATALOG_STEPS.map((step) => (
              <button
                key={step.id}
                type="button"
                className="onboarding-goal-card"
                onClick={() => jump(step.id)}
                aria-label={step.title + " — open this section"}
              >
                <span className="onboarding-goal-check" aria-hidden="true">
                  {step.icon}
                </span>
                <span className="onboarding-goal-text">
                  <span className="onboarding-goal-title">
                    {step.title}
                    <CatalogShortcut shortcutIds={step.shortcutIds} />
                  </span>
                  <span className="onboarding-goal-desc">{step.body}</span>
                  <span className="onboarding-goal-desc">Show me →</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <footer className="onboarding-footer">
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={complete}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
