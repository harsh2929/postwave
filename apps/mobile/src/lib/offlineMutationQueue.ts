import type { Mutation, QueryClient } from "@tanstack/react-query";

import { entityWriteLabel } from "./offlineEntityWriteContract";
import {
  OFFLINE_MUTATION_KEYS,
  type OfflineMutationAuthScope,
} from "./offlineMutationContract";

const SENT_VISIBILITY_MS = 60_000;

export type OfflineMutationStatus = "queued" | "syncing" | "sent" | "failed";

export interface OfflineMutationQueueItem {
  mutationId: number;
  operationId: string;
  label: string;
  status: OfflineMutationStatus;
  queuedAt: number;
  expiresAt: number;
  cancellable: boolean;
  retrySafe: true;
}

type ScopedVariables = {
  auth: OfflineMutationAuthScope;
  operationId: string;
};

export function listOfflineMutationQueue(
  client: QueryClient,
  scope: OfflineMutationAuthScope,
  now = Date.now(),
): OfflineMutationQueueItem[] {
  return client
    .getMutationCache()
    .getAll()
    .flatMap((mutation) => mutationQueueItem(mutation, scope, now))
    .sort((left, right) => right.queuedAt - left.queuedAt);
}

export function discardPausedOfflineMutations(
  client: QueryClient,
  scope: OfflineMutationAuthScope,
  mutationIds?: ReadonlySet<number>,
): number {
  const cache = client.getMutationCache();
  let removed = 0;
  for (const mutation of cache.getAll()) {
    if (mutationIds && !mutationIds.has(mutation.mutationId)) continue;
    const item = mutationQueueItem(mutation, scope, Date.now());
    if (item.length !== 1 || !item[0]?.cancellable) continue;
    cache.remove(mutation);
    removed += 1;
  }
  return removed;
}

export function dismissSettledOfflineMutationHistory(
  client: QueryClient,
  scope: OfflineMutationAuthScope,
): number {
  const cache = client.getMutationCache();
  let removed = 0;
  for (const mutation of cache.getAll()) {
    // Evaluate at submission time so an old success can still be explicitly
    // removed even after its one-minute visible confirmation has elapsed.
    const item = mutationQueueItem(mutation, scope, mutation.state.submittedAt);
    const status = item[0]?.status;
    if (status !== "sent" && status !== "failed") continue;
    cache.remove(mutation);
    removed += 1;
  }
  return removed;
}

export function sameOfflineMutationIdentity(
  left: OfflineMutationAuthScope,
  right: OfflineMutationAuthScope,
): boolean {
  return (
    left.baseUrl === right.baseUrl &&
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId &&
    left.role === right.role
  );
}

function mutationQueueItem(
  mutation: Mutation,
  scope: OfflineMutationAuthScope,
  now: number,
): OfflineMutationQueueItem[] {
  const label = mutationLabel(
    mutation.options.mutationKey,
    mutation.state.variables,
  );
  const variables = scopedVariables(mutation.state.variables);
  if (!label || !variables) return [];
  if (!sameOfflineMutationIdentity(variables.auth, scope)) return [];

  const status = mutationStatus(mutation);
  const queuedAt = Number.isFinite(variables.auth.queuedAt)
    ? variables.auth.queuedAt
    : mutation.state.submittedAt;
  if (status === "sent" && now - queuedAt > SENT_VISIBILITY_MS) return [];

  return [
    {
      mutationId: mutation.mutationId,
      operationId: variables.operationId,
      label,
      status,
      queuedAt,
      expiresAt: variables.auth.expiresAt,
      cancellable: status === "queued" && mutation.state.isPaused,
      retrySafe: true,
    },
  ];
}

function mutationStatus(mutation: Mutation): OfflineMutationStatus {
  if (mutation.state.status === "success") return "sent";
  if (mutation.state.status === "error") return "failed";
  return mutation.state.isPaused ? "queued" : "syncing";
}

function scopedVariables(value: unknown): ScopedVariables | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ScopedVariables>;
  const auth = candidate.auth;
  if (
    !auth ||
    typeof auth !== "object" ||
    typeof auth.baseUrl !== "string" ||
    typeof auth.tenantId !== "string" ||
    typeof auth.principalId !== "string" ||
    typeof auth.role !== "string" ||
    typeof auth.queuedAt !== "number" ||
    typeof auth.expiresAt !== "number" ||
    typeof candidate.operationId !== "string" ||
    candidate.operationId.length < 16 ||
    candidate.operationId.length > 128
  ) {
    return null;
  }
  return { auth, operationId: candidate.operationId };
}

function mutationLabel(
  key: readonly unknown[] | undefined,
  variables?: unknown,
): string | null {
  if (sameMutationKey(key, OFFLINE_MUTATION_KEYS.entityWrite)) {
    // The generic queue (NATIVE#1) names itself through its variables so a
    // new offline-capable screen needs no change here.
    const vars = (variables ?? {}) as { label?: string; method?: string };
    return entityWriteLabel({
      ...(typeof vars.label === "string" ? { label: vars.label } : {}),
      ...(typeof vars.method === "string" ? { method: vars.method } : {}),
    });
  }
  if (sameMutationKey(key, OFFLINE_MUTATION_KEYS.campaignUpdate)) {
    return "Campaign edit";
  }
  if (sameMutationKey(key, OFFLINE_MUTATION_KEYS.sequenceCreate)) {
    return "New sequence";
  }
  if (sameMutationKey(key, OFFLINE_MUTATION_KEYS.sequenceSave)) {
    return "Sequence changes";
  }
  return null;
}

function sameMutationKey(
  actual: readonly unknown[] | undefined,
  expected: readonly string[],
): boolean {
  return (
    actual?.length === expected.length &&
    expected.every((part, index) => actual[index] === part)
  );
}

export const offlineMutationQueuePolicy = {
  sentVisibilityMs: SENT_VISIBILITY_MS,
  cancelOnlyWhilePaused: true,
  identityFields: ["baseUrl", "tenantId", "principalId", "role"],
} as const;

/**
 * Content equality for the offline-queue banner's state.
 *
 * WHY THESE EXIST. `listOfflineMutationQueue` and `listOfflineMutationFailures`
 * build a FRESH array on every call, so setting them unconditionally changed the
 * state reference even when nothing had moved. In OfflineMutationFailureBanner
 * that fed an effect keyed on `[queue, refresh]`, which set a timer, which
 * called refresh, which built another new array: React reported "Maximum update
 * depth exceeded" 84 times in a single walk through the tabs.
 *
 * Compared FIELD BY FIELD rather than by JSON.stringify: key order is not part
 * of the contract, and a stringify would also make the comparison quietly
 * sensitive to fields added later. Every field that can change while an item
 * sits in the queue is included -- `status` and `expiresAt` are the ones that
 * actually move, and omitting either would freeze a stale banner on screen.
 */
export function sameQueue(
  a: readonly OfflineMutationQueueItem[],
  b: readonly OfflineMutationQueueItem[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.mutationId !== y.mutationId ||
      x.operationId !== y.operationId ||
      x.status !== y.status ||
      x.label !== y.label ||
      x.queuedAt !== y.queuedAt ||
      x.expiresAt !== y.expiresAt ||
      x.cancellable !== y.cancellable
    ) {
      return false;
    }
  }
  return true;
}
