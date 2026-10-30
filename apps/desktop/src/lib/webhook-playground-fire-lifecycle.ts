import { registerLifecycleGuard } from "./lifecycle-coordinator";
import { inspectWebhookPlaygroundFireRecoveryInventory } from "./webhook-playground-fire-recovery";
import {
  inspectWebhookPlaygroundFireOperationExclusion,
  tryAcquireWebhookPlaygroundFireSignOutLease,
  type WebhookPlaygroundFireSignOutLease,
} from "./webhook-playground-fire-operation";

export interface WebhookPlaygroundFireSignOutAction {
  acquire(): void;
  ownsLease(): boolean;
  release(): void;
}

export function createWebhookPlaygroundFireSignOutAction(): WebhookPlaygroundFireSignOutAction {
  let lease: WebhookPlaygroundFireSignOutLease | null = null;
  return Object.freeze({
    acquire(): void {
      if (lease) return;
      lease = tryAcquireWebhookPlaygroundFireSignOutLease();
      if (!lease) {
        throw new Error(
          "A webhook simulator fire changed state before destructive sign-out could take ownership.",
        );
      }
    },
    ownsLease: () => lease !== null,
    release(): void {
      lease?.release();
      lease = null;
    },
  });
}

/**
 * Register the route-independent guard at the sign-out action boundary. This
 * catches encrypted checkpoints even while the Simulator route is unmounted.
 */
export function registerWebhookPlaygroundFireRecoverySignOutGuard(
  action: WebhookPlaygroundFireSignOutAction = createWebhookPlaygroundFireSignOutAction(),
): () => void {
  const unregister = registerLifecycleGuard({
    id: "webhook-playground-fire-recovery",
    label: "Unresolved webhook simulator fire",
    kinds: ["sign-out"],
    inspect: () => {
      const inventory = inspectWebhookPlaygroundFireRecoveryInventory();
      const exclusion = inspectWebhookPlaygroundFireOperationExclusion();
      if (
        inventory === "clear" &&
        (exclusion === "clear" || action.ownsLease())
      ) {
        return null;
      }
      return {
        level: "blocking" as const,
        canDiscard: false,
        canRecover: false,
        canSave: false,
        detail:
          inventory === "held"
            ? "An encrypted webhook Simulator fire identity is unresolved. Return to the Simulator under its original signed-in workspace and reconcile that exact fire before signing out."
            : exclusion === "operation-active"
              ? "A webhook Simulator fire is preparing, sending, or recording its outcome. Wait for it to finish before signing out."
              : "Moosewave could not verify the encrypted webhook Simulator checkpoint inventory. Sign-out remains blocked so the original fire identity is not destroyed.",
      };
    },
    prepare: () => action.acquire(),
  });
  return () => {
    unregister();
    action.release();
  };
}
