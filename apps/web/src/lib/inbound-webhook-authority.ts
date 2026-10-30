// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";

export const INBOUND_WEBHOOK_ADMIN_ONLY_MESSAGE =
  "Inbound webhook endpoints, events, transforms, and triggers are available only to workspace owners and administrators.";

export const ADMIN_WRITE_AUTHORITY_CHANGED_MESSAGE =
  "Your workspace authority changed. Nothing was written; refresh and retry.";

export const INBOUND_WEBHOOK_BULK_CONCURRENCY = 4;

export function canAdminInboundWebhooks(
  identity: MeResponse | null | undefined,
): boolean {
  if (!identity || identity.viewer_mode) return false;
  const role = effectiveAuthRole(identity);
  return role === "owner" || role === "admin";
}

export function isSameInboundWebhookAdminContext(
  opened: MeResponse,
  current: MeResponse | null | undefined,
): current is MeResponse {
  return Boolean(
    current &&
    opened.user_id === current.user_id &&
    opened.tenant_id === current.tenant_id &&
    effectiveAuthRole(opened) === effectiveAuthRole(current) &&
    Boolean(opened.viewer_mode) === Boolean(current.viewer_mode) &&
    canAdminInboundWebhooks(opened) &&
    canAdminInboundWebhooks(current),
  );
}

/**
 * Sensitive writes are bound to the exact identity and effective authority
 * that opened the control. A fresh admin from another account/workspace is not
 * permission to finish a stale action from the previous context.
 */
export function assertFreshInboundWebhookAdmin(
  opened: MeResponse,
  fresh: MeResponse,
): void {
  if (!isSameInboundWebhookAdminContext(opened, fresh)) {
    throw new Error(ADMIN_WRITE_AUTHORITY_CHANGED_MESSAGE);
  }
}

export async function verifyFreshInboundWebhookAdmin(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  assertFreshInboundWebhookAdmin(opened, fresh);
  return fresh;
}

/** Preserve per-row outcomes without launching an unbounded request burst. */
export async function settleInboundWebhookBatch<T, R>(
  values: readonly T[],
  run: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(INBOUND_WEBHOOK_BULK_CONCURRENCY, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await run(values[index]!),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}
