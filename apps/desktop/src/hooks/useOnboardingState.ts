import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

import {
  hasCriticalToast,
  subscribeToastState,
} from "../components/Toast";
import { onboardingDecisionsApi } from "../lib/api-client";
import {
  subscribeDialogStack,
  topDialog,
} from "../lib/dialogStack";
import { useLifecycleDecisionState } from "../lib/lifecycle-coordinator";
import {
  onboardingStepsForRole,
  type ChecklistStepId,
  type OnboardingStepId,
  type OnboardingSurfaceId,
} from "../lib/onboarding-manifest";
import { emitOnboardingAnalyticsIntent } from "../lib/onboarding-analytics";
import {
  OnboardingStateController,
  type OnboardingDecisionPort,
} from "../lib/onboarding-state-controller";
import {
  createOnboardingState,
  type OnboardingAction,
  type OnboardingState,
  type OnboardingTrigger,
} from "../lib/onboarding-state-machine";
import {
  onboardingStorageKey,
  type OnboardingIdentity,
  type OnboardingStorage,
} from "../lib/onboarding-state-storage";
import { useMe, type Role } from "../lib/store";

const memoryValues = new Map<string, string>();
const memoryStorage: OnboardingStorage = {
  getItem: (key) => memoryValues.get(key) ?? null,
  setItem: (key, value) => {
    memoryValues.set(key, value);
  },
  removeItem: (key) => {
    memoryValues.delete(key);
  },
};

const controllers = new Map<string, OnboardingStateController>();
let signedOutController: OnboardingStateController | null = null;
const MAX_RETAINED_IDENTITY_CONTROLLERS = 16;
const UNAVAILABLE_STATE = createOnboardingState("unavailable");
const subscribeUnavailable = (): (() => void) => () => undefined;
const getUnavailableState = (): OnboardingState => UNAVAILABLE_STATE;
/**
 * With no identity there is no account to have decided anything, so the
 * decision is not "settled" — it is unknowable. Reporting `false` keeps the
 * interrupting surfaces silent, which is the same answer they take while a
 * real fetch is in flight.
 */
const getUnavailableDecisionsSettled = (): boolean => false;
let storageListenerInstalled = false;

function availableStorage(): OnboardingStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Sandboxed/private contexts keep a process-local state machine.
  }
  return memoryStorage;
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (!event.key) return;
    controllers.get(event.key)?.syncFromStorage(event.newValue);
  });
  storageListenerInstalled = true;
}

/**
 * The real transport behind `OnboardingDecisionPort`.
 *
 * The port has existed — typed, documented, unit-tested against a fake — since
 * `GET/PUT /api/v1/onboarding/steps` shipped, and was never constructed. So a
 * desktop dismissal still lived only in this device's localStorage: dismiss the
 * setup checklist here, open the web app, and it was back; dismiss it there,
 * pick up the phone, and it was back again. Mobile already spoke to this
 * endpoint. Desktop declared the seam and did not cross it.
 *
 * `set` REJECTS on a server error rather than resolving quietly, so the
 * controller's fail-soft `.catch()` is a decision the controller makes and not
 * a failure this layer hides. The local write has already landed either way.
 */
const decisionPort: OnboardingDecisionPort = {
  async list() {
    const res = await onboardingDecisionsApi.list();
    if (res.error) throw new Error(res.error.message);
    const states: Record<string, string> = {};
    for (const [stepKey, decision] of Object.entries(res.data.steps)) {
      states[stepKey] = decision.state;
    }
    return states;
  },
  async set(stepKey, state) {
    const res = await onboardingDecisionsApi.set(
      stepKey,
      // The controller's remote map is typed to the schema's closed
      // vocabulary; this cast re-narrows a widened `string` at the boundary,
      // and the api module rejects anything outside the vocabulary anyway.
      state as Parameters<typeof onboardingDecisionsApi.set>[1],
    );
    if (res.error) throw new Error(res.error.message);
  },
};

/**
 * One in-flight hydration per identity.
 *
 * `useOnboardingState` is consumed by the checklist, the wizard and
 * `useOnboardingProgress` at once, so a dashboard mount would otherwise fire
 * three identical GETs for the same answer.
 */
const hydrations = new Map<string, Promise<void>>();

/**
 * Apply the decisions this person made on their other devices.
 *
 * Exported so the mount effect can await it in tests. Failure is silent by
 * design: the local state machine is already usable, and refusing to render
 * onboarding because a preference fetch failed would be worse than briefly
 * re-showing a dismissed card.
 */
export function hydrateOnboardingDecisions(
  controller: OnboardingStateController,
  port: OnboardingDecisionPort = decisionPort,
): Promise<void> {
  const key = controller.storageKey;
  const existing = hydrations.get(key);
  if (existing) return existing;
  const run = port
    .list()
    .then((decisions) => {
      controller.syncFromRemote(decisions);
    })
    .catch(() => undefined)
    .finally(() => {
      // Settled means "we asked", not "we got an answer". A failed fetch must
      // release the surfaces that wait on this — otherwise an offline window
      // suppresses the tour forever instead of falling back to the local cache,
      // which is the whole reason the cache is still here.
      controller.markDecisionsSettled();
      hydrations.delete(key);
    });
  hydrations.set(key, run);
  return run;
}

export function getOnboardingStateController(
  identity: OnboardingIdentity,
): OnboardingStateController {
  const key = onboardingStorageKey(identity);
  const existing = controllers.get(key);
  if (existing) {
    controllers.delete(key);
    controllers.set(key, existing);
    return existing;
  }
  const controller = new OnboardingStateController({
    identity,
    storage: availableStorage(),
    analytics: emitOnboardingAnalyticsIntent,
    decisions: decisionPort,
  });
  controllers.set(key, controller);
  while (controllers.size > MAX_RETAINED_IDENTITY_CONTROLLERS) {
    const oldest = controllers.keys().next().value as string | undefined;
    if (!oldest) break;
    controllers.delete(oldest);
  }
  installStorageListener();
  return controller;
}

/**
 * Manual, read-only orientation must remain available before authentication.
 * The signed-out shell still exposes Settings and the workspace navigation, so
 * making its tour buttons depend on `/me` turned a useful demo entry point into
 * a silent no-op. This process-local controller is deliberately not hydrated
 * from or persisted to a person's account; `ready` remains false below, which
 * keeps every automatic onboarding surface disabled until there is an actual
 * identity.
 */
function getSignedOutOnboardingStateController(): OnboardingStateController {
  signedOutController ??= new OnboardingStateController({
    identity: {
      workspaceId: "signed-out",
      userId: "signed-out",
      role: "viewer",
    },
    storage: memoryStorage,
  });
  return signedOutController;
}

export interface OnboardingOpenMetadata {
  stepCount?: number;
  stepIndex?: number;
}

export interface OnboardingStepMetadata {
  nextStepIndex?: number;
  stepCount?: number;
  msOnStep?: number;
}

export interface OnboardingStateApi {
  ready: boolean;
  role: Role | null;
  state: OnboardingState;
  /**
   * Whether this person's cross-device decisions have been consulted yet.
   *
   * `state` alone cannot answer "has this been dismissed?" on a device that has
   * never seen the dismissal: local storage says `not-started` because local
   * storage is a CACHE, and the authority is still in flight. A surface that
   * interrupts must read this before it opens itself.
   */
  decisionsSettled: boolean;
  stepsFor: (
    surface: OnboardingSurfaceId,
  ) => ReturnType<typeof onboardingStepsForRole>;
  openSurface: (
    surface: OnboardingSurfaceId,
    trigger: OnboardingTrigger,
    stepId?: OnboardingStepId,
    metadata?: OnboardingOpenMetadata,
  ) => void;
  setStep: (
    surface: OnboardingSurfaceId,
    stepId: OnboardingStepId,
    stepIndex?: number,
    msOnPrevStep?: number,
  ) => void;
  completeStep: (
    surface: OnboardingSurfaceId,
    stepId: OnboardingStepId,
    nextStepId?: OnboardingStepId,
    metadata?: OnboardingStepMetadata,
  ) => void;
  skipStep: (
    surface: OnboardingSurfaceId,
    stepId: OnboardingStepId,
    nextStepId?: OnboardingStepId,
    metadata?: OnboardingStepMetadata,
  ) => void;
  completeSurface: (surface: OnboardingSurfaceId, totalMs?: number) => void;
  skipSurface: (
    surface: OnboardingSurfaceId,
    stepId?: OnboardingStepId,
    stepIndex?: number,
  ) => void;
  dismissSurface: (
    surface: OnboardingSurfaceId,
    stepId?: OnboardingStepId,
    stepIndex?: number,
  ) => void;
  resetSurface: (surface: OnboardingSurfaceId) => void;
  resetAll: () => void;
  syncGoals: (
    completedStepIds: readonly ChecklistStepId[],
    fetchedAt: number,
    announceChanges: boolean,
  ) => void;
}

export function useOnboardingState(): OnboardingStateApi {
  const me = useMe();
  const identity = useMemo<OnboardingIdentity | null>(
    () =>
      me
        ? {
            workspaceId: me.tenant,
            userId: me.user,
            role: me.effectiveRole,
          }
        : null,
    [me?.effectiveRole, me?.tenant, me?.user],
  );
  const controller = useMemo(
    () =>
      identity
        ? getOnboardingStateController(identity)
        : getSignedOutOnboardingStateController(),
    [identity],
  );
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeUnavailable,
    controller?.getSnapshot ?? getUnavailableState,
    controller?.getSnapshot ?? getUnavailableState,
  );
  const decisionsSettled = useSyncExternalStore(
    controller?.subscribe ?? subscribeUnavailable,
    controller?.getDecisionsSettled ?? getUnavailableDecisionsSettled,
    controller?.getDecisionsSettled ?? getUnavailableDecisionsSettled,
  );
  useEffect(() => controller?.activate(), [controller]);
  // Pull the decisions this person made elsewhere. After `activate()`, so a
  // constructor-time storage migration is committed before a remote decision
  // is merged on top of it; on every mount rather than once per process, so a
  // long-lived desktop window still picks up a dismissal made on the phone the
  // next time the dashboard is opened.
  useEffect(() => {
    if (!identity) return;
    void hydrateOnboardingDecisions(controller);
  }, [controller, identity]);
  const dispatch = useCallback(
    (action: OnboardingAction): void => {
      controller?.dispatch(action);
    },
    [controller],
  );
  const role = identity?.role ?? null;

  return useMemo<OnboardingStateApi>(
    () => ({
      ready: identity != null,
      role,
      state,
      decisionsSettled,
      stepsFor: (surface) => onboardingStepsForRole(surface, role),
      openSurface: (surface, trigger, stepId, metadata) =>
        dispatch({
          type: "open",
          surface,
          trigger,
          ...(stepId ? { stepId } : {}),
          ...metadata,
          now: Date.now(),
        }),
      setStep: (surface, stepId, stepIndex, msOnPrevStep) =>
        dispatch({
          type: "set-step",
          surface,
          stepId,
          ...(stepIndex != null ? { stepIndex } : {}),
          ...(msOnPrevStep != null ? { msOnPrevStep } : {}),
          now: Date.now(),
        }),
      completeStep: (surface, stepId, nextStepId, metadata) =>
        dispatch({
          type: "complete-step",
          surface,
          stepId,
          ...(nextStepId ? { nextStepId } : {}),
          ...metadata,
          now: Date.now(),
        }),
      skipStep: (surface, stepId, nextStepId, metadata) =>
        dispatch({
          type: "skip-step",
          surface,
          stepId,
          ...(nextStepId ? { nextStepId } : {}),
          ...metadata,
          now: Date.now(),
        }),
      completeSurface: (surface, totalMs) =>
        dispatch({
          type: "complete-surface",
          surface,
          ...(totalMs != null ? { totalMs } : {}),
          now: Date.now(),
        }),
      skipSurface: (surface, stepId, stepIndex) =>
        dispatch({
          type: "skip-surface",
          surface,
          ...(stepId ? { stepId } : {}),
          ...(stepIndex != null ? { stepIndex } : {}),
          now: Date.now(),
        }),
      dismissSurface: (surface, stepId, stepIndex) =>
        dispatch({
          type: "dismiss-surface",
          surface,
          ...(stepId ? { stepId } : {}),
          ...(stepIndex != null ? { stepIndex } : {}),
          now: Date.now(),
        }),
      resetSurface: (surface) =>
        dispatch({ type: "reset-surface", surface, now: Date.now() }),
      resetAll: () => dispatch({ type: "reset-all", now: Date.now() }),
      syncGoals: (completedStepIds, fetchedAt, announceChanges) =>
        dispatch({
          type: "sync-goals",
          completedStepIds,
          fetchedAt,
          announceChanges,
          now: Date.now(),
        }),
    }),
    [controller, decisionsSettled, dispatch, identity, role, state],
  );
}

let restartRequested = 0;
let restartHandled = 0;
const restartSubscribers = new Set<() => void>();

function restartSnapshot(): number {
  return restartRequested > restartHandled ? restartRequested : 0;
}

export function requestOnboardingWizardRestart(): void {
  restartRequested += 1;
  for (const subscriber of restartSubscribers) subscriber();
}

export function acknowledgeOnboardingWizardRestart(revision: number): void {
  if (revision <= restartHandled) return;
  restartHandled = revision;
  for (const subscriber of restartSubscribers) subscriber();
}

export function useOnboardingWizardRestartRequest(): number {
  return useSyncExternalStore(
    (subscriber) => {
      restartSubscribers.add(subscriber);
      return () => restartSubscribers.delete(subscriber);
    },
    restartSnapshot,
    restartSnapshot,
  );
}

function visibilitySnapshot(): DocumentVisibilityState {
  return typeof document === "undefined" ? "visible" : document.visibilityState;
}

function subscribeVisibility(subscriber: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", subscriber);
  return () => document.removeEventListener("visibilitychange", subscriber);
}

export interface OnboardingUiBlockers {
  blocked: boolean;
  topDialogId: string | null;
  lifecycleReview: boolean;
  criticalError: boolean;
  documentHidden: boolean;
}

export function useOnboardingUiBlockers(
  ownerDialogId?: string,
): OnboardingUiBlockers {
  const activeDialog = useSyncExternalStore(
    subscribeDialogStack,
    topDialog,
    topDialog,
  );
  const criticalError = useSyncExternalStore(
    subscribeToastState,
    hasCriticalToast,
    hasCriticalToast,
  );
  const visibility = useSyncExternalStore(
    subscribeVisibility,
    visibilitySnapshot,
    visibilitySnapshot,
  );
  const lifecycle = useLifecycleDecisionState();
  const lifecycleReview = lifecycle.phase !== "idle";
  const anotherDialog =
    activeDialog != null && activeDialog !== ownerDialogId;
  return {
    blocked:
      anotherDialog ||
      lifecycleReview ||
      criticalError ||
      visibility !== "visible",
    topDialogId: activeDialog,
    lifecycleReview,
    criticalError,
    documentHidden: visibility !== "visible",
  };
}

/** @internal Focused-test reset; never called by production code. */
export function resetOnboardingStateForTests(): void {
  controllers.clear();
  signedOutController = null;
  hydrations.clear();
  memoryValues.clear();
  restartRequested = 0;
  restartHandled = 0;
}
