// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import type { RoleKey } from "@/lib/query-keys";

export interface AnalyticsAuthority {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
  authorityKey: string;
}

export function analyticsAuthorityKey(
  tenantId: string,
  userId: string,
  role: RoleKey,
  viewerMode: boolean,
): string {
  return `${tenantId}:${userId}:${role ?? "unresolved"}:${viewerMode}`;
}

export function analyticsAuthorityFrom(
  identity: MeResponse | null | undefined,
): AnalyticsAuthority {
  const tenantId = identity?.tenant_id ?? "anon";
  const userId = identity?.user_id ?? "unverified";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  return {
    tenantId,
    userId,
    role,
    viewerMode,
    authorityKey: analyticsAuthorityKey(tenantId, userId, role, viewerMode),
  };
}

export function analyticsIdentitySuffix(
  authority: AnalyticsAuthority,
): readonly [string, "viewer" | "member"] {
  return [authority.userId, authority.viewerMode ? "viewer" : "member"];
}

export function analyticsAuthorityReady(
  authority: AnalyticsAuthority,
): boolean {
  return (
    authority.tenantId !== "anon" &&
    authority.userId !== "unverified" &&
    authority.role !== null
  );
}

export function assertAnalyticsWriteAllowed(
  authority: AnalyticsAuthority,
): void {
  if (!analyticsAuthorityReady(authority)) {
    throw new Error("Your analytics identity is still being verified.");
  }
  if (authority.viewerMode) {
    throw new Error(
      "Viewer mode is read-only. Exit viewer mode before changing analytics settings.",
    );
  }
}

export function analyticsCanWriteCampaigns(
  authority: AnalyticsAuthority,
): boolean {
  return (
    analyticsAuthorityReady(authority) &&
    !authority.viewerMode &&
    authority.role !== "viewer"
  );
}

export function assertAnalyticsCampaignWriteAllowed(
  authority: AnalyticsAuthority,
): void {
  assertAnalyticsWriteAllowed(authority);
  if (authority.role === "viewer") {
    throw new Error(
      "Your role is read-only. Ask an editor or workspace admin to generate analytics content.",
    );
  }
}

export function assertAnalyticsSignalActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    "The analytics operation was cancelled.",
    "AbortError",
  );
}

let activeAnalyticsController: AbortController | null = null;

/**
 * One synchronous lock shared by analytics AI, digest, and layout writes.
 * Acquiring the lock creates the controller that owns it; only that owner can
 * release it, so a late completion cannot unlock a newer operation.
 */
export function beginAnalyticsWrite(): AbortController | null {
  if (activeAnalyticsController) return null;
  activeAnalyticsController = new AbortController();
  return activeAnalyticsController;
}

export function endAnalyticsWrite(controller: AbortController): void {
  controller.abort();
  if (activeAnalyticsController === controller) {
    activeAnalyticsController = null;
  }
}

export function abortAnalyticsWrite(): void {
  activeAnalyticsController?.abort();
  activeAnalyticsController = null;
}

export async function verifyAnalyticsAuthority(
  expected: AnalyticsAuthority,
  signal: AbortSignal,
): Promise<void> {
  assertAnalyticsSignalActive(signal);
  assertAnalyticsWriteAllowed(expected);
  const fresh = await whoamiFresh(signal);
  assertAnalyticsSignalActive(signal);
  const actual = analyticsAuthorityFrom(fresh);
  if (actual.viewerMode || actual.authorityKey !== expected.authorityKey) {
    throw new Error("Your analytics access changed. Refresh and try again.");
  }
}
