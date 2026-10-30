/**
 * Process-wide exclusion between an internal-note action and destructive
 * sign-out. A note action owns its lease from before durable preparation until
 * the transport outcome has been checkpointed; sign-out owns the exclusive
 * lease from lifecycle preparation through the complete privacy wipe.
 */

export interface InternalNoteOperationLease {
  release(): void;
}

export interface InternalNoteSignOutLease {
  release(): void;
}

const operations = new Set<symbol>();
let signOutOwner: symbol | null = null;

export function tryAcquireInternalNoteOperationLease(): InternalNoteOperationLease | null {
  if (signOutOwner !== null) return null;
  const owner = Symbol("helpdesk-internal-note-operation");
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

export function tryAcquireInternalNoteSignOutLease(): InternalNoteSignOutLease | null {
  if (signOutOwner !== null || operations.size > 0) return null;
  const owner = Symbol("helpdesk-internal-note-sign-out");
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

export function inspectInternalNoteOperationExclusion():
  | "clear"
  | "operation-active"
  | "sign-out-active" {
  if (signOutOwner !== null) return "sign-out-active";
  return operations.size > 0 ? "operation-active" : "clear";
}

/** @internal Test isolation for this process-wide action lock. */
export function resetInternalNoteOperationExclusionForTests(): void {
  operations.clear();
  signOutOwner = null;
}
