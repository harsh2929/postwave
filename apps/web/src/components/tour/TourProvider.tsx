// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { EVENTS } from "@postwave/telemetry";
import {
  ONBOARDING_DECISION_RESTORE_STATE,
  adaptiveSteps,
  decisionForStep,
  decisionHidesSurface,
  isGoalComplete,
  isOnboardingProgress,
  type ChecklistGoalKey,
  type OnboardingDecisionState,
  type OnboardingEventProps,
  type OnboardingProgress,
} from "@postwave/onboarding-schema";

import { TOURS } from "./tours";
import { api } from "@/lib/api";
import {
  onboardingAuthorityFromFields,
  onboardingAuthorityReady,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";
import type { RoleKey } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { track } from "@/lib/telemetry";
import { useOnboardingDecisions } from "@/lib/use-onboarding-decisions";
import { canNavigateWithUnsavedChanges } from "@/lib/use-unsaved-changes-guard";
import type { TourContextValue, TourState, TourStep } from "./types";
import {
  clampTourStartIndex,
  shouldAutoStartTour,
  tourAutoStartGate,
  tourDecisionStepKey,
  tourNeedsAuthenticatedProgress,
} from "./tour-routing";

const TourOverlay = dynamic(
  () => import("./TourOverlay").then((module) => module.TourOverlay),
  { ssr: false },
);

const TourContext = createContext<TourContextValue | null>(null);

const PLATFORM = "web" as const;

/**
 * Typed onboarding analytics bridge. `@postwave/telemetry` owns the canonical
 * event NAME (`EVENTS.ONBOARDING_*`), `@postwave/onboarding-schema` owns the
 * PROPERTY shape; we bind them here at the call site, both type-checked, then
 * hand off to the app's existing PostHog `track` capture fn.
 */
function emitOnboarding<E extends keyof OnboardingEventProps>(
  event: E,
  props: OnboardingEventProps[E],
): void {
  track(event, props as unknown as Record<string, unknown>);
}

/**
 * LOCAL STORAGE IS A CACHE HERE, NOT THE AUTHORITY.
 *
 * `postwave_tour_<id>_completed_at` used to be the only record that a person
 * had answered "no thanks" to the dashboard tour — and desktop and mobile each
 * kept their own copy under their own key. So someone dismissed the tour on
 * their laptop, opened the phone, and it ran again: the product asking a
 * question that was already answered, once per device.
 *
 * The answer now lives on the person (`GET/PUT /api/v1/onboarding/steps`, step
 * key `dashboard_tour`), and these keys keep three narrow jobs:
 *
 *   1. THE ANSWER OF LAST RESORT. When nothing is recorded for this person —
 *      they dismissed the tour before this shipped, or the server refuses their
 *      write — this key is the only answer that exists, and the gate honours
 *      it. What it is NOT is an override: a recorded decision outranks it in
 *      both directions, which is what makes it a cache (see
 *      `tourAutoStartGate`).
 *   2. AN OFFLINE `hasCompleted`. The help menu can say "Restart tour" instead
 *      of "Take the tour" with no round-trip and no network.
 *   3. RESUME POSITION (`_step`), which is genuinely per-device: where you got
 *      to in a tour on this screen is not a fact about you.
 *
 * It is deliberately not deleted on upgrade — someone who dismissed the tour
 * before this shipped must not have it come back — so their local answer is
 * both honoured here and promoted to the server (see
 * `AuthenticatedTourDecision`), which is what finally stops their OTHER devices
 * asking.
 */
function lsKey(
  tourId: string,
  suffix: "completed_at" | "step",
  identityScope: string | null = null,
): string {
  const scoped = identityScope ? `_${encodeURIComponent(identityScope)}` : "";
  return `postwave_tour_${tourId}${scoped}_${suffix}`;
}

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* swallow — quota / private mode */
  }
}

function safeRemove(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* swallow */
  }
}

interface TourProviderProps {
  tour: keyof typeof TOURS;
  /**
   * If true, auto-launches once for first-time visitors. We gate on the
   * `completed_at` localStorage key — once a user has seen the tour, we don't
   * auto-re-launch unless they click Replay.
   */
  autoStart?: boolean;
  tenantId?: string;
  userId?: string;
  role?: RoleKey;
  viewerMode?: boolean;
  children: ReactNode;
}

function AuthenticatedTourProgress({
  tenantId,
  userId,
  role,
  viewerMode,
  scope,
  onResult,
}: {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
  scope: string;
  onResult: (scope: string, progress: OnboardingProgress | null) => void;
}): null {
  const queryClient = useQueryClient();
  const authority = useMemo(
    () =>
      onboardingAuthorityFromFields({
        tenantId,
        userId,
        role,
        viewerMode,
      }),
    [role, tenantId, userId, viewerMode],
  );
  const progressKey = useMemo(
    () => onboardingProgressKey(authority),
    [authority],
  );
  const previousRef = useRef<{
    authorityKey: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = {
      authorityKey: authority.key,
      queryKey: progressKey,
    };
    if (!previous || previous.authorityKey === authority.key) return;
    queryClient.removeQueries({ queryKey: previous.queryKey, exact: true });
  }, [authority.key, progressKey, queryClient]);

  const progressQuery = useQuery({
    queryKey: progressKey,
    queryFn: async ({ signal }): Promise<OnboardingProgress | null> => {
      const payload = await api.get<unknown>("/api/v1/onboarding-progress", {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      });
      return isOnboardingProgress(payload) ? payload : null;
    },
    enabled: onboardingAuthorityReady(authority),
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (progressQuery.isSuccess) {
      onResult(scope, progressQuery.data);
    } else if (progressQuery.isError) {
      // Adaptivity is an enhancement, not a reason to strand a first-time
      // visitor behind a permanently closed gate. A definitively failed read
      // releases auto-start with the canonical, unfiltered tour.
      onResult(scope, null);
    }
  }, [
    onResult,
    progressQuery.data,
    progressQuery.isError,
    progressQuery.isSuccess,
    scope,
  ]);
  return null;
}

/** Record one decision about this tour for the person, not the browser. */
export type TourDecisionRecorder = (
  state: OnboardingDecisionState,
  reason?: string,
) => void;

/**
 * The reason written when this device's pre-existing local dismissal is
 * promoted to the person's account.
 *
 * Free text, which is what the column is for. It exists so a row nobody
 * remembers creating is explicable: the person answered on this device before
 * the answer had anywhere to live.
 */
export const TOUR_DECISION_ADOPTED_REASON =
  "dismissed on this device before tour decisions were shared";

/**
 * The tour's half of `GET/PUT /api/v1/onboarding/steps`.
 *
 * A CHILD component, exactly like `AuthenticatedTourProgress` above and for the
 * same reason: the marketing tour mounts `TourProvider` outside any
 * `QueryClientProvider`, so a `useQuery` in the provider body would crash every
 * signed-out page. Isolating the hooks here means an unauthenticated tour makes
 * no request and needs no query client — it simply never mounts this.
 *
 * It reports the decision UP (so the provider can gate auto-launch and answer
 * `hasCompleted`) and registers a writer DOWN (so `skip`/`complete`/`replay` in
 * the provider can record without the provider itself holding query hooks).
 */
function AuthenticatedTourDecision({
  tenantId,
  userId,
  role,
  viewerMode,
  scope,
  stepKey,
  dismissedHereBeforeSession,
  onDecision,
  registerRecorder,
}: {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
  scope: string;
  stepKey: string;
  dismissedHereBeforeSession: boolean;
  onDecision: (
    scope: string,
    loaded: boolean,
    recordedState: string | null,
  ) => void;
  registerRecorder: (
    scope: string,
    record: TourDecisionRecorder | null,
  ) => void;
}): null {
  const decisionRuntime = useOnboardingDecisions({
    tenantId,
    userId,
    role,
    viewerMode,
  });
  const writeDecision = decisionRuntime.writeDecision;

  /**
   * `PUT /api/v1/onboarding/steps` requires the `editor` session role
   * (apps/api/internal/routeauth/manifest.json), so a viewer's write would 403
   * and roll straight back. A viewer keeps the local key and still HONOURS a
   * decision recorded from their own editor-capable session elsewhere — the GET
   * is a viewer-level read.
   */
  useEffect(() => {
    registerRecorder(
      scope,
      decisionRuntime.canDecide && decisionRuntime.isOnline
        ? (state, reason) => {
            void writeDecision(stepKey, state, reason).catch(() => undefined);
          }
        : null,
    );
    return () => registerRecorder(scope, null);
  }, [
    decisionRuntime.canDecide,
    decisionRuntime.isOnline,
    registerRecorder,
    scope,
    stepKey,
    writeDecision,
  ]);

  const loaded = decisionRuntime.isSuccess;
  const data = decisionRuntime.decisions;
  // The STATE, not a boolean: "they snoozed it" and "they never answered" both
  // mean "do not hide", but only the first outranks this device's local key.
  const recordedState = decisionForStep(data, stepKey)?.state ?? null;
  useEffect(() => {
    onDecision(scope, loaded, recordedState);
  }, [loaded, onDecision, recordedState, scope]);

  /**
   * Promote a dismissal this person made BEFORE the answer had anywhere to
   * live. Without this, deleting the local key would re-ask them everywhere and
   * keeping it would re-ask them on every other device — the migration has to
   * carry the answer across, not drop it or freeze it.
   *
   * Only when they have no recorded decision at all: a server row, in any
   * state, is a later and better-sourced answer than this device's leftovers.
   * `dismissedHereBeforeSession` is captured at mount so a dismissal made in
   * THIS session (which the recorder already wrote, correctly, without this
   * reason) can never be mistaken for a legacy one.
   */
  const adoptedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (adoptedScopeRef.current === scope) return;
    if (
      !decisionRuntime.canDecide ||
      !decisionRuntime.isOnline ||
      !loaded ||
      !dismissedHereBeforeSession
    ) {
      return;
    }
    if (data?.steps?.[stepKey]) return;
    adoptedScopeRef.current = scope;
    void writeDecision(
      stepKey,
      "dismissed",
      TOUR_DECISION_ADOPTED_REASON,
    ).catch(() => {
      if (adoptedScopeRef.current === scope) adoptedScopeRef.current = null;
    });
  }, [
    data,
    decisionRuntime.canDecide,
    decisionRuntime.isOnline,
    dismissedHereBeforeSession,
    loaded,
    scope,
    stepKey,
    writeDecision,
  ]);

  return null;
}

export function TourProvider({
  tour: tourId,
  autoStart = true,
  tenantId,
  userId,
  role = null,
  viewerMode = false,
  children,
}: TourProviderProps): JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const tour = TOURS[tourId];
  const decisionStepKey = tour ? tourDecisionStepKey(tour.id) : null;
  const authenticatedAuthority = useMemo(
    () =>
      onboardingAuthorityFromFields({
        tenantId,
        userId,
        role,
        viewerMode,
      }),
    [role, tenantId, userId, viewerMode],
  );
  const authenticatedScope = useMemo(
    () =>
      tenantId && userId && onboardingAuthorityReady(authenticatedAuthority)
        ? authenticatedAuthority.key
        : null,
    [authenticatedAuthority, tenantId, userId],
  );
  const storageKey = useCallback(
    (targetTourId: string, suffix: "completed_at" | "step") =>
      lsKey(targetTourId, suffix, authenticatedScope),
    [authenticatedScope],
  );

  const [state, setState] = useState<TourState>(() => ({
    tourId: null,
    stepIndex: 0,
    isOpen: false,
  }));
  // `null` is a valid run scope for the signed-out marketing tour, so
  // `undefined` is the only safe sentinel for "no active run".
  const activeRunScopeRef = useRef<string | null | undefined>(undefined);
  const [completionConfetti, setCompletionConfetti] = useState(false);
  const confettiTimerRef = useRef<number | null>(null);

  /**
   * "A tour has already been launched this session, do not ambush them again."
   *
   * Latched by `beginTour` rather than only by the auto-launch effect, so a
   * decision arriving after a MANUAL start cannot re-arm the launch timer and
   * restart a tour the person is already in the middle of.
   */
  const autoStartedRef = useRef(false);

  // "This device has already seen the tour through" — the local cache. It is
  // one of the two inputs to `hasCompleted`; the other is the person's own
  // decision, below.
  const [localSnapshot, setLocalSnapshot] = useState<{
    scope: string | null;
    hydrated: boolean;
    seen: boolean;
    dismissedBeforeSession: boolean;
  }>(() => ({
    scope: authenticatedScope,
    hydrated: false,
    seen: false,
    dismissedBeforeSession: false,
  }));
  // Never project a previous principal's browser state through the render in
  // which props changed. This is also load-bearing for legacy adoption: a
  // cached dismissal belonging to A must never be promoted into B's account.
  const localSnapshotIsCurrent =
    localSnapshot.hydrated && localSnapshot.scope === authenticatedScope;
  const seenLocally = localSnapshotIsCurrent && localSnapshot.seen;
  const dismissedHereBeforeSession =
    localSnapshotIsCurrent && localSnapshot.dismissedBeforeSession;

  // The person's cross-device answer. `loaded` is what separates "they have not
  // put the tour away" from "we have not asked yet" — conflating those two is
  // precisely how the tour would flash on screen and then vanish. `state` is
  // kept whole rather than reduced to a boolean because "snoozed" and "never
  // answered" differ: both mean show it, but only the first outranks the local
  // key.
  const [decision, setDecision] = useState<{
    scope: string | null;
    loaded: boolean;
    state: string | null;
  }>({ scope: null, loaded: false, state: null });
  const handleDecision = useCallback(
    (scope: string, loaded: boolean, state: string | null) => {
      setDecision((prev) =>
        prev.scope === scope && prev.loaded === loaded && prev.state === state
          ? prev
          : { scope, loaded, state },
      );
    },
    [],
  );

  // The writer, published upward by the decision child. Null whenever nothing
  // can be recorded (signed out, a tour with no decision, or a viewer whose
  // write the server would refuse) — so every write site is one optional call
  // and no site needs to re-derive who may decide.
  const recorderRef = useRef<{
    scope: string;
    record: TourDecisionRecorder;
  } | null>(null);
  const registerRecorder = useCallback(
    (scope: string, record: TourDecisionRecorder | null) => {
      if (record) {
        recorderRef.current = { scope, record };
      } else if (recorderRef.current?.scope === scope) {
        // An old child's cleanup can run after the new child registered. Scope
        // ownership prevents that cleanup from clearing the new principal's
        // writer.
        recorderRef.current = null;
      }
    },
    [],
  );
  const recordTourDecision = useCallback(
    (state: OnboardingDecisionState, reason?: string) => {
      const recorder = recorderRef.current;
      if (recorder?.scope === authenticatedScope) {
        recorder.record(state, reason);
      }
    },
    [authenticatedScope],
  );

  /**
   * Has this person already been through the tour — anywhere?
   *
   * The local half answers for this browser; the decision half answers for
   * them. Without the second, a laptop that had never run the tour offered
   * "Take the tour" as though it were new to someone who finished it on their
   * phone that morning — the same repeat-question defect in miniature.
   */
  const hasCompleted =
    seenLocally ||
    (decision.scope === authenticatedScope &&
      decisionHidesSurface(decision.state));

  // Server onboarding progress — drives adaptive tours (skip steps whose work
  // is already done). Its readiness is tracked independently from its value:
  // `null` can mean either "not answered yet" or "the request failed / returned
  // an invalid payload", and only the latter may release auto-start. Without
  // this gate, whichever of the decision and progress requests happened to win
  // a 600ms race determined whether the same person saw a 10-step or adapted
  // tour. Scope the snapshot so a provider reused across tenant/role changes
  // can never adapt from the previous account's progress.
  const progressScope =
    authenticatedScope && tourNeedsAuthenticatedProgress(tourId)
      ? `${tourId}:${authenticatedScope}`
      : null;
  const [progressSnapshot, setProgressSnapshot] = useState<{
    scope: string | null;
    settled: boolean;
    progress: OnboardingProgress | null;
  }>({ scope: null, settled: false, progress: null });
  const progressRef = useRef<{
    scope: string | null;
    progress: OnboardingProgress | null;
  }>({ scope: null, progress: null });
  const handleProgressResult = useCallback(
    (scope: string, nextProgress: OnboardingProgress | null) => {
      progressRef.current = { scope, progress: nextProgress };
      setProgressSnapshot((previous) =>
        previous.scope === scope &&
        previous.settled &&
        previous.progress === nextProgress
          ? previous
          : { scope, settled: true, progress: nextProgress },
      );
    },
    [],
  );
  const progressSettled =
    progressScope === null ||
    (progressSnapshot.scope === progressScope && progressSnapshot.settled);
  const progress =
    progressSnapshot.scope === progressScope ? progressSnapshot.progress : null;

  // The adapted step list is FROZEN for the lifetime of an active tour: it is
  // snapshotted at start() time into `activeSteps` (+ ref). This prevents the
  // index-drift bug where a late-arriving progress fetch re-filters the list
  // mid-tour, shifting/dropping the step the user is on (which could make the
  // overlay render nothing and the tour silently vanish). When no tour is
  // open, the context exposes a live preview list instead.
  const [activeSteps, setActiveSteps] = useState<TourStep[]>([]);
  const activeStepsRef = useRef<TourStep[]>([]);

  // Mirror state into a ref so action callbacks can read the current step/tour
  // synchronously and emit analytics OUTSIDE the setState updater (updaters
  // must be pure; emitting inside them double-fires under React StrictMode).
  const stateRef = useRef<TourState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const commitState = useCallback((nextState: TourState): void => {
    // Action callbacks can run more than once before React commits (double
    // click, key activation plus click, two observers in the same task). Keep
    // the imperative view in lockstep so the second action sees the first one
    // immediately and cannot write duplicate completion/dismissal decisions.
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  // Preserve the control the person used to launch the tour. Launcher menu
  // items unmount for the whole run, so on close we prefer the original node
  // when it still exists and otherwise return to the newly remounted launcher.
  // This covers Escape, backdrop dismissal, completion, and an auto-skipped
  // final step instead of leaving focus on <body> after the tooltip disappears.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (state.isOpen) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const fallback = document.querySelector<HTMLElement>(
        "[data-tour-return-focus]",
      );
      const previousIsUsable = Boolean(
        previous?.isConnected &&
        previous !== document.body &&
        previous !== document.documentElement &&
        !previous.closest("[hidden], [inert], [aria-hidden='true']") &&
        !(previous instanceof HTMLButtonElement && previous.disabled),
      );
      const target = previousIsUsable ? previous : fallback;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state.isOpen]);

  // Resolve the steps a tenant should actually SEE for a tour, given their
  // server progress. Pure filter via the shared `adaptiveSteps`; the runtime
  // objects keep web's `navigateTo`, so we re-narrow to the web step type.
  const adaptedStepsFor = useCallback(
    (
      tourId: string | null,
      progressOverride: OnboardingProgress | null = progressRef.current
        .scope === progressScope
        ? progressRef.current.progress
        : null,
    ): TourStep[] => {
      if (!tourId) return [];
      const all = TOURS[tourId]?.steps ?? [];
      const prog = progressOverride;
      if (!prog) return all;
      return adaptiveSteps(all, (key: ChecklistGoalKey) =>
        isGoalComplete(prog, key),
      ) as TourStep[];
    },
    [progressScope],
  );

  // --- Analytics timing refs ------------------------------------------------
  // Wall-clock when the active tour started (for tour_completed totalMs).
  const tourStartedAtRef = useRef<number | null>(null);
  // Wall-clock when the current step was entered (for step_viewed msOnPrevStep).
  const stepEnteredAtRef = useRef<number | null>(null);
  // True once we've emitted tour_completed/_dismissed, so the unmount/abandon
  // path doesn't double-count.
  const tourClosedRef = useRef(false);

  function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  // Freezes the adapted step list for this tour run and emits tour_started +
  // the first step_viewed. All later navigation/analytics read the frozen list.
  const emitStarted = useCallback(
    (
      targetId: string,
      trigger: "auto" | "manual",
      fromIndex: number,
      adapted: TourStep[],
    ): void => {
      activeStepsRef.current = adapted;
      setActiveSteps(adapted);
      tourStartedAtRef.current = nowMs();
      stepEnteredAtRef.current = nowMs();
      tourClosedRef.current = false;
      emitOnboarding(EVENTS.ONBOARDING_TOUR_STARTED, {
        platform: PLATFORM,
        tourId: targetId,
        // Step count AFTER adaptive filtering (steps whose goal is done dropped).
        stepCount: adapted.length,
        trigger,
      });
      const firstStep = adapted[fromIndex];
      if (firstStep) {
        emitOnboarding(EVENTS.ONBOARDING_TOUR_STEP_VIEWED, {
          platform: PLATFORM,
          tourId: targetId,
          stepId: firstStep.id,
          index: fromIndex,
        });
      }
    },
    [],
  );

  const beginTour = useCallback(
    (
      targetId: string,
      trigger: "auto" | "manual",
      requestedIndex: number,
    ): void => {
      if (stateRef.current.isOpen) return;
      // A dashboard tour carries per-person state. Until all identity fields
      // are verified, even a manual launch would write resume/completion keys
      // into the old browser-global namespace and could later be claimed by
      // the wrong account. Marketing has no decision key and remains local.
      if (decisionStepKey !== null && authenticatedScope === null) return;
      autoStartedRef.current = true;
      if (!stateRef.current.isOpen && typeof document !== "undefined") {
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement ? active : null;
      }
      // An explicitly requested walkthrough demonstrates every section, even
      // after sample data satisfies onboarding goals. Auto-launch stays adaptive.
      const adapted =
        trigger === "manual"
          ? (TOURS[targetId]?.steps ?? [])
          : adaptedStepsFor(targetId);
      const startIndex = clampTourStartIndex(requestedIndex, adapted.length);
      if (startIndex === null) {
        activeRunScopeRef.current = undefined;
        activeStepsRef.current = [];
        setActiveSteps([]);
        commitState({ tourId: null, stepIndex: 0, isOpen: false });
        setLocalSnapshot({
          scope: authenticatedScope,
          hydrated: true,
          seen: true,
          dismissedBeforeSession: false,
        });
        safeSet(storageKey(targetId, "completed_at"), new Date().toISOString());
        safeRemove(storageKey(targetId, "step"));
        return;
      }
      const destination = adapted[startIndex]?.route;
      if (destination && pathname !== destination) {
        if (!canNavigateWithUnsavedChanges()) return;
        router.push(asRoute(destination));
      }
      activeRunScopeRef.current = authenticatedScope;
      commitState({ tourId: targetId, stepIndex: startIndex, isOpen: true });
      emitStarted(targetId, trigger, startIndex, adapted);
    },
    [
      adaptedStepsFor,
      authenticatedScope,
      commitState,
      decisionStepKey,
      emitStarted,
      storageKey,
      pathname,
      router,
    ],
  );

  const emitStepViewed = useCallback(
    (targetId: string, index: number): void => {
      const step = activeStepsRef.current[index];
      if (!step) return;
      const prevEntered = stepEnteredAtRef.current;
      const msOnPrevStep =
        prevEntered !== null ? Math.round(nowMs() - prevEntered) : undefined;
      stepEnteredAtRef.current = nowMs();
      emitOnboarding(EVENTS.ONBOARDING_TOUR_STEP_VIEWED, {
        platform: PLATFORM,
        tourId: targetId,
        stepId: step.id,
        index,
        ...(msOnPrevStep !== undefined ? { msOnPrevStep } : {}),
      });
    },
    [],
  );

  const emitCompleted = useCallback((targetId: string): void => {
    if (tourClosedRef.current) return;
    tourClosedRef.current = true;
    const startedAt = tourStartedAtRef.current;
    emitOnboarding(EVENTS.ONBOARDING_TOUR_COMPLETED, {
      platform: PLATFORM,
      tourId: targetId,
      totalMs: startedAt !== null ? Math.round(nowMs() - startedAt) : 0,
    });
  }, []);

  const emitDismissed = useCallback((targetId: string, index: number): void => {
    if (tourClosedRef.current) return;
    tourClosedRef.current = true;
    const step = activeStepsRef.current[index];
    emitOnboarding(EVENTS.ONBOARDING_TOUR_DISMISSED, {
      platform: PLATFORM,
      tourId: targetId,
      lastStepId: step?.id ?? "",
      index,
    });
  }, []);

  // Hydrate the local fallback for the exact authenticated principal. The old
  // browser-wide dashboard key is inherently ambiguous; claim it once for the
  // first authenticated identity that sees it, then remove it so a workspace
  // switch cannot inherit another person's dismissal.
  const hydratedScopeRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!tour) return;
    const scopeChanged = hydratedScopeRef.current !== authenticatedScope;
    hydratedScopeRef.current = authenticatedScope;
    if (scopeChanged) {
      autoStartedRef.current = false;
      activeRunScopeRef.current = undefined;
      tourClosedRef.current = true;
      setCompletionConfetti(false);
      if (confettiTimerRef.current !== null) {
        window.clearTimeout(confettiTimerRef.current);
        confettiTimerRef.current = null;
      }
      const current = stateRef.current;
      if (current.isOpen) {
        activeStepsRef.current = [];
        setActiveSteps([]);
        commitState({ tourId: null, stepIndex: 0, isOpen: false });
      }
    }

    // An authenticated tour with an incomplete identity stays inert. In
    // particular it must not read or migrate the browser-global legacy key.
    if (decisionStepKey !== null && authenticatedScope === null) {
      setLocalSnapshot({
        scope: null,
        hydrated: false,
        seen: false,
        dismissedBeforeSession: false,
      });
      return;
    }

    const exactKey = storageKey(tour.id, "completed_at");
    let completedValue = safeGet(exactKey);
    if (authenticatedScope && !completedValue) {
      const legacyKey = lsKey(tour.id, "completed_at");
      const legacyValue = safeGet(legacyKey);
      if (legacyValue) {
        safeSet(exactKey, legacyValue);
        safeRemove(legacyKey);
        completedValue = legacyValue;
      }
    }
    const completedAt = Boolean(completedValue);
    setLocalSnapshot({
      scope: authenticatedScope,
      hydrated: true,
      seen: completedAt,
      dismissedBeforeSession: completedAt,
    });
  }, [authenticatedScope, commitState, decisionStepKey, storageKey, tour]);

  /**
   * Auto-launch — for first-time visitors, and only for them.
   *
   * The local key is read SYNCHRONOUSLY here rather than from `seenLocally`,
   * which is hydrated in an effect and is therefore still false on the first
   * render. Reading the hydrated state instead would let an already-dismissed
   * tour arm its timer during that first render and launch anyway.
   *
   * `unknown` returns WITHOUT arming the timer, so the tour has not started and
   * has nothing to take back; when the decision lands, this effect re-runs and
   * launches then. That is the whole no-flash property: the tour is never on
   * screen before the answer is.
   *
   * Nothing is latched at ARM time — only `beginTour` latches, when the tour
   * actually opens. That matters because the cleanup below cancels a pending
   * launch on every dependency change (someone navigating off the dashboard
   * inside the delay must not be ambushed a moment later on another page). If
   * arming latched, a cancellation would be permanent and the tour would
   * silently never run; instead each re-run re-decides and re-arms if the
   * conditions still hold.
   */
  useEffect(() => {
    if (!tour || !autoStart || autoStartedRef.current) return;
    if (!shouldAutoStartTour(pathname, tour.startsOn)) return;
    if (!progressSettled) return;
    const gate = tourAutoStartGate({
      recordsDecision: decisionStepKey !== null,
      decisionLoaded:
        authenticatedScope !== null && decision.scope === authenticatedScope
          ? decision.loaded
          : false,
      recordedState:
        authenticatedScope !== null && decision.scope === authenticatedScope
          ? decision.state
          : null,
      dismissedOnThisDevice: Boolean(
        safeGet(storageKey(tour.id, "completed_at")),
      ),
    });
    if (gate !== "allowed") return;
    // Defer to next tick to give the page a chance to mount real DOM.
    const timer = window.setTimeout(() => {
      beginTour(tour.id, "auto", 0);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    tour,
    autoStart,
    beginTour,
    decision,
    decisionStepKey,
    authenticatedScope,
    pathname,
    progressSettled,
    storageKey,
  ]);

  const rememberLocalCompletion = useCallback(
    (seen: boolean): void => {
      setLocalSnapshot({
        scope: authenticatedScope,
        hydrated: true,
        seen,
        // A choice made in this mounted session must never be reclassified as
        // a legacy dismissal that needs adopting on the server.
        dismissedBeforeSession: false,
      });
    },
    [authenticatedScope],
  );

  const closeRunIfPrincipalChanged = useCallback((): boolean => {
    if (activeRunScopeRef.current === authenticatedScope) return false;
    activeRunScopeRef.current = undefined;
    tourClosedRef.current = true;
    activeStepsRef.current = [];
    setActiveSteps([]);
    const current = stateRef.current;
    if (current.isOpen) {
      commitState({ tourId: null, stepIndex: 0, isOpen: false });
    }
    return true;
  }, [authenticatedScope, commitState]);

  const start = useCallback(
    (id?: string) => {
      const targetId = id ?? tour?.id;
      if (!targetId || !TOURS[targetId]) return;
      const savedStep = parseInt(
        safeGet(storageKey(targetId, "step")) ?? "0",
        10,
      );
      beginTour(targetId, "manual", savedStep);
    },
    [beginTour, storageKey, tour],
  );

  const replay = useCallback(() => {
    if (!tour) return;
    if (decisionStepKey !== null && authenticatedScope === null) return;
    safeRemove(storageKey(tour.id, "completed_at"));
    safeRemove(storageKey(tour.id, "step"));
    rememberLocalCompletion(false);
    // "Show me this again" is a decision too, and the vocabulary already has
    // the honest word for it. Recording it here is what stops a replay from
    // being a local-only unhide — and it is the same state the checklist's
    // "Show checklist" writes, so the two undo paths agree rather than each
    // inventing a way back.
    recordTourDecision(ONBOARDING_DECISION_RESTORE_STATE);
    beginTour(tour.id, "manual", 0);
  }, [
    authenticatedScope,
    beginTour,
    decisionStepKey,
    recordTourDecision,
    rememberLocalCompletion,
    storageKey,
    tour,
  ]);

  useEffect(() => {
    return () => {
      if (confettiTimerRef.current !== null) {
        window.clearTimeout(confettiTimerRef.current);
      }
    };
  }, []);

  const complete = useCallback(() => {
    // Read the committed state via ref + emit OUTSIDE the updater (pure updater).
    const s = stateRef.current;
    if (!s.tourId || !s.isOpen || tourClosedRef.current) return;
    if (closeRunIfPrincipalChanged()) return;
    safeSet(storageKey(s.tourId, "completed_at"), new Date().toISOString());
    safeRemove(storageKey(s.tourId, "step"));
    emitCompleted(s.tourId);
    // Finishing the tour is the canonical "completed step" ECO-21 names: no
    // other device may ask them to sit through it again. There is no
    // "completed" in the closed vocabulary and inventing one would let a
    // client write done-ness; `dismissed` — stop showing me this — is the
    // honest member, and the completed-vs-abandoned distinction is already
    // carried precisely by the analytics events above.
    recordTourDecision("dismissed");
    activeRunScopeRef.current = undefined;
    commitState({ ...s, isOpen: false });
    rememberLocalCompletion(true);
    setCompletionConfetti(true);
    if (typeof window !== "undefined") {
      if (confettiTimerRef.current !== null) {
        window.clearTimeout(confettiTimerRef.current);
      }
      confettiTimerRef.current = window.setTimeout(() => {
        setCompletionConfetti(false);
        confettiTimerRef.current = null;
      }, 1800);
    }
  }, [
    closeRunIfPrincipalChanged,
    commitState,
    emitCompleted,
    recordTourDecision,
    rememberLocalCompletion,
    storageKey,
  ]);

  const skip = useCallback(() => {
    const s = stateRef.current;
    if (!s.tourId || !s.isOpen || tourClosedRef.current) return;
    if (closeRunIfPrincipalChanged()) return;
    safeSet(storageKey(s.tourId, "completed_at"), new Date().toISOString());
    safeRemove(storageKey(s.tourId, "step"));
    // The web engine binds skip() to Escape / backdrop / the Skip button —
    // i.e. the user abandoning the tour. Record it as a dismissal.
    emitDismissed(s.tourId, s.stepIndex);
    recordTourDecision("dismissed");
    activeRunScopeRef.current = undefined;
    commitState({ ...s, isOpen: false });
    rememberLocalCompletion(true);
  }, [
    closeRunIfPrincipalChanged,
    commitState,
    emitDismissed,
    recordTourDecision,
    rememberLocalCompletion,
    storageKey,
  ]);

  const steps = useMemo<TourStep[]>(() => {
    // While a tour is OPEN, expose the FROZEN list snapshotted at start — never
    // re-filter mid-tour (that caused index drift / silent disappearance). When
    // closed, expose a live preview that reacts to progress landing.
    if (state.isOpen) return activeSteps;
    return adaptedStepsFor(tour?.id ?? null, progress);
  }, [state.isOpen, activeSteps, tour, progress, adaptedStepsFor]);

  const goTo = useCallback(
    (idx: number) => {
      const s = stateRef.current;
      if (!s.tourId || !s.isOpen) return;
      if (closeRunIfPrincipalChanged()) return;
      const clamped = Math.max(
        0,
        Math.min(idx, activeStepsRef.current.length - 1),
      );
      const destination = activeStepsRef.current[clamped]?.route;
      if (destination && pathname !== destination) {
        if (!canNavigateWithUnsavedChanges()) return;
        router.push(asRoute(destination));
      }
      safeSet(storageKey(s.tourId, "step"), String(clamped));
      if (clamped !== s.stepIndex) emitStepViewed(s.tourId, clamped);
      commitState({ ...s, stepIndex: clamped });
    },
    [
      closeRunIfPrincipalChanged,
      commitState,
      emitStepViewed,
      storageKey,
      pathname,
      router,
    ],
  );

  const next = useCallback(() => {
    const s = stateRef.current;
    if (!s.tourId || !s.isOpen) return;
    if (closeRunIfPrincipalChanged()) return;
    const stepList = activeStepsRef.current;
    const current = stepList[s.stepIndex];
    const nextIndex = s.stepIndex + 1;
    // Honor navigateTo: route to the page before advancing the step counter.
    if (current?.navigateTo) {
      try {
        if (canNavigateWithUnsavedChanges()) {
          router.push(asRoute(current.navigateTo));
        } else {
          return;
        }
      } catch {
        /* ignore router errors */
      }
    }
    if (nextIndex >= stepList.length) {
      // Overflow → treat as completion (the overlay's Done button calls
      // complete()). Same completion, same record: walking off the end of the
      // tour is finishing it, and finishing it must travel with the person.
      safeSet(storageKey(s.tourId, "completed_at"), new Date().toISOString());
      safeRemove(storageKey(s.tourId, "step"));
      emitCompleted(s.tourId);
      recordTourDecision("dismissed");
      activeRunScopeRef.current = undefined;
      commitState({ ...s, isOpen: false });
      rememberLocalCompletion(true);
      return;
    }
    safeSet(storageKey(s.tourId, "step"), String(nextIndex));
    emitStepViewed(s.tourId, nextIndex);
    commitState({ ...s, stepIndex: nextIndex });
  }, [
    commitState,
    closeRunIfPrincipalChanged,
    emitCompleted,
    emitStepViewed,
    recordTourDecision,
    rememberLocalCompletion,
    router,
    storageKey,
  ]);

  const back = useCallback(() => {
    const s = stateRef.current;
    if (!s.tourId || !s.isOpen) return;
    if (closeRunIfPrincipalChanged()) return;
    const prev = Math.max(0, s.stepIndex - 1);
    const destination = activeStepsRef.current[prev]?.route;
    if (destination && pathname !== destination) {
      if (!canNavigateWithUnsavedChanges()) return;
      router.push(asRoute(destination));
    }
    safeSet(storageKey(s.tourId, "step"), String(prev));
    if (prev !== s.stepIndex) emitStepViewed(s.tourId, prev);
    commitState({ ...s, stepIndex: prev });
  }, [
    closeRunIfPrincipalChanged,
    commitState,
    emitStepViewed,
    storageKey,
    pathname,
    router,
  ]);

  // Auto-advance triggered by the overlay when a step's target can't be
  // resolved (skipIfMissing). Records a per-step skip, then moves on.
  const skipStep = useCallback(() => {
    const s = stateRef.current;
    if (!s.tourId || !s.isOpen) return;
    if (closeRunIfPrincipalChanged()) return;
    const stepList = activeStepsRef.current;
    const current = stepList[s.stepIndex];
    if (current) {
      emitOnboarding(EVENTS.ONBOARDING_TOUR_STEP_SKIPPED, {
        platform: PLATFORM,
        tourId: s.tourId,
        stepId: current.id,
        index: s.stepIndex,
      });
    }
    const nextIndex = s.stepIndex + 1;
    if (nextIndex >= stepList.length) {
      safeSet(storageKey(s.tourId, "completed_at"), new Date().toISOString());
      safeRemove(storageKey(s.tourId, "step"));
      emitCompleted(s.tourId);
      recordTourDecision("dismissed");
      activeRunScopeRef.current = undefined;
      commitState({ ...s, isOpen: false });
      rememberLocalCompletion(true);
      return;
    }
    safeSet(storageKey(s.tourId, "step"), String(nextIndex));
    emitStepViewed(s.tourId, nextIndex);
    commitState({ ...s, stepIndex: nextIndex });
  }, [
    commitState,
    closeRunIfPrincipalChanged,
    emitCompleted,
    emitStepViewed,
    recordTourDecision,
    rememberLocalCompletion,
    storageKey,
  ]);

  const value = useMemo<TourContextValue>(
    () => ({
      state,
      steps,
      start,
      next,
      skipStep,
      back,
      skip,
      complete,
      replay,
      goTo,
      hasCompleted,
    }),
    [
      state,
      steps,
      start,
      next,
      skipStep,
      back,
      skip,
      complete,
      replay,
      goTo,
      hasCompleted,
    ],
  );

  return (
    <TourContext.Provider value={value}>
      {tenantId && userId && progressScope ? (
        <AuthenticatedTourProgress
          tenantId={tenantId}
          userId={userId}
          role={role}
          viewerMode={viewerMode}
          scope={progressScope}
          onResult={handleProgressResult}
        />
      ) : null}
      {tenantId && userId && decisionStepKey && authenticatedScope ? (
        <AuthenticatedTourDecision
          tenantId={tenantId}
          userId={userId}
          role={role}
          viewerMode={viewerMode}
          scope={authenticatedScope}
          stepKey={decisionStepKey}
          dismissedHereBeforeSession={dismissedHereBeforeSession}
          onDecision={handleDecision}
          registerRecorder={registerRecorder}
        />
      ) : null}
      {children}
      {state.isOpen && state.tourId ? <TourOverlay /> : null}
      {completionConfetti ? (
        <div
          data-testid="confetti-canvas"
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            pointerEvents: "none",
            zIndex: 60,
          }}
        />
      ) : null}
    </TourContext.Provider>
  );
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) {
    // Soft-fall: return a no-op shape so hooks in stray locations don't crash.
    return {
      state: { tourId: null, stepIndex: 0, isOpen: false },
      steps: [],
      start: () => {},
      next: () => {},
      skipStep: () => {},
      back: () => {},
      skip: () => {},
      complete: () => {},
      replay: () => {},
      goTo: () => {},
      hasCompleted: false,
    };
  }
  return ctx;
}
