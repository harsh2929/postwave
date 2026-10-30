/**
 * OnboardingChecklist — the home-page setup guide.
 *
 * Promotes the previously modal-only OnboardingWizard onto the
 * Dashboard canvas. Stays visible until every step is complete or
 * skipped (or the user dismisses the whole checklist). The active
 * step is auto-expanded; completed steps collapse and show their
 * unlock badge.
 *
 * Visual hierarchy (this round): the schema's tier metadata
 * (`goalForKey(key)?.tier`) splits the list into the path-to-first-send
 * SPINE (heroed) and the hardening work (recessed). The renderer groups
 * them under labelled headers so the must-do-to-send sequence reads as
 * primary and the durability work as secondary — without changing the
 * server-backed progress source or the animated ring.
 *
 * Analytics: emits the shared `EVENTS.ONBOARDING_*` checklist events
 * (viewed / goal_completed / completed) plus a milestone celebration
 * (with the existing confetti motif) the moment every goal is complete.
 *
 * Data comes from useOnboardingProgress() — see that hook for
 * derivation rules. This component is otherwise presentational.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import {
  useOnboardingProgress,
  type OnboardingStep,
} from "../hooks/useOnboardingProgress";
import { useOnboardingState } from "../hooks/useOnboardingState";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { CHECKLIST_STEPS } from "../lib/onboarding-manifest";
import { Icon } from "./Icon";
import { motion } from "./tour/motion-tokens";
import { SkipForNowLink } from "./SkipForNowLink";

const RING_SIZE = 56;
const RING_STROKE = 4;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRC = 2 * Math.PI * RING_R;

/**
 * Map the client checklist step ids onto canonical schema goal keys so we can
 * read each step's TIER (path-to-send vs hardening) from the shared schema.
 * The strongest single signal per client step (mirrors useOnboardingProgress).
 */
/** Tier of a client step, resolved via the schema (defaults to path-to-send). */
function tierForStep(step: OnboardingStep): "path-to-send" | "hardening" {
  return (
    CHECKLIST_STEPS.find((manifestStep) => manifestStep.id === step.id)?.tier ??
    "path-to-send"
  );
}

interface Props {
  title?: string;
  subtitle?: string;
  variant?: "compact" | "full";
}

export function OnboardingChecklist({
  title = "Your guide to getting started",
  subtitle,
  variant = "full",
}: Props): ReactElement | null {
  const checklistId = useId();
  const expandedPanelId = `${checklistId}-steps`;
  const progress = useOnboardingProgress();
  const onboarding = useOnboardingState();
  const reducedMotion = usePrefersReducedMotion();
  const activeStepId = progress.steps.find(
    (step) => step.status === "active",
  )?.id;
  const initialActive = progress.steps.find((s) => s.status === "active");
  const [expanded, setExpanded] = useState<OnboardingStep["id"] | null>(
    initialActive?.id ?? null,
  );
  const expandedTouchedRef = useRef(false);
  const [compactExpanded, setCompactExpanded] = useState(false);

  /* Celebration latch — true for one render-window after every goal flips to
   * complete, so the confetti burst fires once (not on every re-render). */
  const [celebrating, setCelebrating] = useState(false);
  const autoOpenedStepRef = useRef<string | null>(null);

  /* Strict "all complete" (not counting skips) — the milestone we celebrate
   * mirrors the server's `all_done`. */
  const allComplete = useMemo(
    () =>
      progress.steps.length > 0 &&
      progress.steps.every((s) => s.status === "complete"),
    [progress.steps],
  );

  /* A visible checklist enters the shared state machine once per active step.
   * Hook results intentionally change as the external state advances, so the
   * scalar key and pre-dispatch latch prevent a render -> dispatch loop while
   * still allowing the next server-confirmed step (or a restored checklist) to
   * enter the state machine. The transition owns analytics. */
  useEffect(() => {
    if (
      progress.loading ||
      !progress.available ||
      !progress.applicable ||
      progress.dismissed ||
      progress.done
    ) {
      if (progress.dismissed || progress.done || !progress.applicable) {
        autoOpenedStepRef.current = null;
      }
      return;
    }
    const autoOpenKey = `${onboarding.state.scopeToken}:${activeStepId ?? "none"}`;
    if (autoOpenedStepRef.current === autoOpenKey) return;
    autoOpenedStepRef.current = autoOpenKey;
    onboarding.openSurface("checklist", "auto", activeStepId);
  }, [
    activeStepId,
    onboarding.openSurface,
    onboarding.state.scopeToken,
    progress.applicable,
    progress.available,
    progress.dismissed,
    progress.done,
    progress.loading,
  ]);

  /* Presentation-only transition detector. Analytics comes from sync-goals. */
  const prevCompleteRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (progress.loading) return;
    const nowComplete = new Set(
      progress.steps.filter((s) => s.status === "complete").map((s) => s.id),
    );
    const prev = prevCompleteRef.current;
    // Was the PREVIOUS settled render already all-complete? Used to gate the
    // celebration on an observed transition (see below).
    const prevAllComplete =
      prev !== null &&
      progress.steps.length > 0 &&
      progress.steps.every((s) => prev.has(s.id));
    prevCompleteRef.current = nowComplete;

    // D15-shell-onboarding#3 — only emit the completed/milestone analytics
    // and flash confetti on an OBSERVED transition into all-complete
    // (prev !== null && the prior render was NOT all-complete). Without the
    // prev gate, every mount of an already-finished tenant re-emitted both
    // events and flashed the finished checklist for ~flightMs before the
    // null-return kicked in.
    if (prev !== null && !prevAllComplete && allComplete) {
      setCelebrating(!reducedMotion);
    }
  }, [progress.steps, progress.loading, allComplete, reducedMotion]);

  /* Follow server-confirmed progress only when the currently expanded step is
   * resolved or disappears. A deliberate user collapse remains collapsed. */
  useEffect(() => {
    setExpanded((current) => {
      if (current === null) {
        if (expandedTouchedRef.current) return null;
        return (
          progress.steps.find((step) => step.status === "active")?.id ?? null
        );
      }
      const currentStep = progress.steps.find((step) => step.id === current);
      if (
        currentStep &&
        currentStep.status !== "complete" &&
        currentStep.status !== "skipped"
      ) {
        return current;
      }
      return (
        progress.steps.find((step) => step.status === "active")?.id ?? null
      );
    });
  }, [progress.steps]);

  /* Auto-clear the confetti burst once it has played through. */
  useEffect(() => {
    if (!celebrating) return;
    const t = window.setTimeout(
      () => setCelebrating(false),
      motion.confetti.flightMs + 400,
    );
    return () => window.clearTimeout(t);
  }, [celebrating]);

  // D15-shell-onboarding#9: when the user dismisses the whole checklist we
  // don't vanish silently — a slim restore bar keeps the dismiss reversible
  // without a Settings trip (wires progress.restore(), previously call-less).
  if (!progress.applicable) return null;

  if (progress.dismissed) {
    return (
      <section className="checklist-restore" aria-label="Setup guide (hidden)">
        <span>Setup guide hidden</span>
        <button type="button" className="btn btn-sm" onClick={progress.restore}>
          Restore
        </button>
      </section>
    );
  }

  if (progress.failed && !progress.available) {
    const errorTitleId = `${checklistId}-load-error-title`;
    return (
      <section
        className={`checklist checklist-load-error${
          variant === "compact" ? " checklist-compact" : ""
        }`}
        role="alert"
        aria-labelledby={errorTitleId}
      >
        <span className="checklist-state-icon" aria-hidden="true">
          <Icon name="alert-triangle" size={20} />
        </span>
        <div className="checklist-state-content">
          <div className="checklist-eyebrow">Setup guide</div>
          <h2 id={errorTitleId} className="checklist-title">
            Setup progress is unavailable
          </h2>
          <p className="checklist-state-copy">
            We couldn&apos;t load your latest setup progress. Check your
            connection and try again.
          </p>
          <button
            type="button"
            className="btn btn-primary checklist-state-action"
            onClick={progress.retry}
          >
            Retry setup progress
          </button>
        </div>
      </section>
    );
  }

  // Stay mounted while `celebrating` so the all-done confetti burst can render
  // (allComplete implies progress.done, which would otherwise return null here
  // before the celebration ever paints). The auto-clear effect unmounts us
  // ~flightMs later by flipping `celebrating` back to false.
  if (progress.done && !celebrating) return null;

  const subText =
    subtitle ??
    `Complete all ${progress.ratio.total} steps to get the most out of Moosewave`;

  /* Group steps by tier while preserving order. Path-to-send is the heroed
   * spine; hardening is the recessed durability work. */
  const spine = progress.steps.filter((s) => tierForStep(s) === "path-to-send");
  const hardening = progress.steps.filter(
    (s) => tierForStep(s) === "hardening",
  );
  const nextStep =
    progress.steps.find((step) => step.status === "active") ??
    progress.steps.find((step) => step.status !== "complete") ??
    progress.steps[0];

  const progressNotice = progress.stale ? (
    <div className="checklist-data-notice is-warning">
      <Icon name="alert-triangle" size={15} />
      <span role="status">
        Couldn&apos;t refresh setup progress. Showing the last confirmed status.
      </span>
      <button type="button" className="btn btn-sm" onClick={progress.retry}>
        Retry
      </button>
    </div>
  ) : progress.refreshing ? (
    <div className="checklist-data-notice" role="status">
      <span className="checklist-data-notice-dot" aria-hidden="true" />
      Refreshing setup progress&hellip;
    </div>
  ) : null;

  const progressRing = (
    <div
      className="checklist-ring"
      role="progressbar"
      aria-label="Workspace setup progress"
      aria-valuemin={0}
      aria-valuemax={Math.max(progress.ratio.total, 1)}
      aria-valuenow={progress.ratio.done}
      aria-valuetext={`${progress.ratio.done} of ${progress.ratio.total} steps resolved`}
    >
      <svg
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        aria-hidden="true"
        focusable="false"
      >
        <circle
          className="checklist-ring-track"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_R}
        />
        <circle
          className="checklist-ring-fill"
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_R}
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC * (1 - progress.completion)}
        />
      </svg>
      <div className="checklist-ring-text" aria-hidden="true">
        {progress.ratio.done}/{progress.ratio.total}
      </div>
    </div>
  );

  if (variant === "compact" && !compactExpanded) {
    return (
      <section
        className="checklist checklist-compact"
        aria-labelledby={checklistId}
      >
        {celebrating ? <ChecklistConfetti /> : null}
        <button
          type="button"
          className="checklist-dismiss"
          aria-label="Hide setup guide; it can be restored later"
          onClick={progress.dismiss}
        >
          <Icon name="x" size={14} />
        </button>
        {progressRing}
        <div className="checklist-compact-content">
          <div className="checklist-eyebrow">Setup guide</div>
          <h2 id={checklistId} className="checklist-title">
            {title}
          </h2>
          {progressNotice}
          {progress.loading ? (
            <div
              className="checklist-compact-loading"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">
                Loading workspace setup progress
              </span>
              <div className="skel checklist-compact-skeleton-title" />
              <div className="skel checklist-compact-skeleton-copy" />
              <div className="skel checklist-compact-skeleton-action" />
            </div>
          ) : nextStep ? (
            <div className="checklist-compact-next">
              <div className="checklist-compact-next-label">Next step</div>
              <div className="checklist-compact-next-title">
                {nextStep.title}
              </div>
              <p className="checklist-compact-next-description">
                {nextStep.description}
              </p>
              <div className="checklist-compact-actions">
                {nextStep.status !== "complete" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={nextStep.goTo}
                  >
                    {nextStep.goLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-expanded="false"
                  aria-controls={expandedPanelId}
                  onClick={() => setCompactExpanded(true)}
                >
                  View all steps
                  <Icon name="arrow-right" size={13} />
                </button>
              </div>
            </div>
          ) : (
            <p className="checklist-compact-next-description">{subText}</p>
          )}
        </div>
        <div id={expandedPanelId} hidden />
      </section>
    );
  }

  const renderStep = (step: OnboardingStep): ReactElement => {
    const isComplete = step.status === "complete";
    const isExpanded = expanded === step.id;
    const tier = tierForStep(step);
    const stepBodyId = `${checklistId}-${step.id}-body`;
    return (
      <div
        key={step.id}
        className={`checklist-step checklist-step-tier-${tier} ${
          isComplete ? "is-complete" : ""
        } ${isExpanded ? "is-active" : ""}`.trim()}
        data-tier={tier}
      >
        <div className="checklist-step-bullet">
          {isComplete ? (
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 5l2 2 4-4" />
            </svg>
          ) : (
            <span>{progress.steps.findIndex((s) => s.id === step.id) + 1}</span>
          )}
        </div>
        <div className="checklist-step-main">
          <button
            type="button"
            className="checklist-step-toggle"
            aria-expanded={!isComplete ? isExpanded : undefined}
            aria-controls={!isComplete ? stepBodyId : undefined}
            disabled={isComplete}
            onClick={() => {
              expandedTouchedRef.current = true;
              setExpanded(isExpanded ? null : step.id);
            }}
          >
            <span className="checklist-step-label">
              {step.title}
              {isComplete ? (
                <span className="checklist-step-unlocked">
                  {step.unlockedBadge}
                </span>
              ) : null}
            </span>
            {!isComplete ? (
              <Icon
                name="chevron-down"
                size={14}
                className="checklist-step-chevron"
              />
            ) : null}
          </button>
          {!isComplete ? (
            <div
              id={stepBodyId}
              className="checklist-step-body"
              hidden={!isExpanded}
            >
              <div className="checklist-step-body-text">
                <div className="checklist-step-body-desc">
                  {step.description}
                </div>
                <div className="checklist-step-body-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={step.goTo}
                  >
                    {step.goLabel}
                  </button>
                  <SkipForNowLink onClick={() => progress.skipStep(step.id)} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <section
      className={
        variant === "compact"
          ? "checklist checklist-full checklist-compact-expanded"
          : "checklist checklist-full"
      }
      aria-label="Setup checklist"
    >
      {celebrating ? <ChecklistConfetti /> : null}
      <span className="sr-only" role="status" aria-live="polite">
        Setup progress: {progress.ratio.done} of {progress.ratio.total} steps
        resolved.
      </span>
      {/* D15-shell-onboarding#9: the documented "dismiss the whole checklist"
          affordance — wires progress.dismiss() (previously call-less). */}
      <button
        type="button"
        className="checklist-dismiss"
        aria-label="Hide setup guide; it can be restored later"
        onClick={progress.dismiss}
      >
        <Icon name="x" size={14} />
      </button>
      {progressRing}
      <div className="checklist-content">
        <header className="checklist-header">
          <div className="checklist-header-row">
            <h2 className="checklist-title">{title}</h2>
            {variant === "compact" ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-expanded="true"
                aria-controls={expandedPanelId}
                onClick={() => setCompactExpanded(false)}
              >
                Show less
                <Icon name="chevron-up" size={13} />
              </button>
            ) : null}
          </div>
          <div className="checklist-subtitle">{subText}</div>
          {progressNotice}
        </header>

        <div
          id={variant === "compact" ? expandedPanelId : undefined}
          className="checklist-groups"
        >
          {/* Path-to-first-send spine — heroed. */}
          <div className="checklist-group checklist-group-primary">
            <div className="checklist-group-head">
              <span className="checklist-group-label">
                Path to your first send
              </span>
              <span className="checklist-group-hint">Do these in order</span>
            </div>
            <div className="checklist-steps">{spine.map(renderStep)}</div>
          </div>

          {/* Hardening — recessed durability work. */}
          {hardening.length > 0 ? (
            <div className="checklist-group checklist-group-secondary">
              <div className="checklist-group-head">
                <span className="checklist-group-label">Make it durable</span>
                <span className="checklist-group-hint">
                  When you&apos;re ready
                </span>
              </div>
              <div className="checklist-steps">{hardening.map(renderStep)}</div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/* ---------- celebration confetti ------------------------------------- */

/**
 * One-shot confetti burst reusing the tour's `.tour-confetti*` CSS motif and
 * the canonical motion tokens (count / spread / flight / stagger / palette).
 * Anchored to the checklist ring so the burst reads as "you finished setup".
 */
function ChecklistConfetti(): ReactElement {
  const { count, spreadDeg, flightMs, staggerMs } = motion.confetti;
  // Dark is the default theme (data-theme is set ONLY for light), so pick the
  // dark palette unless the doc is explicitly light — otherwise the burst is
  // off-brand in the dominant theme.
  const palette =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? motion.confetti.paletteLight
      : motion.confetti.paletteDark;
  const particles = useMemo(() => {
    const out: { angle: number; dist: number; color: string; delay: number }[] =
      [];
    for (let i = 0; i < count; i++) {
      out.push({
        angle: (i / count) * spreadDeg + Math.random() * 12,
        dist: 70 + Math.random() * 70,
        color: palette[i % palette.length] ?? palette[0]!,
        delay: (i % count) * staggerMs + Math.random() * 60,
      });
    }
    return out;
  }, [count, spreadDeg, staggerMs, palette]);
  return (
    <div
      className="tour-confetti"
      aria-hidden="true"
      style={{ left: RING_SIZE / 2, top: RING_SIZE / 2, inset: "auto" }}
    >
      {particles.map((p, i) => {
        const dx = Math.cos((p.angle * Math.PI) / 180) * p.dist;
        const dy = Math.sin((p.angle * Math.PI) / 180) * p.dist;
        const style: CSSProperties = {
          ["--tx" as string]: `${dx.toFixed(1)}px`,
          ["--ty" as string]: `${dy.toFixed(1)}px`,
          background: p.color,
          animationDuration: `${flightMs}ms`,
          animationDelay: `${p.delay.toFixed(0)}ms`,
        };
        return (
          <span key={i} className="tour-confetti-particle" style={style} />
        );
      })}
    </div>
  );
}
