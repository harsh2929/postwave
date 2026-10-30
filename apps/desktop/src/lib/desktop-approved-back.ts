export type ApprovedDesktopBackResult = "applied" | "failed" | "superseded";

export interface ApprovedDesktopBackOptions {
  isStillCurrent?: () => boolean;
  timeoutMs?: number;
}

export interface ApprovedDesktopBackTraversal {
  canonicalUrl: string;
  index: number;
  purpose: "origin" | "restoration";
  scope: string | null;
}

export interface ApprovedDesktopBackTransition {
  expectedCanonicalUrl: string;
  expectedIndex: number;
  isStillCurrent: (() => boolean) | undefined;
  outstandingTraversals: ApprovedDesktopBackTraversal[];
  physicalIndex: number | null;
  protectedCanonicalUrl: string;
  protectedIndex: number;
  protectedRevision: number;
  protectedScope: string | null;
  phase: "seeking" | "restoring" | "quarantined";
  recoveryTimeout: ReturnType<typeof setTimeout> | null;
  restorationResult: Exclude<ApprovedDesktopBackResult, "applied">;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: ApprovedDesktopBackResult) => void;
}

export interface ApprovedDesktopBackCurrent {
  canonicalUrl: string;
  index: number;
  revision: number;
  scope: string | null;
}

export interface ApprovedDesktopBackObservation {
  canonicalUrl: string | null;
  index: number | null;
  scope: string | null | undefined;
  stateCanonicalUrl: string | null;
  stateValid: boolean;
}

export function createApprovedBackObservation(
  canonicalUrl: string | null,
  state: {
    canonicalUrl: string;
    index: number | null;
    scope: string | null;
  } | null,
): ApprovedDesktopBackObservation {
  return {
    canonicalUrl,
    index: state?.index ?? null,
    scope: state?.scope,
    stateCanonicalUrl: state?.canonicalUrl ?? null,
    stateValid: state !== null,
  };
}

export type ApprovedDesktopBackAction =
  | { kind: "apply"; result: ApprovedDesktopBackResult }
  | {
      kind: "go";
      delta: number;
      fallbackIndex: number | null;
      target: ApprovedDesktopBackTraversal;
    }
  | {
      kind: "repair";
      index: number;
      result: Exclude<ApprovedDesktopBackResult, "applied">;
    };

function observationStateIsSelfConsistent(
  observation: ApprovedDesktopBackObservation,
): boolean {
  return (
    observation.stateValid &&
    observation.stateCanonicalUrl === observation.canonicalUrl
  );
}

function trustedObservationIndex(
  observation: ApprovedDesktopBackObservation,
): number | null {
  return observationStateIsSelfConsistent(observation)
    ? observation.index
    : null;
}

function traversalScopeMatches(
  traversal: ApprovedDesktopBackTraversal,
  observation: ApprovedDesktopBackObservation,
): boolean {
  return !observation.stateValid || observation.scope === traversal.scope;
}

function traversalMatchesObservation(
  traversal: ApprovedDesktopBackTraversal,
  observation: ApprovedDesktopBackObservation,
): boolean {
  if (!observationStateIsSelfConsistent(observation)) return false;
  const trustedIndex = trustedObservationIndex(observation);
  if (trustedIndex !== null) {
    return (
      trustedIndex === traversal.index &&
      traversalScopeMatches(traversal, observation)
    );
  }
  return (
    observation.canonicalUrl === traversal.canonicalUrl &&
    traversalScopeMatches(traversal, observation)
  );
}

function wasSuperseded(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
): boolean {
  return (
    transition.isStillCurrent?.() === false ||
    transition.protectedRevision !== current.revision ||
    transition.protectedScope !== current.scope
  );
}

function retargetRestoration(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
): void {
  transition.phase = "restoring";
  transition.restorationResult = "superseded";
  transition.protectedCanonicalUrl = current.canonicalUrl;
  transition.protectedIndex = current.index;
  transition.protectedRevision = current.revision;
  transition.protectedScope = current.scope;
}

export function retargetApprovedBackIfSuperseded(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
): void {
  if (wasSuperseded(transition, current)) {
    retargetRestoration(transition, current);
  }
}

export function enqueueApprovedBackTraversal(
  transition: ApprovedDesktopBackTransition,
  traversal: ApprovedDesktopBackTraversal,
): void {
  transition.outstandingTraversals.push(traversal);
}

export function discardApprovedBackTraversal(
  transition: ApprovedDesktopBackTransition,
  traversal: ApprovedDesktopBackTraversal,
): void {
  const index = transition.outstandingTraversals.indexOf(traversal);
  if (index >= 0) transition.outstandingTraversals.splice(index, 1);
}

export function consumeApprovedBackTraversal(
  transition: ApprovedDesktopBackTransition,
): ApprovedDesktopBackTraversal | null {
  // DesktopRouterEnvironment guarantees that every native/programmatic
  // traversal enters one standards-ordered queue. JavaScript receives no
  // request identifier, so FIFO is the only attribution rule that remains
  // safe when an entry carries missing, stale, forged, or cross-scope state.
  return transition.outstandingTraversals.shift() ?? null;
}

export function observeIssuedApprovedBackTraversal(
  transition: ApprovedDesktopBackTransition,
  traversal: ApprovedDesktopBackTraversal,
  observation: ApprovedDesktopBackObservation,
  locationChanged: boolean,
): boolean {
  if (!transition.outstandingTraversals.includes(traversal)) return false;
  if (
    !locationChanged &&
    !traversalMatchesObservation(traversal, observation)
  ) {
    return false;
  }
  discardApprovedBackTraversal(transition, traversal);
  return true;
}

export function approvedBackObservedIndex(
  observation: ApprovedDesktopBackObservation,
  matchedTraversal: ApprovedDesktopBackTraversal | null,
  inferredIndex: number | null = null,
): number | null {
  return (
    matchedTraversal?.index ??
    trustedObservationIndex(observation) ??
    inferredIndex
  );
}

export function approvedBackHasOutstandingTraversals(
  transition: ApprovedDesktopBackTransition,
): boolean {
  return transition.outstandingTraversals.length > 0;
}

export function approvedBackHasOutstandingRestoration(
  transition: ApprovedDesktopBackTransition,
): boolean {
  return transition.outstandingTraversals.some(
    (traversal) =>
      traversal.purpose === "restoration" &&
      traversal.canonicalUrl === transition.protectedCanonicalUrl &&
      traversal.index === transition.protectedIndex &&
      traversal.scope === transition.protectedScope,
  );
}

export function approvedBackHasEquivalentOutstandingTraversal(
  transition: ApprovedDesktopBackTransition,
  target: ApprovedDesktopBackTraversal,
): boolean {
  return transition.outstandingTraversals.some(
    (traversal) =>
      traversal.purpose === target.purpose &&
      traversal.canonicalUrl === target.canonicalUrl &&
      traversal.index === target.index &&
      traversal.scope === target.scope,
  );
}

function restorationTarget(
  transition: ApprovedDesktopBackTransition,
): ApprovedDesktopBackTraversal {
  return {
    canonicalUrl: transition.protectedCanonicalUrl,
    index: transition.protectedIndex,
    purpose: "restoration",
    scope: transition.protectedScope,
  };
}

function restorationAction(
  transition: ApprovedDesktopBackTransition,
  index: number,
): Extract<ApprovedDesktopBackAction, { kind: "go" }> {
  return {
    kind: "go",
    delta: transition.protectedIndex - index,
    fallbackIndex: index,
    target: restorationTarget(transition),
  };
}

export function resolveApprovedBackPop(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
  observation: ApprovedDesktopBackObservation,
  matchedTraversal: ApprovedDesktopBackTraversal | null,
  inferredIndex: number | null,
): ApprovedDesktopBackAction {
  const exactResult = exactApprovedBackPopResult(
    transition,
    current,
    observation,
    matchedTraversal,
  );
  if (exactResult !== null) return { kind: "apply", result: exactResult };
  transition.phase = "restoring";
  const index = approvedBackObservedIndex(
    observation,
    matchedTraversal,
    inferredIndex,
  );
  if (index === null) {
    return {
      ...restorationAction(transition, transition.protectedIndex - 1),
      fallbackIndex: null,
    };
  }
  if (index !== transition.protectedIndex) {
    return restorationAction(transition, index);
  }
  return { kind: "repair", index, result: transition.restorationResult };
}

export function exactApprovedBackPopResult(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
  observation: ApprovedDesktopBackObservation,
  matchedTraversal: ApprovedDesktopBackTraversal | null,
): ApprovedDesktopBackResult | null {
  retargetApprovedBackIfSuperseded(transition, current);
  if (
    transition.phase === "seeking" &&
    matchedTraversal?.purpose === "origin" &&
    observation.canonicalUrl === transition.expectedCanonicalUrl &&
    observation.index === transition.expectedIndex &&
    observation.scope === current.scope &&
    observationStateIsSelfConsistent(observation)
  ) {
    return "applied";
  }
  if (
    transition.phase !== "seeking" &&
    observation.canonicalUrl === transition.protectedCanonicalUrl &&
    observation.index === transition.protectedIndex &&
    observation.scope === transition.protectedScope &&
    observationStateIsSelfConsistent(observation)
  ) {
    return transition.restorationResult;
  }
  return null;
}

export function beginApprovedBackQuarantine(
  transition: ApprovedDesktopBackTransition,
  current: ApprovedDesktopBackCurrent,
  inferredIndex: number | null,
): ApprovedDesktopBackAction | null {
  retargetApprovedBackIfSuperseded(transition, current);
  transition.phase = "quarantined";
  if (approvedBackHasOutstandingRestoration(transition)) return null;
  const index = inferredIndex;
  if (index === null || index === transition.protectedIndex) return null;
  return restorationAction(transition, index);
}

export function alignedApprovedBackRepairIndex(
  transition: ApprovedDesktopBackTransition,
  observation: ApprovedDesktopBackObservation,
  inferredIndex: number | null,
): number | null {
  const index = inferredIndex;
  return index === transition.protectedIndex &&
    observation.canonicalUrl === transition.protectedCanonicalUrl
    ? index
    : null;
}

export interface ApprovedBackIssueEnvironment {
  go(delta: number): void;
  location(): string;
  observation(): ApprovedDesktopBackObservation;
}

export function issueApprovedBackTraversal(
  transition: ApprovedDesktopBackTransition,
  action: Extract<ApprovedDesktopBackAction, { kind: "go" }>,
  environment: ApprovedBackIssueEnvironment,
): { issued: boolean; observedIndex: number | null } {
  const traversal = action.target;
  if (
    traversal.purpose === "restoration" &&
    approvedBackHasEquivalentOutstandingTraversal(transition, traversal)
  ) {
    return { issued: true, observedIndex: null };
  }
  enqueueApprovedBackTraversal(transition, traversal);
  const previousLocation = environment.location();
  try {
    environment.go(action.delta);
  } catch {
    discardApprovedBackTraversal(transition, traversal);
    return { issued: false, observedIndex: null };
  }
  const consumed = observeIssuedApprovedBackTraversal(
    transition,
    traversal,
    environment.observation(),
    environment.location() !== previousLocation,
  );
  return {
    issued: true,
    observedIndex: consumed ? traversal.index : null,
  };
}

export interface ApprovedBackRecoveryCallbacks {
  alignedIndex(): number | null;
  finish(): void;
  isCurrent(): boolean;
  physicalIndex(): number | null;
  repair(index: number): void;
}

export function scheduleApprovedBackRecovery(
  transition: ApprovedDesktopBackTransition,
  callbacks: ApprovedBackRecoveryCallbacks,
  delayMs = 1_000,
): void {
  if (
    !callbacks.isCurrent() ||
    !transition.settled ||
    transition.recoveryTimeout !== null ||
    callbacks.alignedIndex() !== null
  ) {
    return;
  }
  transition.recoveryTimeout = setTimeout(
    () => {
      transition.recoveryTimeout = null;
      if (!callbacks.isCurrent()) return;
      const alignedIndex = callbacks.alignedIndex();
      if (alignedIndex !== null) callbacks.repair(alignedIndex);
      if (!callbacks.isCurrent()) return;
      const physicalIndex = callbacks.physicalIndex();
      if (callbacks.alignedIndex() === null && physicalIndex !== null) {
        callbacks.repair(physicalIndex);
      }
      callbacks.finish();
    },
    Math.max(1, delayMs),
  );
}

export function settleApprovedBackTransition(
  transition: ApprovedDesktopBackTransition,
  result: ApprovedDesktopBackResult,
  retainForLatePop: boolean,
): boolean {
  if (!transition.settled) {
    transition.settled = true;
    transition.resolve(result);
  }
  clearTimeout(transition.timeout);
  if (retainForLatePop) return false;
  if (transition.recoveryTimeout !== null) {
    clearTimeout(transition.recoveryTimeout);
    transition.recoveryTimeout = null;
  }
  return true;
}
