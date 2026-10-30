/**
 * Tiny toast system. One global queue rendered by `<ToastHost />` mounted
 * once near the root. Modules anywhere call `toast.success("…")` /
 * `toast.error("…")` / `toast.info("…")` / `toast.soon("…")` (the last is
 * for "ships in v0.2"-style placeholders so the brand stays consistent).
 *
 * Rich form: pass an object instead of a string to get a two-line toast
 * with optional action button:
 *
 *   toast.success({
 *     message: "Subscriber imported",
 *     detail: "Will appear in your audience within 30 seconds.",
 *     action: { label: "Undo", onClick: () => api.deleteSubscriber(id) },
 *     duration: 6000,
 *   });
 *
 * The visible stack is bounded to three notices. Repeated notices are
 * updated in place, timers pause while the notice is being inspected or the
 * document is hidden, and every notice has an explicit dismiss control.
 */
import { type ReactElement, type ReactNode, useEffect, useState } from "react";

import { getDesktopRouteSnapshot } from "../lib/desktop-router";
import { track as trackTelemetry } from "../lib/telemetry";
import type { CriticalToastBridge } from "../lib/toast-critical-controller";
import {
  hasPersistedCriticalNotices,
  type CriticalNoticeCode,
  type CriticalNoticeCopy,
} from "../lib/toast-critical-notices";

type Kind = "success" | "error" | "info" | "soon";

interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastInput {
  /** Stable identity for updating/deduplicating a domain notice in place. */
  id?: string;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** Defaults to 3500ms, 6000ms with an action, and 8000ms for errors. */
  duration?: number;
  icon?: ReactNode;
}

interface InternalToastInput extends ToastInput {
  persistent?: boolean;
}

interface ToastItem {
  id: number;
  dedupeKey: string;
  kind: Kind;
  message: string;
  detail?: string;
  action?: ToastAction;
  icon?: ReactNode;
  durationMs: number;
  persistent: boolean;
  criticalCode?: CriticalNoticeCode;
}

interface TimerState {
  timer?: number;
  remainingMs: number;
  startedAt: number;
}

const MAX_VISIBLE_TOASTS = 3;
const subscribers = new Set<(items: ToastItem[]) => void>();
const timerStates = new Map<number, TimerState>();
const pauseReasons = new Map<number, Set<string>>();
let queue: ToastItem[] = [];
let nextId = 1;

/** Privacy-safe presence signal used by non-critical education surfaces. */
export function hasCriticalToast(): boolean {
  if (queue.some((item) => item.criticalCode !== undefined)) return true;
  return hasPersistedCriticalNotices();
}

/** Subscribe to toast presence without exposing message or detail payloads. */
export function subscribeToastState(subscriber: () => void): () => void {
  const listener = (): void => subscriber();
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function emit(): void {
  for (const fn of subscribers) fn([...queue]);
}

function normalize(
  kind: Kind,
  input: string | InternalToastInput,
): Omit<ToastItem, "id" | "kind"> {
  if (typeof input === "string") {
    return {
      message: input,
      dedupeKey: `${kind}:${input}`,
      durationMs: kind === "error" ? 8000 : 3500,
      persistent: false,
    };
  }
  const defaultDuration = kind === "error" ? 8000 : input.action ? 6000 : 3500;
  const requestedDuration = input.duration ?? defaultDuration;
  const durationMs =
    Number.isFinite(requestedDuration) && requestedDuration > 0
      ? requestedDuration
      : defaultDuration;
  return {
    message: input.message,
    detail: input.detail,
    action: input.action,
    icon: input.icon,
    dedupeKey:
      input.id ?? `${kind}:${input.message}\u0000${input.detail ?? ""}`,
    durationMs,
    persistent: input.persistent === true,
  };
}

function clearLifecycle(id: number): void {
  const state = timerStates.get(id);
  if (state?.timer !== undefined) window.clearTimeout(state.timer);
  timerStates.delete(id);
  pauseReasons.delete(id);
}

function startTimer(id: number): void {
  const state = timerStates.get(id);
  if (!state || state.timer !== undefined) return;
  if ((pauseReasons.get(id)?.size ?? 0) > 0) return;
  if (state.remainingMs <= 0) {
    dismiss(id);
    return;
  }
  state.startedAt = Date.now();
  state.timer = window.setTimeout(() => dismiss(id), state.remainingMs);
}

function restartTimer(
  id: number,
  durationMs: number,
  persistent: boolean,
): void {
  clearLifecycle(id);
  if (persistent || durationMs <= 0) return;
  timerStates.set(id, {
    remainingMs: durationMs,
    startedAt: Date.now(),
  });
  if (typeof document !== "undefined" && document.hidden) {
    pauseReasons.set(id, new Set(["document-hidden"]));
  }
  startTimer(id);
}

function pauseTimer(id: number, reason: string): void {
  const reasons = pauseReasons.get(id) ?? new Set<string>();
  reasons.add(reason);
  pauseReasons.set(id, reasons);
  const state = timerStates.get(id);
  if (!state || state.timer === undefined) return;
  window.clearTimeout(state.timer);
  state.timer = undefined;
  state.remainingMs = Math.max(
    0,
    state.remainingMs - (Date.now() - state.startedAt),
  );
}

function resumeTimer(id: number, reason: string): void {
  const reasons = pauseReasons.get(id);
  reasons?.delete(reason);
  if (reasons?.size === 0) pauseReasons.delete(id);
  startTimer(id);
}

function removeWithoutEmit(id: number): void {
  const criticalCode = queue.find((item) => item.id === id)?.criticalCode;
  clearLifecycle(id);
  queue = queue.filter((item) => item.id !== id);
  if (criticalCode) {
    withCriticalController((controller) =>
      controller.dismissCriticalNotice(criticalCode),
    );
  }
}

function enforceBound(): void {
  while (queue.length > MAX_VISIBLE_TOASTS) {
    const candidate =
      queue.find((item) => !item.persistent && item.kind !== "error") ??
      queue.find((item) => !item.persistent) ??
      queue[0];
    if (!candidate) return;
    removeWithoutEmit(candidate.id);
  }
}

function recordErrorSurface(criticalCode?: CriticalNoticeCode): void {
  /* Telemetry: only error surfaces are interesting (success/info/soon
   * are positive signals already captured by their domain events).
   * The message itself is NEVER sent — it can contain server-rendered
   * details with PII. We send only the path (sanitised via
   * the typed route's section only (never resource ids/query text) and the
   * kind enum so PostHog can graph errors without sensitive route state. */
  let path = "";
  try {
    path = getDesktopRouteSnapshot().route.section;
  } catch {
    /* no-window during tests */
  }
  trackTelemetry("error_surface", {
    code: criticalCode ? `toast.critical.${criticalCode}` : "toast.error",
    path,
  });
}

function dismiss(id: number): void {
  removeWithoutEmit(id);
  emit();
}

interface UpsertOptions {
  forcePersistent?: boolean;
  criticalCode?: CriticalNoticeCode;
  recordTelemetry?: boolean;
}

function sameAnnouncement(left: ToastItem, right: ToastItem): boolean {
  return (
    left.kind === right.kind &&
    left.message === right.message &&
    left.detail === right.detail &&
    left.action?.label === right.action?.label
  );
}

function upsert(
  kind: Kind,
  input: string | InternalToastInput,
  options: UpsertOptions = {},
): number {
  const normalized = normalize(kind, input);
  const existing = queue.find(
    (item) => item.dedupeKey === normalized.dedupeKey,
  );
  const id = existing?.id ?? nextId++;
  const item: ToastItem = {
    id,
    kind,
    ...normalized,
    persistent: options.forcePersistent === true || normalized.persistent,
    criticalCode: options.criticalCode,
  };
  const duplicateAnnouncement =
    existing !== undefined && sameAnnouncement(existing, item);
  queue = existing
    ? duplicateAnnouncement
      ? queue
      : queue.map((current) => (current.id === id ? item : current))
    : [...queue, item];
  enforceBound();
  if (!duplicateAnnouncement) emit();
  if (queue.some((current) => current.id === id)) {
    restartTimer(id, item.durationMs, item.persistent);
  }
  if (kind === "error" && options.recordTelemetry !== false) {
    recordErrorSurface(options.criticalCode);
  }
  return id;
}

function push(kind: Kind, input: string | ToastInput): void {
  upsert(kind, input);
}

/** Mutate an existing toast in place (used by the progress handle). */
function updateItem(id: number, patch: Partial<Omit<ToastItem, "id">>): void {
  let changed = false;
  queue = queue.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    return { ...t, ...patch };
  });
  if (changed) emit();
}

/**
 * Handle for a long-running, in-place-updatable toast — e.g. an app-update
 * download that streams progress. Unlike the fire-and-forget helpers, the
 * progress toast does NOT auto-dismiss on its own; the caller owns its
 * lifecycle through this handle.
 */
export interface ToastProgressHandle {
  /** Refresh the toast's title/detail (e.g. the running percent). */
  update(patch: { message?: string; detail?: string }): void;
  /**
   * Flip the persistent toast into a terminal success/error/info toast,
   * which then auto-dismisses on the normal timer.
   */
  done(kind: "success" | "error" | "info", input: string | ToastInput): void;
  /** Remove the toast immediately with no terminal message. */
  dismiss(): void;
}

function pushProgress(input: string | ToastInput): ToastProgressHandle {
  const id = upsert("info", input, { forcePersistent: true });
  return {
    update(patch) {
      updateItem(id, patch);
    },
    done(kind, finalInput) {
      const finalItem = normalize(kind, finalInput);
      updateItem(id, {
        kind,
        ...finalItem,
      });
      restartTimer(id, finalItem.durationMs, finalItem.persistent);
      if (kind === "error") recordErrorSurface();
    },
    dismiss() {
      dismiss(id);
    },
  };
}

function showCritical(
  code: CriticalNoticeCode,
  copy: CriticalNoticeCopy,
  recordTelemetry: boolean,
): void {
  upsert(
    "error",
    {
      id: `critical:${code}`,
      message: copy.message,
      detail: copy.detail,
      persistent: true,
    },
    {
      forcePersistent: true,
      criticalCode: code,
      recordTelemetry,
    },
  );
}

function removeCritical(code: CriticalNoticeCode): void {
  const item = queue.find((candidate) => candidate.criticalCode === code);
  if (!item) return;
  clearLifecycle(item.id);
  queue = queue.filter((candidate) => candidate.id !== item.id);
  emit();
}

const criticalToastBridge: CriticalToastBridge = {
  show: showCritical,
  remove: removeCritical,
};

type CriticalController = typeof import("../lib/toast-critical-controller");
let criticalControllerPromise: Promise<CriticalController> | null = null;

function loadCriticalController(): Promise<CriticalController> {
  criticalControllerPromise ??= import("../lib/toast-critical-controller");
  return criticalControllerPromise;
}

function withCriticalController(
  operation: (controller: CriticalController) => void,
): void {
  void loadCriticalController()
    .then(operation)
    .catch(() => {
      criticalControllerPromise = null;
    });
}

export const toast = {
  success: (m: string | ToastInput): void => push("success", m),
  error: (m: string | ToastInput): void => push("error", m),
  info: (m: string | ToastInput): void => push("info", m),
  /** "Ships in v0.2" — branded placeholder for unfinished surfaces. */
  soon: (m: string | ToastInput): void => push("soon", m),
  /** Long-running, in-place-updatable toast. See ToastProgressHandle. */
  progress: (m: string | ToastInput): ToastProgressHandle => pushProgress(m),
  /**
   * Reload-safe critical failure. Copy is selected from a reviewed catalog;
   * only the catalog code and timestamp are persisted locally.
   */
  critical: (code: CriticalNoticeCode): void =>
    withCriticalController((controller) =>
      controller.raiseCriticalNotice(code, criticalToastBridge),
    ),
  /** Clear a critical notice after its owning subsystem proves recovery. */
  resolveCritical: (code: CriticalNoticeCode): void =>
    withCriticalController((controller) =>
      controller.resolveCriticalNotice(code, criticalToastBridge),
    ),
};

/** @internal Test isolation for the module-level notification service. */
export function resetToastStateForTests(options?: {
  preservePersistedCritical?: boolean;
}): void {
  for (const item of queue) clearLifecycle(item.id);
  queue = [];
  nextId = 1;
  withCriticalController((controller) =>
    controller.resetCriticalNoticeController(options),
  );
  emit();
}

/** @internal Await lazy critical persistence/hydration in focused tests. */
export async function flushToastOperationsForTests(): Promise<void> {
  const controller = await loadCriticalController();
  await controller.flushCriticalNoticeOperations();
}

/* Inline icon components. We render kind-specific glyphs so the toast
 * is recognisable from the corner of the eye, not just by color. */
const iconStroke = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24" as const,
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function IconCheck(): ReactElement {
  return (
    <svg {...iconStroke}>
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}
function IconWarn(): ReactElement {
  return (
    <svg {...iconStroke}>
      <path d="M12 3 2 21h20z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </svg>
  );
}
function IconInfo(): ReactElement {
  return (
    <svg {...iconStroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6" />
      <path d="M12 7v.5" />
    </svg>
  );
}
function IconSoon(): ReactElement {
  return (
    <svg {...iconStroke}>
      <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5z" />
    </svg>
  );
}

function defaultIcon(kind: Kind): ReactNode {
  if (kind === "success") return <IconCheck />;
  if (kind === "error") return <IconWarn />;
  if (kind === "info") return <IconInfo />;
  return <IconSoon />;
}

export function ToastHost(): ReactElement {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    setItems([...queue]);
    subscribers.add(setItems);
    withCriticalController((controller) =>
      controller.hydrateCriticalNotices(criticalToastBridge),
    );
    const handleVisibilityChange = (): void => {
      for (const item of queue) {
        if (document.hidden) pauseTimer(item.id, "document-hidden");
        else resumeTimer(item.id, "document-hidden");
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      subscribers.delete(setItems);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      for (const item of queue) resumeTimer(item.id, "document-hidden");
    };
  }, []);
  return (
    <div className="toast-host">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          data-critical-notice={t.criticalCode ? "true" : undefined}
          role={t.kind === "error" ? "alert" : "status"}
          aria-atomic="true"
          onMouseEnter={() => pauseTimer(t.id, "pointer")}
          onMouseLeave={() => resumeTimer(t.id, "pointer")}
          onFocusCapture={() => pauseTimer(t.id, "focus")}
          onBlurCapture={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            ) {
              resumeTimer(t.id, "focus");
            }
          }}
        >
          <span className="toast-icon" aria-hidden="true">
            {t.icon ?? defaultIcon(t.kind)}
          </span>
          <span className="toast-msg-block">
            <span className="toast-msg-title">{t.message}</span>
            {t.detail ? (
              <span className="toast-msg-detail">{t.detail}</span>
            ) : null}
          </span>
          {t.action ? (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                pauseTimer(t.id, "action");
                void Promise.resolve()
                  .then(() => t.action?.onClick())
                  .catch(() => {
                    const durationMs = 8000;
                    updateItem(t.id, {
                      kind: "error",
                      detail: "That action could not be completed. Try again.",
                      durationMs,
                      persistent: false,
                    });
                    restartTimer(t.id, durationMs, false);
                    recordErrorSurface();
                  })
                  .finally(() => resumeTimer(t.id, "action"));
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="toast-dismiss"
            aria-label={`Dismiss notification: ${t.message}`}
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
