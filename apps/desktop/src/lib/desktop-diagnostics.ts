/**
 * Process-wide crash diagnostics and recovery contract for Moosewave Desktop.
 *
 * Privacy is enforced by construction: renderer errors are reduced to a
 * structural type/code/component trace before they cross IPC or enter local
 * storage. Raw messages, stacks, routes, workspace names, request payloads,
 * credentials, and user-entered content are never written to the diagnostic
 * journal or copied into a support report.
 */

import { captureException } from "./sentry";
import { tauriApi, type NativeCrashRecord } from "./tauri";

export type DesktopIncidentKind =
  | "renderer_boundary"
  | "window_error"
  | "unhandled_rejection"
  | "bootstrap_failure";

export interface DesktopIncident {
  incidentId: string;
  occurredAtMs: number;
  kind: DesktopIncidentKind;
  errorType: string;
  errorCode: string | null;
  componentTrace: string[];
}

export interface DesktopDiagnosticsState {
  initialized: boolean;
  safeMode: boolean;
  safeModeReason: "manual" | "crash_loop" | null;
  nativeCrash: NativeCrashRecord | null;
}

interface StoredSafeModeRequest {
  requestedAtMs: number;
  reason: "manual" | "crash_loop";
}

interface StoredRendererEvent extends DesktopIncident {
  safeMode: boolean;
}

interface CaptureOptions {
  fatal?: boolean;
  componentStack?: string | null;
}

const CRASH_HISTORY_KEY = "postwave.desktop.crash-history.v1";
const SAFE_MODE_KEY = "postwave.desktop.safe-mode.v1";
const FALLBACK_LOG_KEY = "postwave.desktop.diagnostics.v1";
const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
const CRASH_LOOP_THRESHOLD = 3;
const SAFE_MODE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HEALTHY_SESSION_MS = 60 * 1000;
const MAX_FALLBACK_EVENTS = 30;
const MAX_COMPONENTS = 8;
const MAX_SYMBOL_CHARS = 64;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_-]{0,31}$/;
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_.$-]{0,63}$/;
const SENSITIVE_SYMBOL_RE =
  /(?:api[_-]?key|authorization|bearer|cookie|oauth|password|pw[_-]?live|secret|session|token)/i;

let initialized = false;
let bootState: DesktopDiagnosticsState = {
  initialized: false,
  safeMode: false,
  safeModeReason: null,
  nativeCrash: null,
};
let removeGlobalListeners: (() => void) | null = null;
let healthyTimer: number | null = null;
const stateListeners = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Native persistence remains the primary path. Storage-denied webviews
    // still get the current incident on screen and can copy a fresh report.
  }
}

function removeStored(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Best effort; a stale request expires after SAFE_MODE_MAX_AGE_MS.
  }
}

function now(): number {
  return Date.now();
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  try {
    globalThis.crypto?.getRandomValues(values);
  } catch {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...values]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function incidentId(atMs: number): string {
  const day = new Date(atMs).toISOString().slice(0, 10).replaceAll("-", "");
  return `PW-${day}-${randomHex(5)}`;
}

function safeErrorType(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name
      : error !== null && typeof error === "object"
        ? error.constructor?.name
        : typeof error;
  return typeof candidate === "string" &&
    SYMBOL_RE.test(candidate) &&
    !SENSITIVE_SYMBOL_RE.test(candidate)
    ? candidate.slice(0, MAX_SYMBOL_CHARS)
    : "Error";
}

function safeErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    ERROR_CODE_RE.test(code) &&
    !SENSITIVE_SYMBOL_RE.test(code)
    ? code
    : null;
}

/** Extract React component names only; paths, line numbers, and props stay out. */
export function safeComponentTrace(stack: string | null | undefined): string[] {
  if (!stack) return [];
  const components: string[] = [];
  for (const line of stack.split("\n")) {
    const match = /^\s*at\s+([A-Za-z_$][A-Za-z0-9_.$-]*)/.exec(line);
    if (
      !match ||
      !SYMBOL_RE.test(match[1]) ||
      SENSITIVE_SYMBOL_RE.test(match[1])
    ) {
      continue;
    }
    components.push(match[1].slice(0, MAX_SYMBOL_CHARS));
    if (components.length === MAX_COMPONENTS) break;
  }
  return components;
}

function readCrashHistory(atMs: number): number[] {
  const raw = readJson(CRASH_HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is number =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= atMs + 60_000 &&
      atMs - value <= CRASH_LOOP_WINDOW_MS,
  );
}

function recordFatalCrash(atMs: number): void {
  const history = [...readCrashHistory(atMs), atMs].slice(
    -CRASH_LOOP_THRESHOLD,
  );
  writeJson(CRASH_HISTORY_KEY, history);
  if (history.length >= CRASH_LOOP_THRESHOLD) {
    writeJson(SAFE_MODE_KEY, {
      requestedAtMs: atMs,
      reason: "crash_loop",
    } satisfies StoredSafeModeRequest);
  }
}

function readSafeModeRequest(atMs: number): StoredSafeModeRequest | null {
  const value = readJson(SAFE_MODE_KEY);
  if (
    value === null ||
    typeof value !== "object" ||
    !("requestedAtMs" in value) ||
    !("reason" in value)
  ) {
    return null;
  }
  const request = value as Partial<StoredSafeModeRequest>;
  if (
    typeof request.requestedAtMs !== "number" ||
    (request.reason !== "manual" && request.reason !== "crash_loop") ||
    atMs - request.requestedAtMs > SAFE_MODE_MAX_AGE_MS ||
    request.requestedAtMs > atMs + 60_000
  ) {
    removeStored(SAFE_MODE_KEY);
    return null;
  }
  return request as StoredSafeModeRequest;
}

function emitState(): void {
  for (const listener of stateListeners) listener();
}

function setNativeCrash(nativeCrash: NativeCrashRecord | null): void {
  bootState = { ...bootState, nativeCrash };
  emitState();
}

function persistFallbackEvent(event: StoredRendererEvent): void {
  const raw = readJson(FALLBACK_LOG_KEY);
  const previous = Array.isArray(raw)
    ? raw.filter(isStoredRendererEvent).slice(-(MAX_FALLBACK_EVENTS - 1))
    : [];
  writeJson(FALLBACK_LOG_KEY, [...previous, event]);
}

function isStoredRendererEvent(value: unknown): value is StoredRendererEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Partial<StoredRendererEvent>;
  return (
    typeof event.incidentId === "string" &&
    /^PW-[A-Z0-9-]{8,32}$/.test(event.incidentId) &&
    typeof event.occurredAtMs === "number" &&
    [
      "renderer_boundary",
      "window_error",
      "unhandled_rejection",
      "bootstrap_failure",
    ].includes(event.kind ?? "") &&
    typeof event.errorType === "string" &&
    SYMBOL_RE.test(event.errorType) &&
    !SENSITIVE_SYMBOL_RE.test(event.errorType) &&
    (event.errorCode === null ||
      (typeof event.errorCode === "string" &&
        ERROR_CODE_RE.test(event.errorCode) &&
        !SENSITIVE_SYMBOL_RE.test(event.errorCode))) &&
    Array.isArray(event.componentTrace) &&
    event.componentTrace.every(
      (component) =>
        typeof component === "string" &&
        SYMBOL_RE.test(component) &&
        !SENSITIVE_SYMBOL_RE.test(component),
    ) &&
    typeof event.safeMode === "boolean"
  );
}

/**
 * Capture a renderer incident explicitly. Call this from handled React
 * boundaries as well as the root `error`/`unhandledrejection` listeners.
 */
export function captureRendererIncident(
  kind: DesktopIncidentKind,
  error: unknown,
  options: CaptureOptions = {},
): DesktopIncident {
  const occurredAtMs = now();
  const incident: DesktopIncident = {
    incidentId: incidentId(occurredAtMs),
    occurredAtMs,
    kind,
    errorType: safeErrorType(error),
    errorCode: safeErrorCode(error),
    componentTrace: safeComponentTrace(options.componentStack),
  };
  const stored: StoredRendererEvent = {
    ...incident,
    safeMode: bootState.safeMode,
  };

  persistFallbackEvent(stored);
  void tauriApi.recordRendererDiagnostic(stored).catch(() => undefined);

  // Sentry receives the structural incident, never the original exception;
  // arbitrary error messages can contain API responses or user-entered text.
  const reportable = new Error(
    `${kind}:${incident.errorType}:${incident.errorCode ?? "NO_CODE"}:${incident.incidentId}`,
  );
  reportable.name = "PostwaveDesktopIncident";
  captureException(reportable);

  if (options.fatal) {
    cancelHealthySession();
    recordFatalCrash(occurredAtMs);
  }
  return incident;
}

/** Install root browser listeners and read a one-shot native panic marker. */
export function initializeDesktopDiagnostics(): DesktopDiagnosticsState {
  if (initialized) return bootState;
  initialized = true;
  const atMs = now();
  const request = readSafeModeRequest(atMs);
  const crashLoop = readCrashHistory(atMs).length >= CRASH_LOOP_THRESHOLD;
  const reason = request?.reason ?? (crashLoop ? "crash_loop" : null);
  bootState = {
    initialized: true,
    safeMode: reason !== null,
    safeModeReason: reason,
    nativeCrash: null,
  };
  void tauriApi.setDesktopSafeMode(bootState.safeMode).catch(() => undefined);

  if (typeof window !== "undefined") {
    const onError = (event: ErrorEvent): void => {
      captureRendererIncident("window_error", event.error ?? event.type);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
      captureRendererIncident("unhandled_rejection", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    removeGlobalListeners = () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }

  void tauriApi
    .takeNativeCrashRecord()
    .then((record) => {
      if (record) recordFatalCrash(record.occurredAtMs);
      setNativeCrash(record);
    })
    .catch(() => undefined);
  return bootState;
}

export function getDesktopDiagnosticsState(): DesktopDiagnosticsState {
  return bootState;
}

export function subscribeDesktopDiagnostics(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function dismissNativeCrashNotice(): void {
  setNativeCrash(null);
}

export function isDesktopSafeMode(): boolean {
  return bootState.safeMode;
}

/**
 * Mark a launch healthy only after the root boundary has remained crash-free
 * for a full minute. A fatal boundary capture cancels this timer.
 */
export function armDesktopHealthySession(): () => void {
  cancelHealthySession();
  if (typeof window === "undefined") return () => undefined;
  healthyTimer = window.setTimeout(() => {
    healthyTimer = null;
    removeStored(CRASH_HISTORY_KEY);
  }, HEALTHY_SESSION_MS);
  return cancelHealthySession;
}

export function cancelHealthySession(): void {
  if (healthyTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(healthyTimer);
  }
  healthyTimer = null;
}

export function requestDesktopSafeMode(): void {
  writeJson(SAFE_MODE_KEY, {
    requestedAtMs: now(),
    reason: "manual",
  } satisfies StoredSafeModeRequest);
}

export function clearDesktopSafeMode(): void {
  removeStored(SAFE_MODE_KEY);
  removeStored(CRASH_HISTORY_KEY);
}

function fallbackEvents(): StoredRendererEvent[] {
  const raw = readJson(FALLBACK_LOG_KEY);
  return Array.isArray(raw)
    ? raw.filter(isStoredRendererEvent).slice(-MAX_FALLBACK_EVENTS)
    : [];
}

function formatRendererEvent(event: StoredRendererEvent): string {
  const code = event.errorCode ? ` code=${event.errorCode}` : "";
  const components = event.componentTrace.length
    ? ` components=${event.componentTrace.join(">")}`
    : "";
  return `${new Date(event.occurredAtMs).toISOString()} ${event.incidentId} ${event.kind} type=${event.errorType}${code}${components} safe_mode=${String(event.safeMode)}`;
}

/** Structural renderer lines consumed by the lazily loaded recovery report. */
export function getRendererDiagnosticLines(): string[] {
  return fallbackEvents().map(formatRendererEvent);
}

/** Test-only reset; production code never calls this. */
export function resetDesktopDiagnosticsForTests(clearStorage = true): void {
  removeGlobalListeners?.();
  removeGlobalListeners = null;
  cancelHealthySession();
  initialized = false;
  bootState = {
    initialized: false,
    safeMode: false,
    safeModeReason: null,
    nativeCrash: null,
  };
  stateListeners.clear();
  if (clearStorage) {
    for (const key of [CRASH_HISTORY_KEY, SAFE_MODE_KEY, FALLBACK_LOG_KEY]) {
      removeStored(key);
    }
  }
}
