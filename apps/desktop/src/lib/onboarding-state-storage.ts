import {
  CHECKLIST_STEPS,
  isKnownOnboardingStep,
  ONBOARDING_SURFACE_IDS,
  TOUR_STEPS,
  type ChecklistStepId,
  type OnboardingStepId,
  type OnboardingSurfaceId,
} from "./onboarding-manifest";
import {
  createOnboardingState,
  ONBOARDING_STATE_VERSION,
  type OnboardingGoalState,
  type OnboardingOutcome,
  type OnboardingState,
  type OnboardingSurfaceState,
} from "./onboarding-state-machine";
import type { Role } from "./store";

export interface OnboardingIdentity {
  workspaceId: string;
  userId: string;
  role: Role;
}

export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LoadedOnboardingState {
  state: OnboardingState;
  storageKey: string;
  migrated: boolean;
  corrupt: boolean;
  cleanupKeys: string[];
}

const STORAGE_PREFIX = `postwave.desktop.onboarding.v${ONBOARDING_STATE_VERSION}`;
const PREVIOUS_STORAGE_PREFIX = "postwave.desktop.onboarding.v2";
const MAX_STATE_BYTES = 32 * 1024;
const MAX_IDENTITY_CHARS = 512;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000;
const LEGACY_PROGRESS_CACHE_TTL_MS = 30 * 60_000;
const OUTCOMES: readonly OnboardingOutcome[] = [
  "not-started",
  "in-progress",
  "completed",
  "skipped",
  "dismissed",
];

const LEGACY_KEYS = {
  onboarded: "postwave_onboarded",
  wizardDismissed: "postwave_onboarding_dismissed_at",
  tourCompleted: "postwave_tour_dashboard_completed_at",
  tourDismissed: "postwave_tour_dashboard_dismissed_at",
  tourStep: "postwave_tour_dashboard_step",
  checklistDismissed: "postwave_onboarding_checklist_dismissed",
  checklistSkipPrefix: "postwave_onboarding_skipped_",
  progressCache: "postwave_onboarding_cache_v2",
} as const;

function hashPart(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Opaque scope token: identity values never appear in the key or payload. */
export function onboardingScopeToken(identity: OnboardingIdentity): string {
  const workspace = identity.workspaceId.slice(0, MAX_IDENTITY_CHARS);
  const user = identity.userId.slice(0, MAX_IDENTITY_CHARS);
  const input = `${workspace.length}:${workspace}|${user.length}:${user}`;
  return `${hashPart(input, 0x811c9dc5)}${hashPart(input, 0x9e3779b9)}`;
}

export function onboardingStorageKey(identity: OnboardingIdentity): string {
  return `${STORAGE_PREFIX}:${onboardingScopeToken(identity)}`;
}

function previousStorageKey(identity: OnboardingIdentity): string {
  return `${PREVIOUS_STORAGE_PREFIX}:${onboardingScopeToken(identity)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validTimestamp(value: unknown, now: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= now + MAX_FUTURE_SKEW_MS
  );
}

function validStepArray(
  surface: OnboardingSurfaceId,
  value: unknown,
): value is OnboardingStepId[] {
  if (!Array.isArray(value)) return false;
  if (value.length > 32 || new Set(value).size !== value.length) return false;
  return value.every(
    (stepId) =>
      typeof stepId === "string" && isKnownOnboardingStep(surface, stepId),
  );
}

function parseSurfaceState(
  surface: OnboardingSurfaceId,
  value: unknown,
  now: number,
): OnboardingSurfaceState | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "outcome",
      "currentStepId",
      "completedStepIds",
      "skippedStepIds",
      "run",
      "openedAt",
      "updatedAt",
    ]) ||
    !OUTCOMES.includes(value.outcome as OnboardingOutcome) ||
    !validStepArray(surface, value.completedStepIds) ||
    !validStepArray(surface, value.skippedStepIds) ||
    typeof value.run !== "number" ||
    !Number.isSafeInteger(value.run) ||
    value.run < 0 ||
    value.run > 1_000_000 ||
    !validTimestamp(value.updatedAt, now) ||
    (value.openedAt !== null && !validTimestamp(value.openedAt, now))
  ) {
    return null;
  }
  const currentStepId = value.currentStepId;
  if (
    currentStepId !== null &&
    (typeof currentStepId !== "string" ||
      !isKnownOnboardingStep(surface, currentStepId))
  ) {
    return null;
  }
  if (
    (value.outcome === "in-progress" && currentStepId === null) ||
    (value.outcome !== "in-progress" && currentStepId !== null)
  ) {
    return null;
  }
  const completedStepIds = value.completedStepIds as OnboardingStepId[];
  const skippedStepIds = value.skippedStepIds as OnboardingStepId[];
  const overlap = completedStepIds.some((id) => skippedStepIds.includes(id));
  if (overlap) return null;
  return {
    outcome: value.outcome as OnboardingOutcome,
    currentStepId,
    completedStepIds: [...completedStepIds],
    skippedStepIds: [...skippedStepIds],
    run: value.run,
    openedAt: value.openedAt,
    updatedAt: value.updatedAt,
  };
}

function parseGoalState(value: unknown, now: number): OnboardingGoalState | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["completedStepIds", "fetchedAt", "updatedAt"]) ||
    !Array.isArray(value.completedStepIds) ||
    value.completedStepIds.length > CHECKLIST_STEPS.length ||
    new Set(value.completedStepIds).size !== value.completedStepIds.length ||
    !value.completedStepIds.every(
      (id) =>
        typeof id === "string" &&
        CHECKLIST_STEPS.some((step) => step.id === id),
    ) ||
    (value.fetchedAt !== null && !validTimestamp(value.fetchedAt, now)) ||
    !validTimestamp(value.updatedAt, now)
  ) {
    return null;
  }
  return {
    completedStepIds: [...value.completedStepIds] as ChecklistStepId[],
    fetchedAt: value.fetchedAt,
    updatedAt: value.updatedAt,
  };
}

function safeParse(raw: string): unknown {
  if (raw.length === 0 || new TextEncoder().encode(raw).byteLength > MAX_STATE_BYTES) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseOnboardingState(
  raw: string,
  expectedScopeToken: string,
  now = Date.now(),
): OnboardingState | null {
  const value = safeParse(raw);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "scopeToken",
      "revision",
      "updatedAt",
      "surfaces",
      "goals",
    ]) ||
    value.version !== ONBOARDING_STATE_VERSION ||
    value.scopeToken !== expectedScopeToken ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !validTimestamp(value.updatedAt, now) ||
    !isRecord(value.surfaces) ||
    !hasOnlyKeys(value.surfaces, ONBOARDING_SURFACE_IDS)
  ) {
    return null;
  }
  const surfaces = {} as Record<OnboardingSurfaceId, OnboardingSurfaceState>;
  for (const surface of ONBOARDING_SURFACE_IDS) {
    const parsed = parseSurfaceState(surface, value.surfaces[surface], now);
    if (!parsed) return null;
    surfaces[surface] = parsed;
  }
  const goals = parseGoalState(value.goals, now);
  if (!goals) return null;
  return {
    version: ONBOARDING_STATE_VERSION,
    scopeToken: expectedScopeToken,
    revision: value.revision,
    updatedAt: value.updatedAt,
    surfaces,
    goals,
  };
}

export function serializeOnboardingState(state: OnboardingState): string {
  return JSON.stringify(state);
}

function safeGet(storage: OnboardingStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function cloneSurface(state: OnboardingSurfaceState): OnboardingSurfaceState {
  return {
    ...state,
    completedStepIds: [...state.completedStepIds],
    skippedStepIds: [...state.skippedStepIds],
  };
}

export function mergeOnboardingStates(
  local: OnboardingState,
  incoming: OnboardingState,
): OnboardingState {
  if (local.scopeToken !== incoming.scopeToken) return local;
  const incomingWinsTie =
    serializeOnboardingState(incoming) > serializeOnboardingState(local);
  const preferIncoming =
    incoming.updatedAt > local.updatedAt ||
    (incoming.updatedAt === local.updatedAt &&
      (incoming.revision > local.revision ||
        (incoming.revision === local.revision && incomingWinsTie)));
  const surfaces = {} as Record<OnboardingSurfaceId, OnboardingSurfaceState>;
  for (const surface of ONBOARDING_SURFACE_IDS) {
    const left = local.surfaces[surface];
    const right = incoming.surfaces[surface];
    const chosen =
      right.updatedAt > left.updatedAt ||
      (right.updatedAt === left.updatedAt &&
        (preferIncoming || JSON.stringify(right) > JSON.stringify(left)))
        ? right
        : left;
    surfaces[surface] = cloneSurface(chosen);
  }
  const goals =
    incoming.goals.updatedAt > local.goals.updatedAt ||
    (incoming.goals.updatedAt === local.goals.updatedAt && preferIncoming)
      ? incoming.goals
      : local.goals;
  return {
    version: ONBOARDING_STATE_VERSION,
    scopeToken: local.scopeToken,
    revision: Math.max(local.revision, incoming.revision),
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
    surfaces,
    goals: {
      ...goals,
      completedStepIds: [...goals.completedStepIds],
    },
  };
}

function setLegacySurface(
  state: OnboardingState,
  surface: OnboardingSurfaceId,
  patch: Partial<OnboardingSurfaceState>,
  now: number,
): void {
  state.surfaces[surface] = {
    ...state.surfaces[surface],
    ...patch,
    updatedAt: now,
  };
  state.updatedAt = now;
  state.revision += 1;
}

function migratePreviousEnvelope(
  raw: string | null,
  scopeToken: string,
  now: number,
): OnboardingState | null {
  if (!raw) return null;
  const value = safeParse(raw);
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.scopeToken !== scopeToken ||
    !isRecord(value.surfaces)
  ) {
    return null;
  }
  const state = createOnboardingState(scopeToken);
  for (const surface of ONBOARDING_SURFACE_IDS) {
    const legacy = value.surfaces[surface];
    if (!isRecord(legacy)) continue;
    const outcome = OUTCOMES.includes(legacy.status as OnboardingOutcome)
      ? (legacy.status as OnboardingOutcome)
      : "not-started";
    const step =
      typeof legacy.step === "string" &&
      isKnownOnboardingStep(surface, legacy.step)
        ? legacy.step
        : null;
    const normalizedOutcome =
      outcome === "in-progress" && step === null ? "not-started" : outcome;
    const completed = Array.isArray(legacy.completedSteps)
      ? legacy.completedSteps.filter(
          (id): id is OnboardingStepId =>
            typeof id === "string" && isKnownOnboardingStep(surface, id),
        )
      : [];
    const skipped = Array.isArray(legacy.skippedSteps)
      ? legacy.skippedSteps.filter(
          (id): id is OnboardingStepId =>
            typeof id === "string" &&
            isKnownOnboardingStep(surface, id) &&
            !completed.includes(id),
        )
      : [];
    if (
      normalizedOutcome !== "not-started" ||
      step ||
      completed.length ||
      skipped.length
    ) {
      setLegacySurface(
        state,
        surface,
        {
          outcome: normalizedOutcome,
          currentStepId: normalizedOutcome === "in-progress" ? step : null,
          completedStepIds: [...new Set(completed)],
          skippedStepIds: [...new Set(skipped)],
          run: normalizedOutcome === "not-started" ? 0 : 1,
          openedAt: normalizedOutcome === "in-progress" ? now : null,
        },
        now,
      );
    }
  }
  return state.updatedAt > 0 ? state : null;
}

function readLegacyChecklistSkips(
  storage: OnboardingStorage,
  cleanupKeys: string[],
): ChecklistStepId[] {
  const skipped: ChecklistStepId[] = [];
  for (const step of CHECKLIST_STEPS) {
    const key = `${LEGACY_KEYS.checklistSkipPrefix}${step.id}`;
    if (safeGet(storage, key) === "1") skipped.push(step.id);
    cleanupKeys.push(key);
  }
  return skipped;
}

function readLegacyGoalCache(
  storage: OnboardingStorage,
  identity: OnboardingIdentity,
  cleanupKeys: string[],
  now: number,
): ChecklistStepId[] {
  const keys = [
    `${LEGACY_KEYS.progressCache}:${identity.workspaceId}`,
    LEGACY_KEYS.progressCache,
  ];
  cleanupKeys.push(...keys);
  for (const key of keys) {
    const raw = safeGet(storage, key);
    if (!raw) continue;
    const parsed = safeParse(raw);
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.flags) ||
      typeof parsed.at !== "number" ||
      !Number.isSafeInteger(parsed.at) ||
      parsed.at > now + MAX_FUTURE_SKEW_MS ||
      now - parsed.at > LEGACY_PROGRESS_CACHE_TTL_MS
    ) {
      continue;
    }
    const mapping: Readonly<Record<string, ChecklistStepId>> = {
      domain: "verify-domain",
      subscribers: "import-subscribers",
      campaign: "send-first-campaign",
      events: "connect-events",
      deliverability: "harden-deliverability",
    };
    const flags = parsed.flags;
    return Object.entries(mapping)
      .filter(([flag]) => flags[flag] === true)
      .map(([, stepId]) => stepId);
  }
  return [];
}

function migrateLegacyKeys(
  storage: OnboardingStorage,
  identity: OnboardingIdentity,
  scopeToken: string,
  now: number,
): { state: OnboardingState; cleanupKeys: string[]; migrated: boolean } {
  const state = createOnboardingState(scopeToken);
  const cleanupKeys = [
    LEGACY_KEYS.onboarded,
    LEGACY_KEYS.wizardDismissed,
    `${LEGACY_KEYS.wizardDismissed}:${identity.workspaceId}`,
    LEGACY_KEYS.tourCompleted,
    LEGACY_KEYS.tourDismissed,
    LEGACY_KEYS.tourStep,
    LEGACY_KEYS.checklistDismissed,
  ];
  const wizardScoped = safeGet(
    storage,
    `${LEGACY_KEYS.wizardDismissed}:${identity.workspaceId}`,
  );
  const wizardGlobal = safeGet(storage, LEGACY_KEYS.wizardDismissed);
  if (wizardScoped || wizardGlobal) {
    setLegacySurface(state, "wizard", { outcome: "dismissed" }, now);
  } else if (safeGet(storage, LEGACY_KEYS.onboarded) === "1") {
    setLegacySurface(state, "wizard", { outcome: "completed" }, now);
  }

  if (safeGet(storage, LEGACY_KEYS.tourCompleted)) {
    setLegacySurface(state, "tour", { outcome: "completed" }, now);
  } else if (safeGet(storage, LEGACY_KEYS.tourDismissed)) {
    setLegacySurface(state, "tour", { outcome: "dismissed" }, now);
  } else {
    const index = Number.parseInt(safeGet(storage, LEGACY_KEYS.tourStep) ?? "", 10);
    const stepId = Number.isSafeInteger(index) ? TOUR_STEPS[index]?.id : undefined;
    if (stepId) {
      setLegacySurface(
        state,
        "tour",
        { outcome: "in-progress", currentStepId: stepId, run: 1, openedAt: now },
        now,
      );
    }
  }

  const skipped = readLegacyChecklistSkips(storage, cleanupKeys);
  const checklistDismissed =
    safeGet(storage, LEGACY_KEYS.checklistDismissed) === "1";
  if (checklistDismissed || skipped.length > 0) {
    const firstUnskipped = CHECKLIST_STEPS.find(
      (step) => !skipped.includes(step.id),
    )?.id;
    setLegacySurface(
      state,
      "checklist",
      {
        outcome: checklistDismissed
          ? "dismissed"
          : firstUnskipped
            ? "in-progress"
            : "skipped",
        currentStepId:
          !checklistDismissed && firstUnskipped ? firstUnskipped : null,
        run: checklistDismissed ? 0 : 1,
        openedAt:
          !checklistDismissed && firstUnskipped ? now : null,
        skippedStepIds: skipped,
      },
      now,
    );
  }

  const completedGoals = readLegacyGoalCache(
    storage,
    identity,
    cleanupKeys,
    now,
  );
  if (completedGoals.length > 0) {
    state.goals = {
      completedStepIds: completedGoals,
      fetchedAt: now,
      updatedAt: now,
    };
    state.surfaces.checklist.completedStepIds = completedGoals;
    if (state.surfaces.checklist.outcome === "in-progress") {
      const unresolved = CHECKLIST_STEPS.find(
        (step) =>
          !completedGoals.includes(step.id) && !skipped.includes(step.id),
      )?.id;
      state.surfaces.checklist.currentStepId = unresolved ?? null;
      if (!unresolved) {
        state.surfaces.checklist.outcome =
          completedGoals.length === CHECKLIST_STEPS.length
            ? "completed"
            : "skipped";
        state.surfaces.checklist.openedAt = null;
      }
    }
    if (
      completedGoals.length === CHECKLIST_STEPS.length &&
      state.surfaces.checklist.outcome !== "dismissed"
    ) {
      state.surfaces.checklist.outcome = "completed";
      state.surfaces.checklist.currentStepId = null;
      state.surfaces.checklist.openedAt = null;
    }
    state.updatedAt = now;
    state.revision += 1;
  }
  return {
    state,
    cleanupKeys: [...new Set(cleanupKeys)],
    migrated:
      state.updatedAt > 0 ||
      cleanupKeys.some((key) => safeGet(storage, key) !== null),
  };
}

export function loadOnboardingState(
  storage: OnboardingStorage,
  identity: OnboardingIdentity,
  now = Date.now(),
): LoadedOnboardingState {
  const scopeToken = onboardingScopeToken(identity);
  const storageKey = onboardingStorageKey(identity);
  const currentRaw = safeGet(storage, storageKey);
  if (currentRaw) {
    const current = parseOnboardingState(currentRaw, scopeToken, now);
    return {
      state: current ?? createOnboardingState(scopeToken),
      storageKey,
      migrated: false,
      corrupt: current == null,
      cleanupKeys: current == null ? [storageKey] : [],
    };
  }

  const v2Key = previousStorageKey(identity);
  const previousRaw = safeGet(storage, v2Key);
  const previous = migratePreviousEnvelope(previousRaw, scopeToken, now);
  if (previous) {
    return {
      state: previous,
      storageKey,
      migrated: true,
      corrupt: false,
      cleanupKeys: [v2Key],
    };
  }
  if (previousRaw) {
    return {
      state: createOnboardingState(scopeToken),
      storageKey,
      migrated: true,
      corrupt: true,
      cleanupKeys: [v2Key],
    };
  }

  const legacy = migrateLegacyKeys(storage, identity, scopeToken, now);
  return {
    state: legacy.state,
    storageKey,
    migrated: legacy.migrated,
    corrupt: false,
    cleanupKeys: legacy.cleanupKeys,
  };
}
