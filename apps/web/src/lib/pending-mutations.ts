// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Feature 12 — Optimistic UI via UI-from-variables.
 *
 * Web-side mirror of apps/desktop/src/lib/pending-mutations.ts. Keep the
 * two in lockstep — the mutation-key convention is shared between the
 * two surfaces so a future cross-app helper can reuse them verbatim.
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

export function mutKey(
  resource: ResourceName,
  op: MutationOp,
  targetId?: string | number | null,
): readonly unknown[] {
  if (targetId == null) return [resource, op] as const;
  return [resource, op, String(targetId)] as const;
}

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
  return result.filter((v): v is TVars => v != null);
}

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
