import {
  inspectWebhookPlaygroundFireRecoveryInventory,
  inspectWebhookPlaygroundFireRecoveryScopeInventory,
} from "./webhook-playground-fire-recovery";
import {
  tryAcquireWebhookPlaygroundFireSignOutLease,
  type WebhookPlaygroundFireSignOutLease,
} from "./webhook-playground-fire-operation";
import { currentVerifiedWebhookPlaygroundFireScope } from "./webhook-playground-fire-verified-scope";

export type WebhookPlaygroundFireIdentityTransitionLease =
  WebhookPlaygroundFireSignOutLease;

/**
 * Race-closed preflight for API credential/base/workspace identity mutation.
 * The exclusive lease is acquired before inventory inspection, preventing a
 * new fire from checkpointing between a clear result and transition start.
 */
export function acquireWebhookPlaygroundFireIdentityTransitionLease(): WebhookPlaygroundFireIdentityTransitionLease {
  const lease = tryAcquireWebhookPlaygroundFireSignOutLease();
  if (!lease) {
    throw new Error(
      "A webhook Simulator fire or identity transition is active. Wait for it to finish before changing API identity.",
    );
  }
  const globalInventory = inspectWebhookPlaygroundFireRecoveryInventory();
  if (globalInventory === "clear") return lease;
  const currentScope = currentVerifiedWebhookPlaygroundFireScope();
  // A verified held inventory remains a global no-new-fire fence. If the
  // current credential cannot be qualified, preserve the ciphertext and let
  // the operator transition until they restore the owning identity.
  if (globalInventory === "held" && !currentScope) return lease;
  const inventory =
    globalInventory === "held" && currentScope
      ? inspectWebhookPlaygroundFireRecoveryScopeInventory(currentScope)
      : "unavailable";
  // Foreign evidence is deliberately preserved and continues to fence all
  // new fires. Letting the operator change identity is the only safe route
  // back to the credential that owns that evidence.
  if (inventory === "clear" || inventory === "foreign") return lease;
  lease.release();
  throw new Error(
    inventory === "current" || inventory === "mixed"
      ? "An encrypted webhook Simulator fire identity is unresolved. Reconcile it under the current API identity before changing credentials or workspaces."
      : "Moosewave could not verify the current encrypted webhook Simulator checkpoint scope. API identity changes remain blocked.",
  );
}
