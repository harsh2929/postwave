import type { Campaign } from "../../lib/api-client";
import { api } from "../../lib/api-client";
import { toast } from "../../components/Toast";
import {
  type CampaignSortKey,
  campaignRowId,
  escapeCampaignCsvCell,
} from "./campaigns-page-utils";
import type { CampaignsData } from "./useCampaignsData";
import type { CampaignsState } from "./useCampaignsState";
import type { CampaignsViewModel } from "./useCampaignsViewModel";

export function buildCampaignCsv(campaigns: Campaign[]): string {
  const header = [
    "name",
    "subject",
    "status",
    "sent_at",
    "open_rate",
    "click_rate",
  ];
  const lines = [header.join(",")];
  for (const campaign of campaigns) {
    lines.push(
      [
        campaign.name,
        campaign.subject,
        campaign.status,
        campaign.sent_at,
        campaign.open_rate,
        campaign.click_rate,
      ]
        .map(escapeCampaignCsvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export function useCampaignBulkActions(
  state: CampaignsState,
  data: CampaignsData,
  view: CampaignsViewModel,
  authority: {
    readonly current: {
      canMutateCampaignSnapshot: boolean;
      campaignMutationUnavailableReason?: string | null;
    };
  },
) {
  const selectedRows = (): Campaign[] =>
    (state.rows ?? []).filter((campaign) =>
      state.selectedIds.has(campaignRowId(campaign)),
    );
  const clearSelection = (): void => state.setSelectedIds(new Set());
  const removeConfirmedSelections = (confirmedIds: Set<string>): void => {
    if (confirmedIds.size === 0) return;
    state.setSelectedIds((previous) => {
      const next = new Set(previous);
      confirmedIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  const toggleSort = (key: CampaignSortKey): void => {
    if (state.sortBy === key) {
      state.setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      state.setSortBy(key);
      state.setSortDir(key === "name" || key === "status" ? "asc" : "desc");
    }
    state.setPage(1);
  };

  const toggleSelect = (id: string): void => {
    state.setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (): void => {
    state.setSelectedIds((previous) => {
      const next = new Set(previous);
      if (view.allPageSelected) {
        view.pageRows.forEach((campaign) =>
          next.delete(campaignRowId(campaign)),
        );
      } else {
        view.pageRows.forEach((campaign) => next.add(campaignRowId(campaign)));
      }
      return next;
    });
  };

  const promptBulkDelete = (): void => {
    if (!authority.current.canMutateCampaignSnapshot) return;
    const targets = selectedRows();
    if (targets.length === 0) return;
    state.setPendingBulkDeleteCount(targets.length);
  };

  const bulkDelete = async (): Promise<void> => {
    if (!authority.current.canMutateCampaignSnapshot) {
      state.setPendingBulkDeleteCount(null);
      return;
    }
    const targets = selectedRows();
    if (targets.length === 0) {
      state.setPendingBulkDeleteCount(null);
      return;
    }
    state.setBulkBusy(true);
    let failed = 0;
    let authorityLost = false;
    const confirmedIds = new Set<string>();
    for (const campaign of targets) {
      if (!authority.current.canMutateCampaignSnapshot) {
        authorityLost = true;
        break;
      }
      const response = await api.deleteCampaign(campaign.id as string | number);
      if (response.error) failed += 1;
      else confirmedIds.add(campaignRowId(campaign));
    }
    state.setBulkBusy(false);
    state.setPendingBulkDeleteCount(null);
    removeConfirmedSelections(confirmedIds);
    if (authorityLost) {
      toast.info({
        message: "Bulk delete stopped when campaign authority changed",
        detail: `${confirmedIds.size} deleted; ${targets.length - confirmedIds.size} failed or unprocessed campaign${targets.length - confirmedIds.size === 1 ? " remains" : "s remain"} selected. ${authority.current.campaignMutationUnavailableReason ?? "Refresh campaigns and confirm your access before retrying."}`,
      });
    } else if (failed > 0) {
      toast.error(
        `${failed} couldn't be deleted. Failed campaigns remain selected.`,
      );
    } else {
      toast.success(`${confirmedIds.size} deleted`);
    }
    if (confirmedIds.size > 0) await data.load();
  };

  const bulkMove = async (): Promise<void> => {
    if (!authority.current.canMutateCampaignSnapshot) {
      state.setBulkMoveOpen(false);
      return;
    }
    const targets = selectedRows();
    if (targets.length === 0) return;
    state.setBulkBusy(true);
    let failed = 0;
    let authorityLost = false;
    const confirmedIds = new Set<string>();
    for (const campaign of targets) {
      if (!authority.current.canMutateCampaignSnapshot) {
        authorityLost = true;
        break;
      }
      const response = await api.moveCampaignToFolder(
        campaign.id as string | number,
        state.bulkMovePick,
      );
      if (response.error) failed += 1;
      else confirmedIds.add(campaignRowId(campaign));
    }
    state.setBulkBusy(false);
    state.setBulkMoveOpen(false);
    removeConfirmedSelections(confirmedIds);
    if (authorityLost) {
      toast.info({
        message: "Bulk move stopped when campaign authority changed",
        detail: `${confirmedIds.size} moved; ${targets.length - confirmedIds.size} failed or unprocessed campaign${targets.length - confirmedIds.size === 1 ? " remains" : "s remain"} selected. ${authority.current.campaignMutationUnavailableReason ?? "Refresh campaigns and confirm your access before retrying."}`,
      });
    } else if (failed > 0) {
      toast.error(
        `${failed} couldn't be moved. Failed campaigns remain selected.`,
      );
    } else {
      toast.success(`${confirmedIds.size} moved`);
    }
    if (confirmedIds.size > 0) await data.load();
  };

  const promptBulkTag = (): void => {
    if (!authority.current.canMutateCampaignSnapshot) return;
    const targets = selectedRows();
    if (targets.length === 0) return;
    state.setBulkTagValue("");
    state.setBulkTagOpen(true);
  };

  const bulkTag = async (): Promise<void> => {
    if (!authority.current.canMutateCampaignSnapshot) {
      state.setBulkTagOpen(false);
      return;
    }
    const targets = selectedRows();
    if (targets.length === 0) return;
    const tag = state.bulkTagValue.trim();
    if (!tag) return;
    state.setBulkBusy(true);
    const ids = targets.map((campaign) => String(campaign.id)).filter(Boolean);
    const response = await api.bulkTagCampaigns(ids, tag);
    state.setBulkBusy(false);
    state.setBulkTagOpen(false);
    state.setBulkTagValue("");
    if (response.error) {
      toast.error(`Couldn't tag: ${response.error.message}`);
      return;
    }
    clearSelection();
    toast.success(`Tagged ${response.data.tagged} with "${response.data.tag}"`);
  };

  const bulkExportCsv = async (): Promise<void> => {
    const targets = selectedRows();
    if (targets.length === 0) return;
    const { saveFile } = await import("../../lib/file-transfer");
    const saved = await saveFile({
      data: buildCampaignCsv(targets),
      suggestedName: `campaigns-export-${targets.length}.csv`,
      label: "Campaigns export",
      privacy: "personal",
      mimeType: "text/csv;charset=utf-8",
    });
    if (!saved.ok) toast.error(saved.message);
    else if (saved.status !== "cancelled") {
      toast.success(`Exported ${targets.length} to CSV`);
    }
  };

  return {
    bulkDelete,
    bulkExportCsv,
    bulkMove,
    bulkTag,
    clearSelection,
    promptBulkDelete,
    promptBulkTag,
    selectedRows,
    toggleSelect,
    toggleSelectAll,
    toggleSort,
  };
}

export type CampaignBulkActions = ReturnType<typeof useCampaignBulkActions>;
