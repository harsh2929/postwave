import { useCallback, useEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";

import { redact } from "../../lib/auth";
import {
  type Campaign,
  api,
  getABResults,
  getABWeightHistory,
} from "../../lib/api-client";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../../lib/deep-link";
import { useEventSubscription } from "../../lib/event-bus";
import { qk } from "../../lib/query-keys";
import type { Role } from "../../lib/store";
import {
  consumePendingCampaignDraft,
  consumePendingTemplate,
} from "../../lib/template-handoff";
import { useQueryInvalidationReload } from "../../lib/use-query-invalidation-reload";
import { toast } from "../../components/Toast";
import {
  CAMPAIGN_COMPLETE_CACHE_SCOPE,
  CampaignReconciliationAbortError,
  reconcileAllCampaignPages,
} from "./campaign-list-reconciliation";
import type { CampaignsState } from "./useCampaignsState";

interface CampaignsDataContext {
  canSeedTenantCache: boolean;
  queryClient: QueryClient;
  role: Role | null;
  tenantId: string | null;
}

export function useCampaignsData(
  state: CampaignsState,
  context: CampaignsDataContext,
) {
  const rowsRef = useRef(state.rows);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadRequestRef = useRef(0);
  rowsRef.current = state.rows;

  const loadFolders = useCallback(async (): Promise<void> => {
    const response = await api.listCampaignFolders();
    if (!response.error && response.data) {
      state.setFolders(response.data.items ?? []);
    }
  }, [state.setFolders]);

  const load = useCallback(async (): Promise<Campaign[] | null> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const requestId = ++loadRequestRef.current;
    const retainedRows = rowsRef.current;
    const retainingSnapshot = retainedRows !== null;
    state.setLoading(!retainingSnapshot);
    state.setRefreshing(retainingSnapshot);
    state.setErr(null);
    let visible: Campaign[];
    try {
      visible = await reconcileAllCampaignPages(
        (page, perPage, signal) =>
          api.listCampaigns({ page, perPage }, { signal }),
        (signal) => api.countCampaigns({ signal }),
        controller.signal,
      );
    } catch (error) {
      if (
        error instanceof CampaignReconciliationAbortError ||
        controller.signal.aborted ||
        requestId !== loadRequestRef.current
      ) {
        return null;
      }
      state.setErr(
        redact(
          error instanceof Error
            ? error.message
            : "The campaign request failed.",
        ),
      );
      state.setStale(retainingSnapshot);
      state.setLoading(false);
      state.setRefreshing(false);
      return null;
    }
    if (controller.signal.aborted || requestId !== loadRequestRef.current) {
      return null;
    }
    rowsRef.current = visible;
    state.setRows(visible);
    if (
      context.canSeedTenantCache &&
      context.tenantId !== null &&
      context.role !== null
    ) {
      context.queryClient.setQueryData(
        qk.campaigns(
          context.tenantId,
          context.role,
          CAMPAIGN_COMPLETE_CACHE_SCOPE,
        ),
        visible,
      );
    }
    state.setLastConfirmedAt(new Date());
    state.setStale(false);
    state.setLoading(false);
    state.setRefreshing(false);
    return visible;
  }, [
    context.canSeedTenantCache,
    context.queryClient,
    context.role,
    context.tenantId,
    state.setErr,
    state.setLastConfirmedAt,
    state.setLoading,
    state.setRefreshing,
    state.setRows,
    state.setStale,
  ]);

  useEffect(() => {
    void loadFolders();
    // The folder catalog is a mount fetch; user actions call loadFolders
    // explicitly after mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadRequestRef.current += 1;
      loadAbortRef.current?.abort();
    };
    // Preserve the page's single mount reconciliation. Event-bus and query
    // invalidation hooks below own subsequent reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEventSubscription("campaign.*", () => {
    void load();
  });
  useQueryInvalidationReload("campaigns", () => {
    void load();
  });

  useEffect(() => {
    const accept = (target: { section: string; id: string } | null): void => {
      if (target && target.section === "campaigns" && target.id) {
        state.setPendingDeepLinkId(target.id);
      }
    };
    accept(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((target) => {
      if (target.section !== "campaigns") return;
      consumePendingDeepLinkTarget();
      accept(target);
    });
  }, [state.setPendingDeepLinkId]);

  useEffect(() => {
    if (!state.pendingDeepLinkId || !state.rows) return;
    if (
      state.selected?.id != null &&
      String(state.selected.id) !== state.pendingDeepLinkId
    ) {
      state.setPendingDeepLinkId(null);
      toast.error(
        "Close the open campaign before following a link to another campaign, then open the link again.",
      );
      return;
    }
    state.setPendingDeepLinkId(null);
    const match = state.rows.find(
      (campaign) => String(campaign.id) === state.pendingDeepLinkId,
    );
    if (match) {
      state.setSelected(match);
    } else {
      toast.error(
        "Couldn't find that campaign — it may have been deleted or you may no longer have access.",
      );
    }
  }, [
    state.pendingDeepLinkId,
    state.rows,
    state.selected,
    state.setPendingDeepLinkId,
    state.setSelected,
  ]);

  useEffect(() => {
    if (!state.abModalCampaign?.id) {
      state.setAbData(null);
      state.setAbWeightHistory([]);
      return;
    }
    let cancelled = false;
    state.setAbLoading(true);
    state.setAbErr(null);
    state.setAbWeightHistory([]);
    void (async () => {
      const results = await getABResults(
        String(state.abModalCampaign?.id),
        state.abMetric,
      );
      if (cancelled) return;
      state.setAbLoading(false);
      if (results.error) {
        state.setAbErr(results.error.message);
        state.setAbData(null);
      } else {
        state.setAbData(results.data);
      }
      const weights = await getABWeightHistory(
        String(state.abModalCampaign?.id),
      );
      if (!cancelled && !weights.error) {
        state.setAbWeightHistory(weights.data.series ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    state.abMetric,
    state.abModalCampaign,
    state.setAbData,
    state.setAbErr,
    state.setAbLoading,
    state.setAbWeightHistory,
  ]);

  useEffect(() => {
    const pendingDraft = consumePendingCampaignDraft();
    const template = consumePendingTemplate();
    if (pendingDraft) {
      state.setDraft({
        name: pendingDraft.name ?? "",
        subject: pendingDraft.subject ?? "",
        fromEmail: "",
        body: pendingDraft.body ?? "",
        previewText: pendingDraft.preview_text ?? "",
      });
      state.setSubmitErr(null);
      state.setBodyTab("edit");
      state.setCreateOpen(true);
      return;
    }
    if (template) {
      state.setDraft({
        name: template.name ?? "",
        subject: template.subject ?? "",
        fromEmail: "",
        body: template.body_html ?? "",
        previewText: template.preview_text ?? "",
      });
      state.setSubmitErr(null);
      state.setBodyTab("edit");
      state.setCreateOpen(true);
    }
  }, [
    state.setBodyTab,
    state.setCreateOpen,
    state.setDraft,
    state.setSubmitErr,
  ]);

  return { load, loadFolders };
}

export type CampaignsData = ReturnType<typeof useCampaignsData>;
