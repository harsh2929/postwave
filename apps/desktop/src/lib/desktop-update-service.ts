/**
 * Process-wide desktop update state machine.
 *
 * The native scheduler is independent of React. This singleton therefore
 * installs its event listeners before renderer credential hydration, performs
 * a listener-first snapshot handshake with Rust, and exposes one external
 * store to every presentation surface. Availability and restart-required state
 * are persisted; transient checking/download states are never mistaken for a
 * completed operation after a crash.
 */

import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import {
  isTauri,
  tauriApi,
  type NativeUpdateStateSnapshot,
  type UpdateCheckResult,
  type UpdateCheckSource,
  type UpdateSeverity,
} from "./tauri";
import {
  inspectLifecycle,
  prepareLifecycle,
  registerLifecycleGuard,
  type LifecycleIntent,
} from "./lifecycle-coordinator";

const STORAGE_KEY = "postwave.desktop.update-state.v1";
const STORAGE_VERSION = 1 as const;
const MAX_RELEASE_NOTES_CHARS = 16 * 1024;
const MAX_ERROR_CHARS = 512;
const MAX_VERSION_CHARS = 128;
const MAX_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "not_configured"
  | "available"
  | "downloading"
  | "installing"
  | "ready_to_restart"
  | "error";

export type UpdateOperation = "check" | "install";

export interface UpdateRestartConcern {
  guardId: string;
  label: string;
  detail?: string;
  /** Blocking work must finish; warnings can be explicitly overridden. */
  level: "warning" | "blocking";
}

export interface UpdateRestartDecision {
  status: "scanning" | "ready";
  concerns: UpdateRestartConcern[];
}

export interface DesktopUpdateState {
  initialized: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  severity: UpdateSeverity;
  releaseNotes: string | null;
  publishedAt: string | null;
  lastCheckedAt: number | null;
  checkSource: UpdateCheckSource | null;
  error: string | null;
  lastFailedOperation: UpdateOperation | null;
  downloadedBytes: number;
  totalBytes: number | null;
  snoozedUntil: number | null;
  lastPromptedVersion: string | null;
  lastPromptedAt: number | null;
  restartDecision: UpdateRestartDecision | null;
  restarting: boolean;
}

interface PersistedUpdateState {
  version: typeof STORAGE_VERSION;
  phase: Exclude<
    DesktopUpdatePhase,
    "idle" | "checking" | "downloading" | "installing"
  >;
  currentVersion: string;
  latestVersion: string | null;
  severity: UpdateSeverity;
  releaseNotes: string | null;
  publishedAt: string | null;
  lastCheckedAt: number | null;
  checkSource: UpdateCheckSource | null;
  error: string | null;
  lastFailedOperation: UpdateOperation | null;
  snoozedUntil: number | null;
  lastPromptedVersion: string | null;
  lastPromptedAt: number | null;
}

export interface UpdateRestartGuard {
  /** Stable owner id, e.g. `campaign-editor` or `migration-upload`. */
  id: string;
  label: string;
  /** Return null when restart is safe for this owner. */
  inspect: () =>
    | Omit<UpdateRestartConcern, "guardId" | "label">
    | null
    | Promise<Omit<UpdateRestartConcern, "guardId" | "label"> | null>;
  /** Flush durable state immediately before the native restart. */
  prepare?: () => void | Promise<void>;
}

const INITIAL_STATE: DesktopUpdateState = {
  initialized: false,
  phase: "idle",
  currentVersion: "",
  latestVersion: null,
  severity: "recommended",
  releaseNotes: null,
  publishedAt: null,
  lastCheckedAt: null,
  checkSource: null,
  error: null,
  lastFailedOperation: null,
  downloadedBytes: 0,
  totalBytes: null,
  snoozedUntil: null,
  lastPromptedVersion: null,
  lastPromptedAt: null,
  restartDecision: null,
  restarting: false,
};

const subscribers = new Set<() => void>();
const updateGuardDisposers = new Set<() => void>();
let state: DesktopUpdateState = INITIAL_STATE;
let storageHydrated = false;
let initializePromise: Promise<void> | null = null;
let activeOperation: Promise<void> | null = null;
let nativeUnlisteners: Array<() => void> = [];
let reminderTimer: number | null = null;
let initializeRetryTimer: number | null = null;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function setState(
  patch:
    | Partial<DesktopUpdateState>
    | ((current: DesktopUpdateState) => Partial<DesktopUpdateState>),
  persist = true,
): void {
  const nextPatch = typeof patch === "function" ? patch(state) : patch;
  const next = { ...state, ...nextPatch };
  if (shallowEqual(state, next)) return;
  state = next;
  if (persist) persistState();
  scheduleReminderWakeup();
  notify();
}

function shallowEqual(a: DesktopUpdateState, b: DesktopUpdateState): boolean {
  for (const key of Object.keys(a) as Array<keyof DesktopUpdateState>) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function getDesktopUpdateState(): DesktopUpdateState {
  ensureStorageHydrated();
  return state;
}

export function useDesktopUpdateState(): DesktopUpdateState {
  return useSyncExternalStore(
    subscribe,
    getDesktopUpdateState,
    getDesktopUpdateState,
  );
}

function ensureStorageHydrated(): void {
  if (storageHydrated) return;
  storageHydrated = true;
  const restored = readPersistedState();
  if (restored) state = { ...INITIAL_STATE, ...restored };
  scheduleReminderWakeup();
}

function readPersistedState(): Partial<DesktopUpdateState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) return null;

    const persistedPhase = validPersistedPhase(parsed.phase)
      ? parsed.phase
      : "error";
    return {
      phase: persistedPhase,
      currentVersion:
        boundedString(parsed.currentVersion, MAX_VERSION_CHARS) ?? "",
      latestVersion: boundedString(parsed.latestVersion, MAX_VERSION_CHARS),
      severity: validSeverity(parsed.severity)
        ? parsed.severity
        : "recommended",
      releaseNotes: boundedString(parsed.releaseNotes, MAX_RELEASE_NOTES_CHARS),
      publishedAt: boundedString(parsed.publishedAt, 128),
      lastCheckedAt: validPersistedTimestamp(
        parsed.lastCheckedAt,
        5 * 60 * 1000,
      ),
      checkSource: validSource(parsed.checkSource) ? parsed.checkSource : null,
      error: boundedString(parsed.error, MAX_ERROR_CHARS),
      lastFailedOperation: validOperation(parsed.lastFailedOperation)
        ? parsed.lastFailedOperation
        : null,
      snoozedUntil: validPersistedTimestamp(
        parsed.snoozedUntil,
        MAX_REMINDER_MS,
      ),
      lastPromptedVersion: boundedString(
        parsed.lastPromptedVersion,
        MAX_VERSION_CHARS,
      ),
      lastPromptedAt: validPersistedTimestamp(
        parsed.lastPromptedAt,
        5 * 60 * 1000,
      ),
    };
  } catch {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage is optional; the native retained snapshot still closes races.
    }
    return null;
  }
}

function persistState(): void {
  if (!storageHydrated || typeof window === "undefined") return;
  const stablePhase: PersistedUpdateState["phase"] =
    state.phase === "checking" ||
    state.phase === "downloading" ||
    state.phase === "installing" ||
    state.phase === "idle"
      ? "error"
      : state.phase;
  const error =
    stablePhase === "error" && !state.error
      ? "The previous update operation was interrupted. Retry when ready."
      : state.error;
  const persisted: PersistedUpdateState = {
    version: STORAGE_VERSION,
    phase: stablePhase,
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    severity: state.severity,
    releaseNotes: state.releaseNotes,
    publishedAt: state.publishedAt,
    lastCheckedAt: state.lastCheckedAt,
    checkSource: state.checkSource,
    error,
    lastFailedOperation: state.lastFailedOperation,
    snoozedUntil: state.snoozedUntil,
    lastPromptedVersion: state.lastPromptedVersion,
    lastPromptedAt: state.lastPromptedAt,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // The in-memory/native state remains truthful when web storage is denied.
  }
}

/**
 * Start before credential hydration. Event listeners are installed before the
 * Rust snapshot is requested, so neither side has a check/listen race.
 */
export function initializeDesktopUpdateService(): Promise<void> {
  ensureStorageHydrated();
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (!isTauri()) {
      setState((current) => ({
        initialized: true,
        phase: current.phase === "idle" ? "not_configured" : current.phase,
      }));
      return;
    }

    const updateUnlisten = await listen<NativeUpdateStateSnapshot>(
      "updater:state",
      (event) => applyNativeSnapshot(event.payload),
    );
    nativeUnlisteners.push(updateUnlisten);
    const progressUnlisten = await listen<{
      downloaded?: number;
      total?: number | null;
    }>("updater:download-progress", (event) => {
      applyDownloadProgress(event.payload);
    });
    nativeUnlisteners.push(progressUnlisten);

    const [snapshot, appVersion] = await Promise.all([
      tauriApi.getUpdateState(),
      tauriApi.getAppVersion(),
    ]);
    reconcileInstalledVersion(appVersion?.version ?? "");
    if (snapshot) applyNativeSnapshot(snapshot);
    clearInitializeRetry();
    setState({ initialized: true });
  })().catch((error: unknown) => {
    disposeNativeListeners();
    initializePromise = null;
    setState({
      initialized: true,
      phase: state.phase === "idle" ? "error" : state.phase,
      error: describeError(error, "Couldn't initialize desktop updates"),
      lastFailedOperation: "check",
    });
    scheduleInitializeRetry();
  });
  return initializePromise;
}

function reconcileInstalledVersion(currentVersion: string): void {
  const current = boundedString(currentVersion, MAX_VERSION_CHARS) ?? "";
  if (!current) return;
  if (
    state.phase === "ready_to_restart" &&
    state.latestVersion &&
    isSameOrNewerVersion(current, state.latestVersion)
  ) {
    setState({
      phase: "up_to_date",
      currentVersion: current,
      latestVersion: null,
      releaseNotes: null,
      publishedAt: null,
      error: null,
      lastFailedOperation: null,
      snoozedUntil: null,
    });
    return;
  }
  setState({ currentVersion: current });
}

function applyNativeSnapshot(snapshot: unknown): void {
  if (!isNativeSnapshot(snapshot)) return;
  if (
    state.lastCheckedAt !== null &&
    snapshot.checked_at_ms < state.lastCheckedAt
  ) {
    return;
  }
  if (snapshot.result) {
    applyCheckResult(snapshot.result);
    return;
  }

  const error = boundedString(snapshot.error, MAX_ERROR_CHARS);
  if (!error) return;
  // A failed background refresh must not erase an already verified update or
  // restart-required state. Keep the actionable result and label it stale.
  if (
    state.phase === "available" ||
    state.phase === "ready_to_restart" ||
    state.phase === "downloading" ||
    state.phase === "installing"
  ) {
    setState({
      error,
      lastCheckedAt: snapshot.checked_at_ms,
      checkSource: snapshot.source,
      lastFailedOperation: "check",
    });
  } else {
    setState({
      phase: "error",
      error,
      lastCheckedAt: snapshot.checked_at_ms,
      checkSource: snapshot.source,
      lastFailedOperation: "check",
    });
  }
}

function applyCheckResult(result: UpdateCheckResult): void {
  if (!isUpdateCheckResult(result)) return;
  const common = {
    initialized: true,
    currentVersion: result.current_version,
    lastCheckedAt: result.checked_at_ms,
    checkSource: result.source,
    error: null,
    lastFailedOperation: null,
    downloadedBytes: 0,
    totalBytes: null,
  } satisfies Partial<DesktopUpdateState>;

  if (result.status === "available" && result.latest_version) {
    const sameVersion = state.latestVersion === result.latest_version;
    setState({
      ...common,
      phase:
        state.phase === "ready_to_restart" && sameVersion
          ? "ready_to_restart"
          : "available",
      latestVersion: result.latest_version,
      severity: result.severity,
      releaseNotes: result.notes,
      publishedAt: result.published_at,
      snoozedUntil: sameVersion ? state.snoozedUntil : null,
      lastPromptedVersion: sameVersion ? state.lastPromptedVersion : null,
      lastPromptedAt: sameVersion ? state.lastPromptedAt : null,
    });
    return;
  }
  if (state.phase === "ready_to_restart") {
    // Installing can change what the updater endpoint reports while the old
    // process is still alive. Only a real app-version change clears restart.
    setState(common);
    return;
  }
  setState({
    ...common,
    phase: result.status,
    latestVersion: null,
    releaseNotes: null,
    publishedAt: null,
    severity: "recommended",
    snoozedUntil: null,
  });
}

function applyDownloadProgress(payload: unknown): void {
  if (!isRecord(payload)) return;
  const downloaded = finiteNonNegative(payload.downloaded) ?? 0;
  const total = finitePositive(payload.total);
  setState({
    phase: total !== null && downloaded >= total ? "installing" : "downloading",
    downloadedBytes: downloaded,
    totalBytes: total,
  });
}

export function checkForDesktopUpdate(): Promise<void> {
  if (activeOperation) return activeOperation;
  activeOperation = (async () => {
    await initializeDesktopUpdateService();
    const priorActionablePhase =
      state.phase === "available" || state.phase === "ready_to_restart"
        ? state.phase
        : null;
    setState({
      phase: "checking",
      error: null,
      // Persisted as the recovery action if this process exits mid-check.
      lastFailedOperation: "check",
      downloadedBytes: 0,
      totalBytes: null,
    });
    try {
      applyCheckResult(await tauriApi.checkForUpdates());
    } catch (error) {
      setState({
        phase: priorActionablePhase ?? "error",
        error: describeError(error, "Update check failed"),
        lastCheckedAt: Date.now(),
        checkSource: "manual",
        lastFailedOperation: "check",
      });
    }
  })().finally(() => {
    activeOperation = null;
  });
  return activeOperation;
}

export function installDesktopUpdate(): Promise<void> {
  if (activeOperation) return activeOperation;
  activeOperation = (async () => {
    await initializeDesktopUpdateService();
    setState({
      phase: "downloading",
      error: null,
      // Persisted as the recovery action if download/install is interrupted.
      lastFailedOperation: "install",
      downloadedBytes: 0,
      totalBytes: null,
      snoozedUntil: null,
    });
    try {
      const result = await tauriApi.installUpdate();
      if (result.status === "installed") {
        setState({
          phase: "ready_to_restart",
          latestVersion: result.version ?? state.latestVersion,
          error: null,
          lastFailedOperation: null,
          downloadedBytes: state.totalBytes ?? state.downloadedBytes,
          lastPromptedVersion: null,
          lastPromptedAt: null,
        });
      } else if (result.status === "up_to_date") {
        setState({
          phase: "up_to_date",
          latestVersion: null,
          releaseNotes: null,
          publishedAt: null,
          error: null,
          lastFailedOperation: null,
        });
      } else {
        setState({
          phase: "not_configured",
          error: null,
          lastFailedOperation: null,
        });
      }
    } catch (error) {
      setState({
        phase: "error",
        error: describeError(error, "Update installation failed"),
        lastFailedOperation: "install",
      });
    }
  })().finally(() => {
    activeOperation = null;
  });
  return activeOperation;
}

export function retryDesktopUpdate(): Promise<void> {
  return state.lastFailedOperation === "install" && state.latestVersion
    ? installDesktopUpdate()
    : checkForDesktopUpdate();
}

export function deferDesktopUpdate(milliseconds: number): void {
  const delay = Math.min(
    Math.max(Math.round(milliseconds), 60_000),
    MAX_REMINDER_MS,
  );
  setState({
    snoozedUntil: Date.now() + delay,
    restartDecision: null,
    lastPromptedVersion: null,
    lastPromptedAt: null,
  });
}

export function clearDesktopUpdateReminder(): void {
  setState({
    snoozedUntil: null,
    lastPromptedVersion: null,
    lastPromptedAt: null,
  });
}

export function isDesktopUpdateAttentionDue(
  snapshot: DesktopUpdateState = getDesktopUpdateState(),
  now = Date.now(),
): boolean {
  if (snapshot.phase !== "available" && snapshot.phase !== "ready_to_restart") {
    return false;
  }
  return snapshot.snoozedUntil === null || snapshot.snoozedUntil <= now;
}

export function shouldPromptForDesktopUpdate(
  snapshot: DesktopUpdateState = getDesktopUpdateState(),
  now = Date.now(),
): boolean {
  if (!isDesktopUpdateAttentionDue(snapshot, now) || !snapshot.latestVersion) {
    return false;
  }
  if (snapshot.lastPromptedVersion !== snapshot.latestVersion) return true;
  const repeatAfter =
    snapshot.severity === "critical" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return (
    snapshot.lastPromptedAt === null ||
    now - snapshot.lastPromptedAt >= repeatAfter
  );
}

export function markDesktopUpdatePrompted(now = Date.now()): void {
  if (!state.latestVersion) return;
  setState({
    lastPromptedVersion: state.latestVersion,
    lastPromptedAt: now,
  });
}

/** Atomically reserve the global prompt so StrictMode/remounts cannot toast twice. */
export function claimDesktopUpdatePrompt(now = Date.now()): boolean {
  if (!shouldPromptForDesktopUpdate(state, now)) return false;
  markDesktopUpdatePrompted(now);
  return true;
}

/**
 * Register draft/upload/job safety with the global update restart decision.
 * Probes run only when the operator clicks Restart; probe failures fail closed.
 */
export function registerUpdateRestartGuard(
  guard: UpdateRestartGuard,
): () => void {
  const unregister = registerLifecycleGuard({
    id: guard.id,
    label: guard.label,
    kinds: ["update-restart"],
    inspect: () => guard.inspect(),
    prepare: guard.prepare ? () => guard.prepare?.() : undefined,
  });
  const dispose = (): void => {
    unregister();
    updateGuardDisposers.delete(dispose);
  };
  updateGuardDisposers.add(dispose);
  return dispose;
}

const UPDATE_RESTART_INTENT: LifecycleIntent = {
  kind: "update-restart",
  disposition: "restart",
  title: "Restart Moosewave to finish the update?",
  description:
    "Moosewave checks registered drafts and active operations before relaunching.",
  confirmLabel: "Restart now",
};

export async function requestDesktopUpdateRestart(): Promise<void> {
  if (state.restarting || state.restartDecision?.status === "scanning") return;
  setState(
    {
      restartDecision: { status: "scanning", concerns: [] },
    },
    false,
  );
  const concerns = await collectRestartConcerns();
  setState({ restartDecision: { status: "ready", concerns } }, false);
}

async function collectRestartConcerns(): Promise<UpdateRestartConcern[]> {
  return (await inspectLifecycle(UPDATE_RESTART_INTENT)).map((concern) => ({
    guardId: concern.guardId,
    label: concern.label,
    detail: concern.detail,
    level: concern.level,
  }));
}

export function closeDesktopUpdateRestartDecision(): void {
  if (state.restarting) return;
  setState({ restartDecision: null }, false);
}

export async function confirmDesktopUpdateRestart(): Promise<void> {
  const decision = state.restartDecision;
  if (!decision || decision.status !== "ready" || state.restarting) return;
  if (decision.concerns.some((concern) => concern.level === "blocking")) return;
  setState({ restarting: true }, false);
  try {
    // Close the time-of-check/time-of-use window. If work changed after the
    // dialog opened, require the operator to review the new report.
    const currentConcerns = await collectRestartConcerns();
    if (!sameRestartConcerns(decision.concerns, currentConcerns)) {
      setState(
        {
          restarting: false,
          restartDecision: { status: "ready", concerns: currentConcerns },
        },
        false,
      );
      return;
    }
    await prepareLifecycle(UPDATE_RESTART_INTENT);
    const postPrepareConcerns = await collectRestartConcerns();
    if (postPrepareConcerns.some((concern) => concern.level === "blocking")) {
      setState(
        {
          restarting: false,
          restartDecision: { status: "ready", concerns: postPrepareConcerns },
        },
        false,
      );
      return;
    }
    await tauriApi.restartApp();
  } catch (error) {
    setState({
      restarting: false,
      error: describeError(error, "Moosewave could not restart"),
      lastFailedOperation: "install",
      restartDecision: {
        status: "ready",
        concerns: [
          {
            guardId: "restart",
            label: "Restart preparation",
            detail: describeError(
              error,
              "Moosewave could not safely prepare to restart.",
            ),
            level: "blocking",
          },
        ],
      },
    });
  }
}

function sameRestartConcerns(
  left: UpdateRestartConcern[],
  right: UpdateRestartConcern[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((concern, index) => {
    const candidate = right[index];
    return (
      candidate?.guardId === concern.guardId &&
      candidate.label === concern.label &&
      candidate.detail === concern.detail &&
      candidate.level === concern.level
    );
  });
}

function scheduleReminderWakeup(): void {
  if (typeof window === "undefined") return;
  if (reminderTimer !== null) window.clearTimeout(reminderTimer);
  reminderTimer = null;
  if (state.snoozedUntil === null) return;
  const delay = state.snoozedUntil - Date.now();
  if (delay <= 0) return;
  reminderTimer = window.setTimeout(
    () => {
      reminderTimer = null;
      setState({ snoozedUntil: null });
    },
    Math.min(delay, 2_147_483_647),
  );
}

function isNativeSnapshot(value: unknown): value is NativeUpdateStateSnapshot {
  if (!isRecord(value)) return false;
  if (!validTimestamp(value.checked_at_ms) || !validSource(value.source))
    return false;
  return (
    (value.result === null || isUpdateCheckResult(value.result)) &&
    (value.error === null || typeof value.error === "string")
  );
}

function isUpdateCheckResult(value: unknown): value is UpdateCheckResult {
  if (!isRecord(value)) return false;
  return (
    (value.status === "not_configured" ||
      value.status === "up_to_date" ||
      value.status === "available") &&
    typeof value.available === "boolean" &&
    typeof value.current_version === "string" &&
    (value.latest_version === null ||
      typeof value.latest_version === "string") &&
    (value.notes === null || typeof value.notes === "string") &&
    validSeverity(value.severity) &&
    (value.published_at === null || typeof value.published_at === "string") &&
    validTimestamp(value.checked_at_ms) !== null &&
    validSource(value.source) &&
    (value.status !== "available" ||
      (value.available === true && typeof value.latest_version === "string"))
  );
}

function validPersistedPhase(
  value: unknown,
): value is PersistedUpdateState["phase"] {
  return (
    value === "up_to_date" ||
    value === "not_configured" ||
    value === "available" ||
    value === "ready_to_restart" ||
    value === "error"
  );
}

function validSeverity(value: unknown): value is UpdateSeverity {
  return (
    value === "informational" ||
    value === "recommended" ||
    value === "important" ||
    value === "critical"
  );
}

function validSource(value: unknown): value is UpdateCheckSource {
  return value === "manual" || value === "scheduled";
}

function validOperation(value: unknown): value is UpdateOperation {
  return value === "check" || value === "install";
}

function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function validPersistedTimestamp(
  value: unknown,
  maxFutureMs: number,
): number | null {
  const timestamp = validTimestamp(value);
  if (timestamp === null || timestamp > Date.now() + maxFutureMs) return null;
  return timestamp;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, maxChars).join("");
}

function describeError(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;
  return boundedString(message, MAX_ERROR_CHARS) ?? fallback;
}

function isSameOrNewerVersion(current: string, target: string): boolean {
  if (current === target) return true;
  const currentParts = numericVersionParts(current);
  const targetParts = numericVersionParts(target);
  if (!currentParts || !targetParts) return false;
  const length = Math.max(currentParts.length, targetParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const targetPart = targetParts[index] ?? 0;
    if (currentPart > targetPart) return true;
    if (currentPart < targetPart) return false;
  }
  return true;
}

function numericVersionParts(value: string): number[] | null {
  const core = value.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
  if (!core || !/^\d+(?:\.\d+)*$/.test(core)) return null;
  const parts = core.split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part)) ? parts : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Focused test reset; production code must never call this. */
export function resetDesktopUpdateServiceForTests(): void {
  disposeNativeListeners();
  clearInitializeRetry();
  if (reminderTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(reminderTimer);
  }
  reminderTimer = null;
  subscribers.clear();
  for (const dispose of [...updateGuardDisposers]) dispose();
  state = INITIAL_STATE;
  storageHydrated = false;
  initializePromise = null;
  activeOperation = null;
}

function disposeNativeListeners(): void {
  for (const unlisten of nativeUnlisteners) {
    try {
      unlisten();
    } catch {
      // Listener cleanup is best-effort during retry/test teardown.
    }
  }
  nativeUnlisteners = [];
}

function scheduleInitializeRetry(): void {
  if (typeof window === "undefined" || initializeRetryTimer !== null) return;
  initializeRetryTimer = window.setTimeout(() => {
    initializeRetryTimer = null;
    void initializeDesktopUpdateService();
  }, 5_000);
}

function clearInitializeRetry(): void {
  if (initializeRetryTimer === null || typeof window === "undefined") return;
  window.clearTimeout(initializeRetryTimer);
  initializeRetryTimer = null;
}
