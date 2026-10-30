import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

import { requestFullSignOut } from "./auth";
import {
  type LifecycleIntent,
  type LifecycleIntentKind,
  registerLifecycleGuard,
  requestLifecycleTransition,
} from "./lifecycle-coordinator";
import {
  clearOfflineStores,
  getOfflinePersistenceError,
  offlineQueueIdle,
  readOfflineQueue,
} from "./offline-store";
import { isTauri, type Platform, tauriApi } from "./tauri";

export type DesktopCloseBehavior = "ask" | "hide" | "quit";

interface DesktopWindowLifecycleState {
  closeBehavior: DesktopCloseBehavior;
  closeEducationOpen: boolean;
  platform: Platform;
  recoveredInterruptedShutdown: boolean;
}

const CLOSE_BEHAVIOR_KEY = "postwave.desktop.close-behavior.v1";
const subscribers = new Set<() => void>();
let state: DesktopWindowLifecycleState = {
  closeBehavior: readCloseBehavior(),
  closeEducationOpen: false,
  platform: "unknown",
  recoveredInterruptedShutdown: false,
};
let initialization: Promise<void> | null = null;
let coreGuardsRegistered = false;
let closeIntentActive = false;
let quitIntentActive = false;
let shutdownIntentActive = false;

const PROCESS_EXIT_INTENTS: readonly LifecycleIntentKind[] = [
  "close-window",
  "quit-app",
  "sign-out",
  "workspace-switch",
  "update-restart",
  "os-shutdown",
];

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function setState(patch: Partial<DesktopWindowLifecycleState>): void {
  state = { ...state, ...patch };
  notify();
}

export function getDesktopWindowLifecycleState(): DesktopWindowLifecycleState {
  return state;
}

export function useDesktopWindowLifecycleState(): DesktopWindowLifecycleState {
  return useSyncExternalStore(
    subscribe,
    getDesktopWindowLifecycleState,
    getDesktopWindowLifecycleState,
  );
}

/**
 * Install native listeners before credential hydration. Rust retains any
 * intent that arrives during startup; the final handshake drains it only
 * after every listener is live.
 */
export function initializeDesktopWindowLifecycle(): Promise<void> {
  registerCoreLifecycleGuards();
  if (initialization) return initialization;
  initialization = initializeNativeListeners();
  return initialization;
}

async function initializeNativeListeners(): Promise<void> {
  if (!isTauri()) return;
  const [platform] = await Promise.all([
    tauriApi.getPlatform(),
    listen("lifecycle:close-requested", () => void handleCloseRequest()),
    listen("lifecycle:quit-requested", () => void handleQuitRequest()),
    listen(
      "lifecycle:os-shutdown-requested",
      () => void handleOsShutdownRequest(),
    ),
    listen("tray:sign-out", () => void handleTraySignOut()),
  ]);
  setState({ platform });

  const retained = await tauriApi.desktopWindowLifecycleReady();
  if (retained.recoveredInterruptedShutdown) {
    setState({ recoveredInterruptedShutdown: true });
  }
  if (retained.closeRequested) void handleCloseRequest();
  if (retained.quitRequested) void handleQuitRequest();
  if (retained.osShutdownRequested) void handleOsShutdownRequest();
}

function registerCoreLifecycleGuards(): void {
  if (coreGuardsRegistered) return;
  coreGuardsRegistered = true;
  registerLifecycleGuard({
    id: "offline-outbox",
    label: "Changes waiting to sync",
    // The encrypted outbox is process-owned and survives ordinary route
    // changes. It participates only when the process or identity can change.
    kinds: PROCESS_EXIT_INTENTS,
    inspect: (intent) => {
      if (intent.disposition === "hide") return null;
      const persistenceFailure = getOfflinePersistenceError();
      if (persistenceFailure) {
        return {
          level: "blocking",
          detail:
            "Moosewave could not verify the encrypted offline journal. Keep the app open and retry storage recovery before leaving.",
          canDiscard: intent.kind === "sign-out",
        };
      }
      const queued = readOfflineQueue();
      if (queued.length === 0) return null;
      if (intent.kind === "sign-out") {
        return {
          level: "blocking",
          detail: `${queued.length} local change${queued.length === 1 ? "" : "s"} will be removed from this device during sign-out. Sync first or explicitly discard the recoverable journal.`,
          canDiscard: true,
        };
      }
      const active = queued.filter((item) => item.status === "replaying");
      if (active.length > 0) {
        return {
          level: "warning",
          detail: `${active.length} local change${active.length === 1 ? " is" : "s are"} replaying now. The encrypted journal is durable and will resume after relaunch.`,
        };
      }
      return null;
    },
    prepare: offlineQueueIdle,
    discard: async (intent) => {
      if (intent.kind !== "sign-out") {
        throw new Error("Outbox discard is not allowed for this transition");
      }
      await clearOfflineStores();
    },
  });
}

async function handleCloseRequest(): Promise<void> {
  if (closeIntentActive) return;
  closeIntentActive = true;
  if (state.closeBehavior === "ask") {
    setState({ closeEducationOpen: true });
    return;
  }
  await executeCloseBehavior(state.closeBehavior, false);
}

export async function chooseDesktopCloseBehavior(
  behavior: Exclude<DesktopCloseBehavior, "ask">,
): Promise<void> {
  setDesktopCloseBehavior(behavior);
  setState({ closeEducationOpen: false });
  await executeCloseBehavior(behavior, false);
}

async function executeCloseBehavior(
  behavior: Exclude<DesktopCloseBehavior, "ask">,
  acquireIntent: boolean,
): Promise<void> {
  if (acquireIntent) {
    if (closeIntentActive) return;
    closeIntentActive = true;
  }
  const hides = behavior === "hide";
  const intent: LifecycleIntent = {
    kind: "close-window",
    disposition: hides ? "hide" : "exit",
    title: hides ? "Keep Moosewave running in the tray?" : "Quit Moosewave?",
    description: hides
      ? "Moosewave checks active work, then hides this window while sync and transfers keep running."
      : "Moosewave checks drafts, active operations, and recoverable journals before quitting.",
    confirmLabel: hides ? "Keep running" : "Quit Moosewave",
    danger: !hides,
  };
  const result = await requestLifecycleTransition(intent, () =>
    hides ? tauriApi.hideDesktopWindow() : tauriApi.quitApp(),
  );
  if (result !== "proceeded") {
    await tauriApi
      .cancelDesktopWindowIntent("close-window")
      .catch(() => undefined);
  }
  closeIntentActive = false;
}

export function cancelDesktopCloseEducation(): void {
  if (!state.closeEducationOpen) return;
  setState({ closeEducationOpen: false });
  closeIntentActive = false;
  void tauriApi
    .cancelDesktopWindowIntent("close-window")
    .catch(() => undefined);
}

async function handleQuitRequest(): Promise<void> {
  if (quitIntentActive) return;
  quitIntentActive = true;
  const result = await requestLifecycleTransition(
    {
      kind: "quit-app",
      disposition: "exit",
      title: "Quit Moosewave?",
      description:
        "Moosewave will check drafts, active operations, and recoverable journals before quitting.",
      confirmLabel: "Quit Moosewave",
      danger: true,
    },
    () => tauriApi.quitApp(),
  );
  if (result !== "proceeded") {
    await tauriApi.cancelDesktopWindowIntent("quit-app").catch(() => undefined);
  }
  quitIntentActive = false;
}

async function handleOsShutdownRequest(): Promise<void> {
  if (shutdownIntentActive) return;
  shutdownIntentActive = true;
  const result = await requestLifecycleTransition(
    {
      kind: "os-shutdown",
      disposition: "exit",
      title: "Moosewave needs a moment before shutdown",
      description:
        "The operating system asked Moosewave to stop. Recoverable journals are durable; Moosewave will make one bounded safety check before exiting.",
      confirmLabel: "Finish and quit",
      danger: true,
    },
    () => tauriApi.quitApp(),
  );
  if (result !== "proceeded") {
    await tauriApi
      .cancelDesktopWindowIntent("os-shutdown")
      .catch(() => undefined);
  }
  shutdownIntentActive = false;
}

async function handleTraySignOut(): Promise<void> {
  const result = await requestFullSignOut();
  if (result === "proceeded") window.location.reload();
}

export function setDesktopCloseBehavior(behavior: DesktopCloseBehavior): void {
  if (!isDesktopCloseBehavior(behavior)) return;
  try {
    window.localStorage.setItem(CLOSE_BEHAVIOR_KEY, behavior);
  } catch {
    // Locked renderer storage keeps the preference for this process only.
  }
  setState({ closeBehavior: behavior });
}

export function recommendedDesktopCloseBehavior(
  platform: Platform,
): Exclude<DesktopCloseBehavior, "ask"> {
  return platform === "macos" ? "hide" : "quit";
}

export function dismissInterruptedShutdownRecovery(): void {
  setState({ recoveredInterruptedShutdown: false });
  void tauriApi
    .cancelDesktopWindowIntent("recovered-shutdown")
    .catch(() => undefined);
}

function readCloseBehavior(): DesktopCloseBehavior {
  if (typeof window === "undefined") return "ask";
  try {
    const value = window.localStorage.getItem(CLOSE_BEHAVIOR_KEY);
    return isDesktopCloseBehavior(value) ? value : "ask";
  } catch {
    return "ask";
  }
}

function isDesktopCloseBehavior(value: unknown): value is DesktopCloseBehavior {
  return value === "ask" || value === "hide" || value === "quit";
}

/** @internal Test reset; native listeners themselves are process-owned. */
export function resetDesktopWindowLifecycleForTests(): void {
  state = {
    closeBehavior: "ask",
    closeEducationOpen: false,
    platform: "unknown",
    recoveredInterruptedShutdown: false,
  };
  closeIntentActive = false;
  quitIntentActive = false;
  shutdownIntentActive = false;
  notify();
}
