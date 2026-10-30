/**
 * Feature 12 — Optimistic UI via UI-from-variables.
 *
 * TanStack Query v5's `useMutationState` lets the row renderer pluck the
 * `variables` of every pending mutation under a given key and merge them
 * into the rendered list. The pending row vanishes automatically on
 * settle — no rollback code, no cache snapshots, no undo bugs.
 *
 * This module exposes two tiny hooks built on top of `useMutationState`:
 *   - usePendingByResource(resource, op?) — variables for in-flight
 *     create/update mutations on a resource ("tags", "lists", …).
 *   - useFailedByResource(resource) — variables of mutations that have
 *     burned through retries; rendered in yellow with a "Retry" link
 *     that re-enqueues the matching outbox entry.
 *
 * Mutation key convention (mirrors Feature 10's outbox defaults):
 *   [resource, op, targetId?]
 *     resource: "tags" | "lists" | "segments" | "templates" |
 *               "subscribers" | "campaigns" | …
 *     op:       "create" | "update" | "delete"
 *     targetId: optional — only present for update/delete so the
 *               useMutationState filter can isolate a specific row.
 */

import { useMutationState } from "@tanstack/react-query";

export type ResourceName =
  | "tags"
  | "lists"
  | "segments"
  | "templates"
  | "subscribers"
  | "campaigns"
  | "forms";

export type MutationOp = "create" | "update" | "delete";

/**
 * Build the canonical mutation key for a resource. Always start with
 * [resource] so the per-resource outbox retry/backoff defaults apply
 * (see installOutboxMutationDefaults).
 */
export function mutKey(
  resource: ResourceName,
  op: MutationOp,
  targetId?: string | number | null,
): readonly unknown[] {
  if (targetId == null) return [resource, op] as const;
  return [resource, op, String(targetId)] as const;
}

/**
 * Return the `variables` of every pending mutation under [resource, op].
 * If `op` is omitted, returns pending variables for ANY op on the
 * resource (useful for the "pending row" list-merge pattern where the
 * page wants both newly-created and in-flight updates).
 */
export function usePendingMutations<TVars = unknown>(
  resource: ResourceName,
  op?: MutationOp,
): TVars[] {
  const result = useMutationState<TVars>({
    filters: {
      mutationKey: op ? [resource, op] : [resource],
      status: "pending",
      exact: false,
    },
    select: (m) => m.state.variables as TVars,
  });
  // useMutationState may yield undefined entries for mutations whose
  // variables haven't been set yet (e.g. mounted but not fired). Strip
  // them so consumers never have to null-check inside .map().
  return result.filter((v): v is TVars => v != null);
}

/**
 * Return the variables of mutations that errored (terminal failure
 * after the retry budget). Used to render a yellow "Sync failed —
 * Retry" row inline. The matching outbox entry id is carried in the
 * variables payload by convention so the retry button can dispatch
 * straight to retryOutboxItem().
 */
export function useFailedMutations<TVars = unknown>(
  resource: ResourceName,
  op?: MutationOp,
): TVars[] {
  const result = useMutationState<TVars>({
    filters: {
      mutationKey: op ? [resource, op] : [resource],
      status: "error",
      exact: false,
    },
    select: (m) => m.state.variables as TVars,
  });
  return result.filter((v): v is TVars => v != null);
}
