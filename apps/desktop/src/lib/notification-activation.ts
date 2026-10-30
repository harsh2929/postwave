/** Listener-first native notification activation bridge. */

import { listen } from "@tauri-apps/api/event";

import { getNotificationCenterSnapshot } from "./notification-center";
import { openNotificationCenterEntryById } from "./notification-navigation";
import { isTauri, tauriApi } from "./tauri";

interface NativeNotificationActivation {
  activationId: string;
}

const MAX_PROCESSED_ACTIVATIONS = 64;
const processedActivations = new Set<string>();
let listenerPromise: Promise<void> | null = null;
let drainPromise: Promise<void> | null = null;

function parseActivation(value: unknown): NativeNotificationActivation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const activationId = (value as Record<string, unknown>).activationId;
  if (
    typeof activationId !== "string" ||
    !/^[0-9a-f]{16}$/u.test(activationId)
  ) {
    return null;
  }
  return { activationId };
}

function rememberProcessed(id: string): boolean {
  if (processedActivations.has(id)) return false;
  processedActivations.add(id);
  if (processedActivations.size > MAX_PROCESSED_ACTIVATIONS) {
    const oldest = processedActivations.values().next().value;
    if (oldest) processedActivations.delete(oldest);
  }
  return true;
}

function processActivation(value: unknown): boolean {
  const activation = parseActivation(value);
  if (!activation || !rememberProcessed(activation.activationId)) return false;
  try {
    return openNotificationCenterEntryById(activation.activationId);
  } catch {
    // Do not let one renderer navigation fault break the native event stream.
    // Leave this id retryable when the retained queue is drained.
    processedActivations.delete(activation.activationId);
    return false;
  }
}

async function drainPendingActivations(): Promise<void> {
  if (getNotificationCenterSnapshot().identity !== "ready") return;
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    const pending = await tauriApi.takePendingNotificationActivations();
    // Identity can change while native IPC is in flight. Never resolve a row
    // unless a decrypted center is still active at processing time.
    if (getNotificationCenterSnapshot().identity !== "ready") return;
    for (const activation of pending) processActivation(activation);
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}

async function attachListener(): Promise<void> {
  await listen<unknown>("notification:activated", (event) => {
    if (getNotificationCenterSnapshot().identity !== "ready") {
      // Rust retains the id until a later ready-state drain.
      return;
    }
    processActivation(event.payload);
    // A live event is also retained natively until a successful handshake.
    // Drain after processing so reload races are closed; the bounded JS set
    // makes the live+drain pair idempotent.
    void drainPendingActivations().catch(() => undefined);
  });
}

/**
 * Attach live delivery first, then drain native cold-start/reload state. Call
 * again whenever Notification Center reaches `ready`; attachment is shared,
 * while each identity transition gets a fresh drain.
 */
export async function synchronizeNativeNotificationActivations(): Promise<void> {
  if (!isTauri() || getNotificationCenterSnapshot().identity !== "ready") {
    return;
  }
  if (!listenerPromise) {
    listenerPromise = attachListener().catch((error: unknown) => {
      listenerPromise = null;
      throw error;
    });
  }
  await listenerPromise;
  await drainPendingActivations();
}

/** @internal Pure activation entry point for focused trust-boundary tests. */
export function processNativeNotificationActivationForTests(
  value: unknown,
): boolean {
  return processActivation(value);
}

/** @internal Reset process-local dedupe between focused tests. */
export function resetNotificationActivationForTests(): void {
  processedActivations.clear();
  listenerPromise = null;
  drainPromise = null;
}
