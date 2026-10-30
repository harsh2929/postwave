// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  assertFreshCampaignWriteAuthority,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import { qk } from "@/lib/query-keys";

/**
 * Why a campaign-list write is refused while the list is a retained snapshot.
 * Mirrors desktop's `canMutateCampaignSnapshot`: a folder move or tag chosen
 * from rows the server could not re-confirm acts on a list the operator cannot
 * trust, so it waits for a successful refresh.
 */
export const CAMPAIGN_STALE_SNAPSHOT_MESSAGE =
  "Refresh campaigns before changing them. This list is the last-confirmed snapshot and may no longer match the server.";

export interface CampaignWriteGate {
  /** The opened identity may write campaigns. */
  canWrite: boolean;
  /** Why writes are withheld right now, or null when they are allowed. */
  blockedReason: string | null;
  /**
   * Re-read authority through the online-only boundary and compare it with
   * the identity that rendered the control — the same check the list page
   * runs before its own writes. Throws `CampaignWriteAuthorityError` (whose
   * message says nothing was changed) when the role, user or workspace moved.
   */
  confirmFresh: () => Promise<void>;
  /**
   * Cheap mid-run check for loops: the cached identity may have been replaced
   * by a fresh read elsewhere on the page. Never a network call.
   */
  stillAuthorized: () => boolean;
}

export function useCampaignWriteGate(
  identity: MeResponse | null | undefined,
  snapshotStale = false,
): CampaignWriteGate {
  const queryClient = useQueryClient();
  const canWrite = canWriteCampaigns(identity);
  const blockedReason = !canWrite
    ? CAMPAIGN_READ_ONLY_MESSAGE
    : snapshotStale
      ? CAMPAIGN_STALE_SNAPSHOT_MESSAGE
      : null;

  const confirmFresh = useCallback(async (): Promise<void> => {
    const fresh = await whoamiFresh();
    // Reflect a mid-session role/viewer-mode change everywhere at once, even
    // when the assertion below rejects the action opened under older access.
    queryClient.setQueryData(qk.authMe(), fresh);
    assertFreshCampaignWriteAuthority(identity, fresh);
  }, [identity, queryClient]);

  const stillAuthorized = useCallback((): boolean => {
    const cached = queryClient.getQueryData<MeResponse>(qk.authMe());
    if (!cached) return canWriteCampaigns(identity);
    try {
      assertFreshCampaignWriteAuthority(identity, cached);
      return true;
    } catch {
      return false;
    }
  }, [identity, queryClient]);

  return { canWrite, blockedReason, confirmFresh, stillAuthorized };
}
