/**
 * useAppUpdate — the in-app update state machine (NATIVE#3 / SHELL#29).
 *
 * ONE module-level store rather than per-component state, for the same reason
 * `lib/upgradeRequired.ts` is a store: two surfaces observe this (the
 * diagnostics card and the app-wide watcher that tells the user an update is
 * ready), and two independent copies would let the watcher toast "update
 * ready" while the card still said "up to date".
 *
 * The automatic check is throttled by `shouldAutoCheckForUpdate` and runs on
 * foreground, not on an interval: a phone that is in a pocket has nothing to
 * update to, and waking the radio for it is a battery cost with no user.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  INITIAL_APP_UPDATE_STATE,
  shouldAutoCheckForUpdate,
  type AppUpdateState,
} from "@/lib/appUpdatePolicy";
import {
  appUpdatesEnabled,
  checkAndFetchAppUpdate,
  restartWithAppUpdate,
} from "@/lib/appUpdates";
import { isProbablyOnline } from "@/lib/connectivity";

let state: AppUpdateState = INITIAL_APP_UPDATE_STATE;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function commit(next: AppUpdateState): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): AppUpdateState {
  return state;
}

/** Test seam: reset the module store between cases. */
export function resetAppUpdateState(): void {
  inFlight = null;
  commit(INITIAL_APP_UPDATE_STATE);
}

/**
 * Run one check+fetch. Concurrent callers share the in-flight promise, so the
 * foreground watcher and a user tapping "Check now" cannot double-poll.
 */
export function runAppUpdateCheck(): Promise<void> {
  if (inFlight) return inFlight;
  if (!appUpdatesEnabled()) {
    commit({ phase: "unsupported", lastCheckedAt: Date.now(), error: null });
    return Promise.resolve();
  }
  commit({ ...state, phase: "checking", error: null });
  inFlight = checkAndFetchAppUpdate()
    .then((outcome) => {
      const lastCheckedAt = Date.now();
      switch (outcome.kind) {
        case "ready":
          commit({ phase: "ready", lastCheckedAt, error: null });
          break;
        case "up-to-date":
          commit({ phase: "up-to-date", lastCheckedAt, error: null });
          break;
        case "unsupported":
          commit({ phase: "unsupported", lastCheckedAt, error: null });
          break;
        case "error":
          commit({ phase: "error", lastCheckedAt, error: outcome.message });
          break;
      }
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Apply a staged update. Rejects when there is nothing staged or it fails. */
export async function applyAppUpdate(): Promise<void> {
  await restartWithAppUpdate();
}

/** Read the shared state. */
export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export interface AppUpdateController {
  state: AppUpdateState;
  check: () => void;
  restart: () => Promise<void>;
}

/**
 * The controller the diagnostics card binds to. Does NOT auto-check — that is
 * `useAppUpdateWatcher`'s job, so opening diagnostics on a metered connection
 * does not trigger a poll the user did not ask for.
 */
export function useAppUpdate(): AppUpdateController {
  const current = useAppUpdateState();
  const check = useCallback(() => {
    void runAppUpdateCheck();
  }, []);
  return { state: current, check, restart: applyAppUpdate };
}

/**
 * Mounted once in the shell. Checks on launch and on each return to the
 * foreground, subject to the six-hour throttle, and calls `onReady` the first
 * time an update becomes staged so the shell can offer the restart.
 */
export function useAppUpdateWatcher(onReady: () => void): void {
  const current = useAppUpdateState();
  const announced = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    function maybeCheck(): void {
      if (
        shouldAutoCheckForUpdate({
          enabled: appUpdatesEnabled(),
          online: isProbablyOnline(),
          phase: snapshot().phase,
          lastCheckedAt: snapshot().lastCheckedAt,
          now: Date.now(),
        })
      ) {
        void runAppUpdateCheck();
      }
    }
    maybeCheck();
    const sub = AppState.addEventListener("change", (status: AppStateStatus) => {
      if (status === "active") maybeCheck();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (current.phase !== "ready" || announced.current) return;
    announced.current = true;
    onReadyRef.current();
  }, [current.phase]);
}
