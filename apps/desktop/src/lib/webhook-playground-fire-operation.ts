/**
 * Process-wide exclusion between a webhook playground fire lifecycle and a
 * destructive sign-out. A fire owns its lease before writing the encrypted
 * checkpoint and keeps it until the receiver outcome is durably settled (or
 * the unresolved checkpoint is safely left in place). Sign-out owns the
 * exclusive lease through the complete privacy wipe.
 */

export interface WebhookPlaygroundFireOperationLease {
  release(): void;
}

export interface WebhookPlaygroundFireSignOutLease {
  release(): void;
}

const operations = new Set<symbol>();
let signOutOwner: symbol | null = null;

export function tryAcquireWebhookPlaygroundFireOperationLease(): WebhookPlaygroundFireOperationLease | null {
  if (signOutOwner !== null) return null;
  const owner = Symbol("webhook-playground-fire-operation");
  operations.add(owner);
  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      operations.delete(owner);
    },
  });
}

export function tryAcquireWebhookPlaygroundFireSignOutLease(): WebhookPlaygroundFireSignOutLease | null {
  if (signOutOwner !== null || operations.size > 0) return null;
  const owner = Symbol("webhook-playground-fire-sign-out");
  signOutOwner = owner;
  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      if (signOutOwner === owner) signOutOwner = null;
    },
  });
}

export function inspectWebhookPlaygroundFireOperationExclusion():
  | "clear"
  | "operation-active"
  | "sign-out-active" {
  if (signOutOwner !== null) return "sign-out-active";
  return operations.size > 0 ? "operation-active" : "clear";
}

/** @internal Test isolation for the process-wide action lock. */
export function resetWebhookPlaygroundFireOperationExclusionForTests(): void {
  operations.clear();
  signOutOwner = null;
}
