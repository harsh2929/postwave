/**
 * members-copy — pure toast-copy builders for the MembersTab mutations.
 *
 * Kept out of the component so the honesty invariants are unit-testable
 * under the node-env vitest setup (no DOM): the add-result toast must
 * report `{added, skipped}` exactly as the server returned them — never
 * "Added N" when some of the N were skipped.
 */

import type { ListAddMembersResult } from "../../../lib/api-client";

export interface ToastCopy {
  message: string;
  detail?: string;
}

const plural = (n: number): string => (n === 1 ? "" : "s");

/**
 * Copy for the toast after POST /api/v1/lists/{id}/subscribers.
 * Skipped covers already-members, suppressed, and unknown ids — the
 * server doesn't break the count down further, so neither do we.
 */
export function addMembersToastCopy(
  listName: string,
  result: ListAddMembersResult,
): ToastCopy {
  const { added, skipped } = result;
  if (added === 0) {
    return {
      message: "No subscribers added",
      detail:
        skipped === 0
          ? `Nothing to add to ${listName}.`
          : `All ${skipped} selected subscriber${plural(skipped)} were skipped (already members, suppressed, or unknown).`,
    };
  }
  if (skipped === 0) {
    return {
      message: `Added ${added} subscriber${plural(added)} to ${listName}`,
    };
  }
  return {
    message: `Added ${added} of ${added + skipped} subscriber${plural(added + skipped)} to ${listName}`,
    detail: `${skipped} skipped (already members, suppressed, or unknown).`,
  };
}
