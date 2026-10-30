import { useCallback, useSyncExternalStore } from "react";

import { desktopRouteIdentityScope } from "./desktop-router";
import { useMe, type Section } from "./store";
import type {
  CapabilityObservation,
  CapabilityObservationState,
} from "./capability-access";

const observations = new Map<string, CapabilityObservation>();
const listeners = new Map<string, Set<() => void>>();
const scopeListeners = new Map<string, Set<() => void>>();
const scopeRevisions = new Map<string, number>();
const MAX_REASON_LENGTH = 512;
const DEFAULT_OWNER = "route";
const UNSAFE_REASON_PATTERN =
  /(?:https?:\/\/|\b(?:api[_ -]?key|authorization|bearer|cookie|oauth|password|secret|session|token)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu;

function observationKey(scope: string, section: Section): string {
  return `${scope}:${section}`;
}

function normalizedOwner(owner: string): string {
  const value = owner.trim().toLowerCase();
  return /^[a-z0-9.-]{1,64}$/u.test(value) ? value : DEFAULT_OWNER;
}

function ownedObservationKey(
  scope: string,
  section: Section,
  owner: string,
): string {
  return `${observationKey(scope, section)}:${normalizedOwner(owner)}`;
}

function observationPriority(state: CapabilityObservationState): number {
  switch (state) {
    case "plan-required":
      return 4;
    case "not-configured":
      return 3;
    case "partial-plan-required":
      return 2;
    case "partial-not-configured":
      return 1;
    case "available":
    default:
      return 0;
  }
}

function safeObservationReason(reason: string): string {
  const normalized = reason.replace(/\s+/gu, " ").trim();
  if (!normalized || UNSAFE_REASON_PATTERN.test(normalized)) {
    return "This capability is currently unavailable. Review setup or access and try again.";
  }
  return normalized.slice(0, MAX_REASON_LENGTH);
}

function aggregateObservation(
  scope: string,
  section: Section,
): CapabilityObservation | null {
  const prefix = `${observationKey(scope, section)}:`;
  let selected: CapabilityObservation | null = null;
  for (const [key, observation] of observations) {
    if (!key.startsWith(prefix)) continue;
    if (
      selected === null ||
      observationPriority(observation.state) >
        observationPriority(selected.state) ||
      (observationPriority(observation.state) ===
        observationPriority(selected.state) &&
        observation.observedAt > selected.observedAt)
    ) {
      selected = observation;
    }
  }
  return selected;
}

export function getCapabilityObservation(
  scope: string | null,
  section: Section,
): CapabilityObservation | null {
  if (!scope) return null;
  return aggregateObservation(scope, section);
}

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function emitScope(scope: string): void {
  scopeRevisions.set(scope, (scopeRevisions.get(scope) ?? 0) + 1);
  for (const listener of scopeListeners.get(scope) ?? []) listener();
}

export function subscribeCapabilityObservations(
  scope: string | null,
  listener: () => void,
): () => void {
  if (!scope) return () => undefined;
  const set = scopeListeners.get(scope) ?? new Set<() => void>();
  set.add(listener);
  scopeListeners.set(scope, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) scopeListeners.delete(scope);
  };
}

export function reportCapabilityObservation(
  scope: string | null,
  section: Section,
  state: CapabilityObservationState,
  reason: string,
  owner = DEFAULT_OWNER,
): void {
  if (!scope) return;
  const subscriptionKey = observationKey(scope, section);
  const key = ownedObservationKey(scope, section, owner);
  if (state === "available") {
    if (observations.delete(key)) {
      emit(subscriptionKey);
      emitScope(scope);
    }
    return;
  }
  const normalizedReason = safeObservationReason(reason);
  const previous = observations.get(key);
  if (previous?.state === state && previous.reason === normalizedReason) return;
  observations.set(key, {
    state,
    reason: normalizedReason,
    observedAt: Date.now(),
  });
  emit(subscriptionKey);
  emitScope(scope);
}

export function clearCapabilityObservation(
  scope: string | null,
  section: Section,
): void {
  if (!scope) return;
  const subscriptionKey = observationKey(scope, section);
  const prefix = `${subscriptionKey}:`;
  let changed = false;
  for (const key of observations.keys()) {
    if (key.startsWith(prefix)) changed = observations.delete(key) || changed;
  }
  if (changed) {
    emit(subscriptionKey);
    emitScope(scope);
  }
}

function subscribe(key: string | null, listener: () => void): () => void {
  if (!key) return () => undefined;
  const set = listeners.get(key) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

export function useCapabilityObservation(
  section: Section,
): CapabilityObservation | null {
  const me = useMe();
  const scope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const key = scope ? observationKey(scope, section) : null;
  return useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => (scope ? getCapabilityObservation(scope, section) : null),
    () => null,
  );
}

export function useCapabilityObservationsRevision(
  scope: string | null,
): number {
  return useSyncExternalStore(
    (listener) => {
      return subscribeCapabilityObservations(scope, listener);
    },
    () => (scope ? (scopeRevisions.get(scope) ?? 0) : 0),
    () => 0,
  );
}

export interface CapabilityReporter {
  available: () => void;
  notConfigured: (reason: string) => void;
  planRequired: (reason: string) => void;
  partialNotConfigured: (reason: string) => void;
  partialPlanRequired: (reason: string) => void;
  fromApiError: (
    error: CapabilityApiError,
    evidence?: CapabilityApiEvidence,
  ) => boolean;
}

export interface CapabilityApiError {
  status?: number;
  code?: string;
}

export interface CapabilityApiEvidence {
  /** The caller owns a feature-level endpoint where 404/405 means absence. */
  endpointAbsenceMeansNotConfigured?: boolean;
  /** Partial evidence must never block unrelated tasks in the destination. */
  impact?: "destination" | "partial";
}

function applyEvidenceImpact(
  state: "not-configured" | "plan-required",
  evidence: CapabilityApiEvidence,
): CapabilityObservationState {
  if (evidence.impact !== "partial") return state;
  return state === "plan-required"
    ? "partial-plan-required"
    : "partial-not-configured";
}

export function capabilityStateFromApiError(
  error: CapabilityApiError,
  evidence: CapabilityApiEvidence = {},
): CapabilityObservationState | null {
  const code = (error.code ?? "").toLowerCase();
  if (
    error.status === 402 ||
    code === "plan_required" ||
    code === "upgrade_required" ||
    code === "entitlement_required"
  ) {
    return applyEvidenceImpact("plan-required", evidence);
  }
  if (
    code === "not_configured" ||
    code === "provider_not_configured" ||
    code === "capability_unavailable" ||
    (evidence.endpointAbsenceMeansNotConfigured === true &&
      (error.status === 404 || error.status === 405))
  ) {
    return applyEvidenceImpact("not-configured", evidence);
  }
  return null;
}

/**
 * Runtime endpoints remain authoritative for tenant/provider/plan state.  A
 * page reports only explicit server evidence; transient network and 5xx
 * failures never become an entitlement claim.
 */
function defaultObservationReason(state: CapabilityObservationState): string {
  switch (state) {
    case "plan-required":
      return "Your current plan does not include this capability. Existing data has not been changed.";
    case "not-configured":
      return "This deployment has not configured the required provider or service.";
    case "partial-plan-required":
      return "Part of this destination requires a plan entitlement. Other reviewed tasks remain available.";
    case "partial-not-configured":
      return "Part of this destination requires provider or service setup. Other reviewed tasks remain available.";
    case "available":
    default:
      return "";
  }
}

export function useCapabilityReporter(
  section: Section,
  owner = DEFAULT_OWNER,
): CapabilityReporter {
  const me = useMe();
  const scope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const available = useCallback(
    () =>
      reportCapabilityObservation(scope, section, "available", "", owner),
    [owner, scope, section],
  );
  const report = useCallback(
    (state: CapabilityObservationState, reason: string) =>
      reportCapabilityObservation(scope, section, state, reason, owner),
    [owner, scope, section],
  );
  const notConfigured = useCallback(
    (reason: string) => report("not-configured", reason),
    [report],
  );
  const planRequired = useCallback(
    (reason: string) => report("plan-required", reason),
    [report],
  );
  const partialNotConfigured = useCallback(
    (reason: string) => report("partial-not-configured", reason),
    [report],
  );
  const partialPlanRequired = useCallback(
    (reason: string) => report("partial-plan-required", reason),
    [report],
  );
  const fromApiError = useCallback(
    (
      error: CapabilityApiError,
      evidence: CapabilityApiEvidence = {},
    ): boolean => {
      const state = capabilityStateFromApiError(error, evidence);
      if (!state) return false;
      report(state, defaultObservationReason(state));
      return true;
    },
    [report],
  );

  return {
    available,
    notConfigured,
    planRequired,
    partialNotConfigured,
    partialPlanRequired,
    fromApiError,
  };
}

export function resetCapabilityObservationsForTests(): void {
  observations.clear();
  scopeRevisions.clear();
  for (const key of listeners.keys()) emit(key);
  for (const scopeSet of scopeListeners.values()) {
    for (const listener of scopeSet) listener();
  }
}
