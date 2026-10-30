import { useSyncExternalStore } from "react";

export type LifecycleIntentKind =
  | "route-change"
  | "close-window"
  | "quit-app"
  | "sign-out"
  | "workspace-switch"
  | "update-restart"
  | "os-shutdown";

export interface LifecycleIntent {
  kind: LifecycleIntentKind;
  /** Physical consequence, distinct from the entry point that requested it. */
  disposition?: "hide" | "navigate" | "exit" | "restart" | "identity-change";
  title: string;
  description: string;
  confirmLabel: string;
  targetLabel?: string;
  danger?: boolean;
}

export interface LifecycleConcernInput {
  detail?: string;
  level: "warning" | "blocking";
  canSave?: boolean;
  canDiscard?: boolean;
  canRecover?: boolean;
}

export interface LifecycleConcern extends LifecycleConcernInput {
  guardId: string;
  label: string;
  canSave: boolean;
  canDiscard: boolean;
  canRecover: boolean;
}

export interface LifecycleGuard {
  id: string;
  label: string;
  /** Omit to participate in every lifecycle decision. */
  kinds?: readonly LifecycleIntentKind[];
  inspect: (
    intent: LifecycleIntent,
  ) =>
    | LifecycleConcernInput
    | LifecycleConcernInput[]
    | null
    | Promise<LifecycleConcernInput | LifecycleConcernInput[] | null>;
  /** Flush or save recoverable state before the transition. */
  prepare?: (intent: LifecycleIntent) => void | Promise<void>;
  /** Explicitly abandon the owner's recoverable state. */
  discard?: (intent: LifecycleIntent) => void | Promise<void>;
  /** Attempt owner-specific recovery, such as reopening a failed journal. */
  recover?: (intent: LifecycleIntent) => void | Promise<void>;
}

export type LifecycleDecisionPhase =
  | "idle"
  | "scanning"
  | "review"
  | "preparing"
  | "discarding"
  | "recovering"
  | "proceeding"
  | "error";

export interface LifecycleDecisionState {
  phase: LifecycleDecisionPhase;
  intent: LifecycleIntent | null;
  concerns: LifecycleConcern[];
  error: string | null;
}

export type LifecycleTransitionResult =
  | "proceeded"
  | "cancelled"
  | "busy"
  | "failed";

interface PendingTransition {
  intent: LifecycleIntent;
  proceed: () => void | Promise<void>;
  resolve: (result: LifecycleTransitionResult) => void;
}

interface RegisteredLifecycleGuard extends LifecycleGuard {
  /** Public owner identity before the registry assigns an instance-safe key. */
  ownerId: string;
}

const IDLE_STATE: LifecycleDecisionState = {
  phase: "idle",
  intent: null,
  concerns: [],
  error: null,
};

const guards = new Map<string, RegisteredLifecycleGuard>();
const guardOwnerCounts = new Map<string, number>();
const subscribers = new Set<() => void>();
const guardSubscribers = new Set<() => void>();
let state: LifecycleDecisionState = IDLE_STATE;
let pending: PendingTransition | null = null;
let guardRegistrationSequence = 0;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function setState(next: LifecycleDecisionState): void {
  state = next;
  notify();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function getLifecycleDecisionState(): LifecycleDecisionState {
  return state;
}

export function useLifecycleDecisionState(): LifecycleDecisionState {
  return useSyncExternalStore(
    subscribe,
    getLifecycleDecisionState,
    getLifecycleDecisionState,
  );
}

/**
 * Synchronous routing fast-path. Navigation stays synchronous when no
 * route-scoped owner is mounted, while an already-open lifecycle decision is
 * always allowed to retain exclusive control of the requested transition.
 */
export function shouldCoordinateLifecycle(kind: LifecycleIntentKind): boolean {
  if (pending) return true;
  for (const guard of guards.values()) {
    if (applies(guard, kind)) return true;
  }
  return false;
}

/**
 * Register one source of active or recoverable work. Duplicate public owner
 * ids become a synthetic blocking concern instead of shadowing one another or
 * throwing from a React effect. Each instance remains registered under an
 * internal key, so unmounting either side safely resolves/re-forms the
 * collision without losing the other owner's inspection.
 */
export function registerLifecycleGuard(guard: LifecycleGuard): () => void {
  const ownerId = guard.id.trim();
  if (!ownerId) throw new Error("Lifecycle guard requires an id");
  const priorOwnerCount = guardOwnerCounts.get(ownerId) ?? 0;
  const registryId =
    priorOwnerCount === 0 && !guards.has(ownerId)
      ? ownerId
      : `${ownerId}::instance-${++guardRegistrationSequence}`;
  const normalized: RegisteredLifecycleGuard = {
    ...guard,
    id: registryId,
    ownerId,
  };
  guards.set(registryId, normalized);
  guardOwnerCounts.set(ownerId, priorOwnerCount + 1);
  notifyGuardSubscribers();
  return () => {
    if (guards.get(registryId) === normalized) {
      guards.delete(registryId);
      const remaining = (guardOwnerCounts.get(ownerId) ?? 1) - 1;
      if (remaining > 0) guardOwnerCounts.set(ownerId, remaining);
      else guardOwnerCounts.delete(ownerId);
      notifyGuardSubscribers();
    }
  };
}

/** Subscribe to owner registration changes (used by the native dirty mark). */
export function subscribeLifecycleGuards(subscriber: () => void): () => void {
  guardSubscribers.add(subscriber);
  return () => guardSubscribers.delete(subscriber);
}

/** Notify stateful, process-wide guards whose registration itself is stable. */
export function signalLifecycleOwnerChanged(): void {
  notifyGuardSubscribers();
}

function notifyGuardSubscribers(): void {
  for (const subscriber of guardSubscribers) subscriber();
}

function applies(guard: LifecycleGuard, kind: LifecycleIntentKind): boolean {
  return !guard.kinds || guard.kinds.includes(kind);
}

/** Collect a deterministic, fail-closed snapshot for any exit path. */
export async function inspectLifecycle(
  intent: LifecycleIntent,
): Promise<LifecycleConcern[]> {
  const applicable = [...guards.values()].filter((guard) =>
    applies(guard, intent.kind),
  );
  const ownerCounts = new Map<string, number>();
  for (const guard of applicable) {
    ownerCounts.set(guard.ownerId, (ownerCounts.get(guard.ownerId) ?? 0) + 1);
  }
  const collisionConcerns: LifecycleConcern[] = [...ownerCounts]
    .filter(([, count]) => count > 1)
    .map(([ownerId]) => ({
      guardId: `__owner-collision__:${ownerId}`,
      label: "Conflicting lifecycle safety owners",
      detail:
        "Moosewave found two active work owners with the same identity. Close the duplicate surface before leaving so neither copy can be skipped.",
      level: "blocking",
      canSave: false,
      canDiscard: false,
      canRecover: false,
    }));
  const inspected = await Promise.all(
    applicable.map(async (guard): Promise<LifecycleConcern[]> => {
      try {
        const operation = Promise.resolve(guard.inspect(intent));
        const result =
          intent.kind === "os-shutdown"
            ? await withTimeout(operation, 500)
            : await operation;
        const entries =
          result == null ? [] : Array.isArray(result) ? result : [result];
        return entries.map((entry) => ({
          ...entry,
          guardId: guard.id,
          label: guard.label,
          canSave: entry.canSave ?? guard.prepare !== undefined,
          canDiscard: entry.canDiscard ?? guard.discard !== undefined,
          canRecover: entry.canRecover ?? guard.recover !== undefined,
        }));
      } catch {
        return [
          {
            guardId: guard.id,
            label: guard.label,
            detail:
              "Moosewave could not verify that this work is safely persisted.",
            level: "blocking",
            canSave: guard.prepare !== undefined,
            canDiscard: guard.discard !== undefined,
            canRecover: guard.recover !== undefined,
          },
        ];
      }
    }),
  );
  return [...collisionConcerns, ...inspected.flat()];
}

export async function prepareLifecycle(intent: LifecycleIntent): Promise<void> {
  if (intent.kind === "os-shutdown") {
    const operations = [...guards.values()]
      .filter((guard) => applies(guard, intent.kind) && guard.prepare)
      .map((guard) => Promise.resolve(guard.prepare?.(intent)));
    await withTimeout(
      Promise.all(operations).then(() => undefined),
      1_500,
    );
    return;
  }
  for (const guard of guards.values()) {
    if (applies(guard, intent.kind)) await guard.prepare?.(intent);
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("lifecycle_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function runConcernAction(
  intent: LifecycleIntent,
  concernIds: ReadonlySet<string>,
  action: "discard" | "recover",
): Promise<void> {
  for (const guard of guards.values()) {
    if (!concernIds.has(guard.id) || !applies(guard, intent.kind)) continue;
    if (action === "discard") await guard.discard?.(intent);
    else await guard.recover?.(intent);
  }
}

/**
 * Request a transition. Safe transitions proceed immediately; unsafe ones
 * remain pending until the root decision dialog resolves them.
 */
export function requestLifecycleTransition(
  intent: LifecycleIntent,
  proceed: () => void | Promise<void>,
): Promise<LifecycleTransitionResult> {
  if (pending) return Promise.resolve("busy");
  return new Promise((resolve) => {
    const request: PendingTransition = { intent, proceed, resolve };
    pending = request;
    setState({ phase: "scanning", intent, concerns: [], error: null });
    void inspectLifecycle(intent).then((concerns) => {
      if (pending !== request) return;
      if (concerns.length > 0) {
        setState({ phase: "review", intent, concerns, error: null });
        return;
      }
      void executePending(request, [], false);
    });
  });
}

async function executePending(
  request: PendingTransition,
  reviewedConcerns: LifecycleConcern[],
  allowWarnings: boolean,
): Promise<void> {
  if (pending !== request) return;
  setState({
    phase: "preparing",
    intent: request.intent,
    concerns: reviewedConcerns,
    error: null,
  });
  try {
    const beforePrepare = await inspectLifecycle(request.intent);
    if (pending !== request) return;
    if (
      beforePrepare.some((concern) => concern.level === "blocking") ||
      (!allowWarnings && beforePrepare.length > 0) ||
      (reviewedConcerns.length > 0 &&
        !sameConcerns(reviewedConcerns, beforePrepare))
    ) {
      setState({
        phase: "review",
        intent: request.intent,
        concerns: beforePrepare,
        error: null,
      });
      return;
    }

    await prepareLifecycle(request.intent);
    if (pending !== request) return;
    const afterPrepare = await inspectLifecycle(request.intent);
    if (pending !== request) return;
    if (
      afterPrepare.some((concern) => concern.level === "blocking") ||
      (!allowWarnings && afterPrepare.length > 0)
    ) {
      setState({
        phase: "review",
        intent: request.intent,
        concerns: afterPrepare,
        error: null,
      });
      return;
    }

    setState({
      phase: "proceeding",
      intent: request.intent,
      concerns: afterPrepare,
      error: null,
    });
    await request.proceed();
    if (pending !== request) return;
    finishPending(request, "proceeded");
  } catch {
    if (pending !== request) return;
    setState({
      phase: "error",
      intent: request.intent,
      concerns: reviewedConcerns,
      error:
        "Moosewave could not safely prepare or complete this transition. Your work has not been discarded.",
    });
  }
}

export function cancelLifecycleTransition(): void {
  const request = pending;
  if (!request || state.phase === "proceeding") return;
  finishPending(request, "cancelled");
}

export async function recheckLifecycleTransition(): Promise<void> {
  const request = pending;
  if (!request) return;
  setState({
    phase: "scanning",
    intent: request.intent,
    concerns: state.concerns,
    error: null,
  });
  const concerns = await inspectLifecycle(request.intent);
  if (pending !== request) return;
  if (concerns.length === 0) {
    await executePending(request, [], false);
    return;
  }
  setState({
    phase: "review",
    intent: request.intent,
    concerns,
    error: null,
  });
}

export async function saveAndRecheckLifecycleTransition(): Promise<void> {
  const request = pending;
  if (!request) return;
  setState({
    phase: "preparing",
    intent: request.intent,
    concerns: state.concerns,
    error: null,
  });
  try {
    await prepareLifecycle(request.intent);
    if (pending === request) await recheckLifecycleTransition();
  } catch {
    if (pending !== request) return;
    setState({
      phase: "error",
      intent: request.intent,
      concerns: state.concerns,
      error:
        "Moosewave could not save all registered work. Nothing was discarded.",
    });
  }
}

export async function discardAndRecheckLifecycleTransition(): Promise<void> {
  await actOnConcernsAndRecheck("discard");
}

export async function recoverAndRecheckLifecycleTransition(): Promise<void> {
  await actOnConcernsAndRecheck("recover");
}

async function actOnConcernsAndRecheck(
  action: "discard" | "recover",
): Promise<void> {
  const request = pending;
  if (!request) return;
  const actionable = state.concerns.filter((concern) =>
    action === "discard" ? concern.canDiscard : concern.canRecover,
  );
  if (actionable.length === 0) return;
  setState({
    phase: action === "discard" ? "discarding" : "recovering",
    intent: request.intent,
    concerns: state.concerns,
    error: null,
  });
  try {
    await runConcernAction(
      request.intent,
      new Set(actionable.map((concern) => concern.guardId)),
      action,
    );
    if (pending === request) await recheckLifecycleTransition();
  } catch {
    if (pending !== request) return;
    setState({
      phase: "error",
      intent: request.intent,
      concerns: state.concerns,
      error:
        action === "discard"
          ? "Moosewave could not discard all selected work. Review it before trying again."
          : "Moosewave could not recover all selected work. Review it before trying again.",
    });
  }
}

export function continueLifecycleTransition(): void {
  const request = pending;
  if (!request || state.phase !== "review") return;
  if (state.concerns.some((concern) => concern.level === "blocking")) return;
  void executePending(request, state.concerns, true);
}

export function retryLifecycleTransition(): void {
  const request = pending;
  if (!request || state.phase !== "error") return;
  void recheckLifecycleTransition();
}

function finishPending(
  request: PendingTransition,
  result: LifecycleTransitionResult,
): void {
  if (pending !== request) return;
  pending = null;
  setState(IDLE_STATE);
  request.resolve(result);
}

function sameConcerns(
  left: LifecycleConcern[],
  right: LifecycleConcern[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((concern, index) => {
    const other = right[index];
    return (
      other?.guardId === concern.guardId &&
      other.label === concern.label &&
      other.detail === concern.detail &&
      other.level === concern.level
    );
  });
}

/** @internal Reset process-wide state between unit tests. */
export function resetLifecycleCoordinatorForTests(): void {
  pending?.resolve("cancelled");
  pending = null;
  guards.clear();
  guardOwnerCounts.clear();
  guardRegistrationSequence = 0;
  notifyGuardSubscribers();
  state = IDLE_STATE;
  notify();
}
