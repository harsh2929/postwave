import { useState } from "react";

import { useFormErrors } from "../../components/FormField";
import type {
  ABMetric,
  ABResultsResponse,
  ABWeightHistorySeries,
  Campaign,
  CampaignFolder,
} from "../../lib/api-client";
import type {
  CampaignBodyTab,
  CampaignDraft,
  CampaignFilter,
  CampaignSortKey,
  CampaignViewMode,
} from "./campaigns-page-utils";

export function useCampaignsState(initialRows: () => Campaign[] | null) {
  const [rows, setRows] = useState<Campaign[] | null>(initialRows);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastConfirmedAt, setLastConfirmedAt] = useState<Date | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CampaignFilter>("all");
  const [viewMode, setViewMode] = useState<CampaignViewMode>("list");
  const [abFromNames, setAbFromNames] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [draft, setDraft] = useState<CampaignDraft>({
    name: "",
    subject: "",
    fromEmail: "",
    body: "",
    previewText: "",
  });
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const errors = useFormErrors();
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [bodyTab, setBodyTab] = useState<CampaignBodyTab>("edit");
  const [abModalCampaign, setAbModalCampaign] = useState<Campaign | null>(null);
  const [abMetric, setAbMetric] = useState<ABMetric>("open_rate");
  const [abData, setAbData] = useState<ABResultsResponse | null>(null);
  const [abWeightHistory, setAbWeightHistory] = useState<
    ABWeightHistorySeries[]
  >([]);
  const [abLoading, setAbLoading] = useState(false);
  const [abErr, setAbErr] = useState<string | null>(null);
  const [folders, setFolders] = useState<CampaignFolder[]>([]);
  const [folderFilter, setFolderFilter] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [moveTarget, setMoveTarget] = useState<Campaign | null>(null);
  const [movePick, setMovePick] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<CampaignSortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMovePick, setBulkMovePick] = useState("");
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagValue, setBulkTagValue] = useState("");
  const [pendingBulkDeleteCount, setPendingBulkDeleteCount] = useState<
    number | null
  >(null);
  const [cloningId, setCloningId] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<Campaign | null>(null);
  const [resendSubject, setResendSubject] = useState("");
  const [resendErr, setResendErr] = useState<string | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [pendingDeepLinkId, setPendingDeepLinkId] = useState<string | null>(
    null,
  );

  return {
    abData,
    abErr,
    abFromNames,
    abLoading,
    abMetric,
    abModalCampaign,
    abWeightHistory,
    assistantOpen,
    bodyTab,
    bulkBusy,
    bulkMoveOpen,
    bulkMovePick,
    bulkTagOpen,
    bulkTagValue,
    cloningId,
    createOpen,
    draft,
    err,
    errors,
    filter,
    folderFilter,
    folders,
    labOpen,
    lastConfirmedAt,
    loading,
    movePick,
    moveTarget,
    newFolderName,
    page,
    pendingBulkDeleteCount,
    pendingDeepLinkId,
    query,
    refreshing,
    resendBusy,
    resendErr,
    resendSubject,
    resendTarget,
    rows,
    selected,
    selectedIds,
    stale,
    setAbData,
    setAbErr,
    setAbFromNames,
    setAbLoading,
    setAbMetric,
    setAbModalCampaign,
    setAbWeightHistory,
    setAssistantOpen,
    setBodyTab,
    setBulkBusy,
    setBulkMoveOpen,
    setBulkMovePick,
    setBulkTagOpen,
    setBulkTagValue,
    setCloningId,
    setCreateOpen,
    setDraft,
    setErr,
    setFilter,
    setFolderFilter,
    setFolders,
    setLabOpen,
    setLastConfirmedAt,
    setLoading,
    setMovePick,
    setMoveTarget,
    setNewFolderName,
    setPage,
    setPendingBulkDeleteCount,
    setPendingDeepLinkId,
    setQuery,
    setRefreshing,
    setResendBusy,
    setResendErr,
    setResendSubject,
    setResendTarget,
    setRows,
    setSelected,
    setSelectedIds,
    setSortBy,
    setSortDir,
    setSubmitErr,
    setSubmitting,
    setStale,
    setViewMode,
    sortBy,
    sortDir,
    submitErr,
    submitting,
    viewMode,
  };
}

export type CampaignsState = ReturnType<typeof useCampaignsState>;
