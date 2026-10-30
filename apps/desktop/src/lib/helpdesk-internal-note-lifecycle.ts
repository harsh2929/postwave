import { inspectInternalNoteRecoveryInventory } from "../components/helpdesk/internal-note-recovery";
import {
  inspectInternalNoteOperationExclusion,
  type InternalNoteSignOutLease,
  tryAcquireInternalNoteSignOutLease,
} from "./helpdesk-internal-note-operation";
import { registerLifecycleGuard } from "./lifecycle-coordinator";

export interface InternalNoteSignOutAction {
  acquire(): void;
  ownsLease(): boolean;
  release(): void;
}

export function createInternalNoteSignOutAction(): InternalNoteSignOutAction {
  let lease: InternalNoteSignOutLease | null = null;
  return Object.freeze({
    acquire(): void {
      if (lease) return;
      lease = tryAcquireInternalNoteSignOutLease();
      if (!lease) {
        throw new Error(
          "An internal-note operation started before destructive sign-out could take ownership.",
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
 * Keep unresolved idempotency authority out of the ordinary privacy wipe.
 * This owner is registered synchronously at the sign-out request boundary,
 * not on the Helpdesk route, and survives the full review/recheck sequence.
 */
export function registerInternalNoteRecoverySignOutGuard(
  action: InternalNoteSignOutAction = createInternalNoteSignOutAction(),
): () => void {
  const unregister = registerLifecycleGuard({
    id: "helpdesk-internal-note-recovery",
    label: "Unresolved Helpdesk internal note",
    kinds: ["sign-out"],
    inspect: () => {
      const inventory = inspectInternalNoteRecoveryInventory();
      const exclusion = inspectInternalNoteOperationExclusion();
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
            ? "An encrypted internal-note checkpoint is unresolved. Return to Helpdesk under its original signed-in workspace and explicitly reconcile the original key before signing out. No customer delivery was attempted."
            : exclusion === "operation-active"
              ? "An internal-note action is still preparing, sending, or recording its transport outcome. Wait for it to finish before signing out."
              : "Moosewave could not verify the encrypted internal-note checkpoint inventory. Sign-out remains blocked so an original idempotency key is not destroyed.",
      };
    },
    // This is the action boundary, not another snapshot. The lease is taken
    // before the coordinator's final inspection and remains owned by the
    // sign-out action until destructive cleanup has completed or is cancelled.
    prepare: () => action.acquire(),
  });
  return () => {
    unregister();
    action.release();
  };
}
