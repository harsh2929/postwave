import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useWriteDesktopTaskIntent } from "../../hooks/useDesktopTaskIntent";
import type { Campaign } from "../../lib/api-client";
import { qk } from "../../lib/query-keys";
import {
  useCanAdmin,
  useCanWrite,
  useMe,
  useRole,
  useRoleStatus,
} from "../../lib/store";
import { useCampaignBulkActions } from "./useCampaignBulkActions";
import { CAMPAIGN_COMPLETE_CACHE_SCOPE } from "./campaign-list-reconciliation";
import { useCampaignCreation } from "./useCampaignCreation";
import { useCampaignsData } from "./useCampaignsData";
import { createCampaignRowActions } from "./useCampaignRowActions";
import { useCampaignsState } from "./useCampaignsState";
import { useCampaignsViewModel } from "./useCampaignsViewModel";

interface CampaignSnapshotAuthorityInput {
  canMutate: boolean;
  canAdminMutate: boolean;
  roleStatus: "loading" | "resolved" | "unavailable";
  rowsAvailable: boolean;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | null;
}

export interface CampaignSnapshotMutationAuthority {
  canMutateCampaignSnapshot: boolean;
  canAdminMutateCampaignSnapshot: boolean;
  campaignMutationUnavailableReason: string | null;
  campaignAdminMutationUnavailableReason: string | null;
}

type CampaignMutationOverlaySetters = Pick<
  ReturnType<typeof useCampaignsState>,
  | "setMoveTarget"
  | "setBulkMoveOpen"
  | "setBulkTagOpen"
  | "setPendingBulkDeleteCount"
  | "setResendTarget"
>;

export function closeUnavailableCampaignMutationOverlays(
  state: CampaignMutationOverlaySetters,
  authority: Pick<
    CampaignSnapshotMutationAuthority,
    "canMutateCampaignSnapshot" | "canAdminMutateCampaignSnapshot"
  >,
): void {
  if (!authority.canMutateCampaignSnapshot) {
    state.setMoveTarget(null);
    state.setBulkMoveOpen(false);
    state.setBulkTagOpen(false);
    state.setPendingBulkDeleteCount(null);
  }
  if (!authority.canAdminMutateCampaignSnapshot) {
    state.setResendTarget(null);
  }
}

/**
 * A retained campaign list is useful for reading and export, but it is not
 * current authority for a mutation. Role and list freshness are deliberately
 * resolved together so controls and handlers cannot drift apart.
 */
export function resolveCampaignSnapshotMutationAuthority({
  canMutate,
  canAdminMutate,
  roleStatus,
  rowsAvailable,
  loading,
  refreshing,
  stale,
  error,
}: CampaignSnapshotAuthorityInput): CampaignSnapshotMutationAuthority {
  const snapshotReason = refreshing
    ? "Wait for the campaign refresh to finish before making changes."
    : stale
      ? "Refresh campaigns successfully before changing this retained snapshot."
      : loading || !rowsAvailable
        ? "Wait for Moosewave to confirm the current campaign list before making changes."
        : error
          ? "Retry the campaign refresh successfully before making changes."
          : null;
  const roleReason =
    roleStatus === "loading"
      ? "Wait for Moosewave to confirm your workspace permissions."
      : roleStatus !== "resolved"
        ? "Reconnect and confirm your workspace permissions before making changes."
        : null;
  const campaignMutationUnavailableReason =
    roleReason ??
    (!canMutate
      ? "Ask a workspace editor or admin for edit access."
      : snapshotReason);
  const campaignAdminMutationUnavailableReason =
    roleReason ??
    (!canAdminMutate
      ? "Ask a workspace admin to clone or resend campaigns."
      : snapshotReason);

  return {
    canMutateCampaignSnapshot: campaignMutationUnavailableReason === null,
    canAdminMutateCampaignSnapshot:
      campaignAdminMutationUnavailableReason === null,
    campaignMutationUnavailableReason,
    campaignAdminMutationUnavailableReason,
  };
}

export function useCampaignsController(identityScope: string | null) {
  const canMutate = useCanWrite();
  const canAdminMutate = useCanAdmin();
  const me = useMe();
  const role = useRole();
  const roleStatus = useRoleStatus();
  const tenantId = me?.tenant ?? null;
  const queryClient = useQueryClient();
  const state = useCampaignsState(() =>
    tenantId !== null && role !== null
      ? (queryClient.getQueryData<Campaign[]>(
          qk.campaigns(tenantId, role, CAMPAIGN_COMPLETE_CACHE_SCOPE),
        ) ?? null)
      : null,
  );
  const data = useCampaignsData(state, {
    canSeedTenantCache:
      tenantId !== null && role !== null && roleStatus !== "loading",
    queryClient,
    role,
    tenantId,
  });
  const creation = useCampaignCreation(state, data, canMutate, identityScope);
  useWriteDesktopTaskIntent({
    intent: "new-campaign",
    open: state.createOpen,
    canMutate,
    onOpen: creation.openCreate,
    onRouteExit: () => state.setCreateOpen(false),
  });
  const view = useCampaignsViewModel(state);
  const mutationAuthority = resolveCampaignSnapshotMutationAuthority({
    canMutate,
    canAdminMutate,
    roleStatus,
    rowsAvailable: state.rows !== null,
    loading: state.loading,
    refreshing: state.refreshing,
    stale: state.stale,
    error: state.err,
  });
  const mutationAuthorityRef = useRef(mutationAuthority);
  mutationAuthorityRef.current = mutationAuthority;
  const rowActions = createCampaignRowActions(
    state,
    data,
    mutationAuthorityRef,
  );
  const bulkActions = useCampaignBulkActions(
    state,
    data,
    view,
    mutationAuthorityRef,
  );

  useEffect(() => {
    closeUnavailableCampaignMutationOverlays(
      {
        setMoveTarget: state.setMoveTarget,
        setBulkMoveOpen: state.setBulkMoveOpen,
        setBulkTagOpen: state.setBulkTagOpen,
        setPendingBulkDeleteCount: state.setPendingBulkDeleteCount,
        setResendTarget: state.setResendTarget,
      },
      {
        canMutateCampaignSnapshot: mutationAuthority.canMutateCampaignSnapshot,
        canAdminMutateCampaignSnapshot:
          mutationAuthority.canAdminMutateCampaignSnapshot,
      },
    );
  }, [
    mutationAuthority.canAdminMutateCampaignSnapshot,
    mutationAuthority.canMutateCampaignSnapshot,
    state.setBulkMoveOpen,
    state.setBulkTagOpen,
    state.setMoveTarget,
    state.setPendingBulkDeleteCount,
    state.setResendTarget,
  ]);

  return {
    bulkActions,
    canAdminMutate,
    canMutate,
    ...mutationAuthority,
    creation,
    data,
    rowActions,
    state,
    view,
  };
}

export type CampaignsController = ReturnType<typeof useCampaignsController>;
