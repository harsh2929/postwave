import {
  api,
  type List,
  type Subscriber,
  type SubscriberBulkResult,
} from "../../lib/api-client";
import { toast } from "../Toast";
import {
  bulkRequestFailureMessage,
  runBulkRequest,
  type BulkRequestResult,
} from "./bulk-action-effects";
import {
  BULK_CONSENT_CATEGORIES,
  classifyResubscribeEligibility,
  selectedSubscriberIds,
  type BulkActionBarProps,
  type BulkActionUiState,
  type BulkBusy,
} from "./bulk-action-types";
import {
  consentEvidenceError,
  consentEvidencePayload,
} from "./consent-evidence";
import { engineStatusToUi } from "./subscriber-status";

interface BulkExtendedActionsInput {
  selected: Subscriber[];
  onDone: BulkActionBarProps["onDone"];
  state: BulkActionUiState;
}

export interface BulkExtendedActions {
  resubscribe: () => Promise<void>;
  addToList: () => Promise<void>;
  setCustomField: () => Promise<void>;
  updateMergeField: () => Promise<void>;
  applyConsent: (mode: "grant" | "revoke") => Promise<void>;
  exportCsv: (scope?: Subscriber[]) => Promise<void>;
}

export function useBulkExtendedActions(
  input: BulkExtendedActionsInput,
): BulkExtendedActions {
  return {
    resubscribe: () => resubscribeSubscribers(input),
    addToList: () => addSubscribersToList(input),
    setCustomField: () => setSubscribersCustomField(input),
    updateMergeField: () => updateSubscribersMergeField(input),
    applyConsent: (mode) => applySubscribersConsent(input, mode),
    exportCsv: (scope) => exportSubscribers(input, scope),
  };
}

async function resubscribeSubscribers(
  input: BulkExtendedActionsInput,
): Promise<void> {
  const { selected, onDone, state } = input;
  const eligibility = classifyResubscribeEligibility(selected);
  const ids = eligibility.eligibleIds;
  if (ids.length === 0) {
    toast.error(
      "No selected subscriber is locally eligible to resubscribe. Unknown, active, inactive, and unconfirmed records stay non-sendable.",
    );
    return;
  }
  const evidenceError = consentEvidenceError(state.consentEvidence, {
    requireEvidence: true,
    requireScope: true,
  });
  const evidence = consentEvidencePayload(state.consentEvidence);
  if (evidenceError || !evidence) {
    toast.error(evidenceError ?? "Complete the consent evidence.");
    return;
  }
  const expected = `RESUBSCRIBE ${ids.length}`;
  if (state.consentEvidence.confirmation.trim() !== expected) {
    toast.error(`Type ${expected} to confirm the reviewed scope.`);
    return;
  }
  const signal = begin(state, "resubscribe", "Resubscribing");
  if (!signal) return;
  state.setShowResubscribe(false);
  const result = await runBulkRequest(
    () => api.bulkResubscribeSubscribers({ subscriber_ids: ids, ...evidence }),
    {
      signal,
      setProgress: state.setProgress,
      label: "Resubscribing",
      automaticRetry: false,
    },
  );
  state.finishOperation(signal);
  if (result.status !== "success") {
    showFailure(state, result, {
      action: "resubscription",
      scopeCount: ids.length,
      retryLabel: "Retry reviewed resubscription",
      retry: () => resubscribeSubscribers(input),
    });
    return;
  }
  const excluded = Object.values(result.data.exclusions ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
  toast.success(
    `Resubscribed ${result.data.affected.toLocaleString()} subscriber${result.data.affected === 1 ? "" : "s"}${excluded > 0 ? `; ${excluded.toLocaleString()} excluded by server eligibility checks` : ""}`,
  );
  onDone(false);
}

async function addSubscribersToList(
  input: BulkExtendedActionsInput,
): Promise<void> {
  const { selected, onDone, state } = input;
  const ids = selectedSubscriberIds(selected);
  if (ids.length === 0) {
    toast.error("None of the selected rows carry an id.");
    return;
  }
  if (!state.listId) {
    toast.error("Pick a list.");
    return;
  }
  const chosenListId = state.listId;
  const chosenListName = listName(state.lists, chosenListId);
  const signal = begin(state, "addToList", "Adding to list");
  if (!signal) return;
  state.setShowAddToList(false);
  const result = await runBulkRequest(
    () =>
      api.bulkAddToListSubscribers({
        subscriber_ids: ids,
        list_id: chosenListId,
      }),
    {
      signal,
      setProgress: state.setProgress,
      label: "Adding to list",
      automaticRetry: true,
    },
  );
  state.finishOperation(signal);
  if (result.status !== "success") {
    showFailure(state, result, {
      action: `adding to ${chosenListName}`,
      scopeCount: ids.length,
      retryLabel: `Retry add to ${chosenListName}`,
      retry: () => addSubscribersToList(input),
    });
    return;
  }
  toast.success(
    bulkResultCopy(`Added to ${chosenListName}`, result.data, ids.length),
  );
  onDone(false);
}

async function setSubscribersCustomField(
  input: BulkExtendedActionsInput,
): Promise<void> {
  const { selected, onDone, state } = input;
  const ids = selectedSubscriberIds(selected);
  const key = state.cfKey.trim();
  if (!key) {
    toast.error("Enter a field key.");
    return;
  }
  if (ids.length === 0) {
    toast.error("None of the selected rows carry an id.");
    return;
  }
  const value = state.cfValue;
  const signal = begin(state, "customField", "Updating custom field");
  if (!signal) return;
  state.setShowCustomField(false);
  const result = await runBulkRequest(
    () =>
      api.bulkSetCustomFieldSubscribers({ subscriber_ids: ids, key, value }),
    {
      signal,
      setProgress: state.setProgress,
      label: "Updating custom field",
      automaticRetry: true,
    },
  );
  state.finishOperation(signal);
  if (result.status !== "success") {
    showFailure(state, result, {
      action: `setting custom field ${key}`,
      scopeCount: ids.length,
      retryLabel: `Retry ${key} update`,
      retry: () => setSubscribersCustomField(input),
    });
    return;
  }
  state.setCfKey("");
  state.setCfValue("");
  toast.success(bulkResultCopy(`Set ${key}`, result.data, ids.length));
  onDone(false);
}

async function updateSubscribersMergeField(
  input: BulkExtendedActionsInput,
): Promise<void> {
  const { selected, onDone, state } = input;
  const ids = selectedSubscriberIds(selected);
  if (ids.length === 0) {
    toast.error("None of the selected rows carry an id.");
    return;
  }
  const key = state.mfKey;
  const value = state.mfValue;
  const signal = begin(state, "mergeField", "Updating merge field");
  if (!signal) return;
  state.setShowMergeField(false);
  const result = await runBulkRequest(
    () =>
      api.bulkUpdateMergeFieldSubscribers({
        subscriber_ids: ids,
        key,
        value,
      }),
    {
      signal,
      setProgress: state.setProgress,
      label: "Updating merge field",
      automaticRetry: true,
    },
  );
  state.finishOperation(signal);
  if (result.status !== "success") {
    showFailure(state, result, {
      action: `updating merge field ${key}`,
      scopeCount: ids.length,
      retryLabel: `Retry ${key} update`,
      retry: () => updateSubscribersMergeField(input),
    });
    return;
  }
  state.setMfValue("");
  toast.success(bulkResultCopy(`Updated ${key}`, result.data, ids.length));
  onDone(false);
}

async function applySubscribersConsent(
  input: BulkExtendedActionsInput,
  mode: "grant" | "revoke",
): Promise<void> {
  const { selected, onDone, state } = input;
  const unknown = selected.filter(
    (subscriber) => engineStatusToUi(subscriber.status) === "unknown",
  ).length;
  const ids = selected.flatMap((subscriber) =>
    subscriber.id == null || engineStatusToUi(subscriber.status) === "unknown"
      ? []
      : [String(subscriber.id)],
  );
  if (ids.length === 0) {
    toast.error(
      "No selected subscriber has a recognized status and stable id. Reconcile unknown records before changing consent.",
    );
    return;
  }
  const evidenceError = consentEvidenceError(state.consentEvidence, {
    requireEvidence: mode === "grant",
    requireScope: true,
  });
  const evidence = consentEvidencePayload(state.consentEvidence);
  if (evidenceError || !evidence) {
    toast.error(evidenceError ?? "Complete the consent evidence.");
    return;
  }
  const expected = `${mode === "grant" ? "GRANT" : "REVOKE"} ${ids.length}`;
  if (state.consentEvidence.confirmation.trim() !== expected) {
    toast.error(`Type ${expected} to confirm the reviewed scope.`);
    return;
  }
  const kind = mode === "grant" ? "grantConsent" : "revokeConsent";
  const label = mode === "grant" ? "Granting consent" : "Revoking consent";
  const signal = begin(state, kind, label);
  if (!signal) return;
  state.setShowConsent(null);
  const payload = {
    subscriber_ids: ids,
    category: state.consentCategory,
    ...evidence,
  };
  const result = await runBulkRequest(
    () =>
      mode === "grant"
        ? api.bulkGrantConsentSubscribers(payload)
        : api.bulkRevokeConsentSubscribers(payload),
    {
      signal,
      setProgress: state.setProgress,
      label,
      automaticRetry: false,
    },
  );
  state.finishOperation(signal);
  if (result.status !== "success") {
    showFailure(state, result, {
      action: `${mode === "grant" ? "granting" : "revoking"} consent`,
      scopeCount: ids.length,
      retryLabel: `Retry reviewed consent ${mode}`,
      retry: () => applySubscribersConsent(input, mode),
    });
    return;
  }
  const verb = mode === "grant" ? "Granted" : "Revoked";
  const category = consentCategoryLabel(state);
  toast.success(
    `${bulkResultCopy(`${verb} ${category} for`, result.data, ids.length)}${unknown > 0 ? `; ${unknown.toLocaleString()} unknown-status record${unknown === 1 ? " was" : "s were"} excluded locally` : ""}`,
  );
  onDone(false);
}

async function exportSubscribers(
  input: BulkExtendedActionsInput,
  scope: Subscriber[] = input.selected,
): Promise<void> {
  const { state } = input;
  const frozenScope = scope.slice();
  const ids = selectedSubscriberIds(frozenScope);
  if (ids.length === 0) {
    toast.error("None of the selected rows carry an id.");
    return;
  }
  const signal = begin(state, "export", "Preparing export");
  if (!signal) return;
  const result = await runBulkRequest(
    () => api.bulkExportSubscribersBySegment({ subscriber_ids: ids }),
    {
      signal,
      setProgress: state.setProgress,
      label: "Preparing export",
      automaticRetry: true,
    },
  );
  if (result.status !== "success") {
    state.finishOperation(signal);
    showFailure(state, result, {
      action: "preparing the selected-subscriber export",
      scopeCount: ids.length,
      retryLabel: "Retry export",
      retry: () => exportSubscribers(input, frozenScope),
    });
    return;
  }
  await persistSubscribersExport(input, frozenScope, ids, signal, result.data);
}

async function persistSubscribersExport(
  input: BulkExtendedActionsInput,
  frozenScope: Subscriber[],
  ids: string[],
  signal: AbortSignal,
  data: { blob: Blob; filename: string },
): Promise<void> {
  const { state } = input;
  try {
    state.setProgress({ current: 0, total: 1, label: "Saving export" });
    const { saveFile } = await import("../../lib/file-transfer");
    const saved = await saveFile({
      data: data.blob,
      suggestedName: data.filename,
      label: "Selected subscribers export",
      privacy: "confidential",
      mimeType: "text/csv;charset=utf-8",
    });
    state.finishOperation(signal);
    if (
      (!saved.ok && saved.code === "cancelled") ||
      (saved.ok && saved.status === "cancelled")
    ) {
      return;
    }
    if (!saved.ok) {
      state.setOutcome({
        tone: "error",
        title: "Export was not saved",
        message: `${saved.message} The exact ${ids.length.toLocaleString()}-subscriber export scope is retained.`,
        retry: exportRetry(input, frozenScope, ids.length),
      });
      toast.error(saved.message);
      return;
    }
    if (saved.status === "download_started") {
      toast.info(
        "Selected-subscriber export download started. Check your browser's downloads for completion.",
      );
    } else {
      toast.success(
        `Selected-subscriber export saved for ${ids.length.toLocaleString()} subscriber${ids.length === 1 ? "" : "s"}.`,
      );
    }
  } catch {
    state.finishOperation(signal);
    state.setOutcome({
      tone: "error",
      title: "Export was not completed",
      message: `No file was confirmed for the retained ${ids.length.toLocaleString()}-subscriber scope.`,
      retry: exportRetry(input, frozenScope, ids.length),
    });
    toast.error("Couldn't complete the selected-subscriber export.");
  }
}

function showFailure<T>(
  state: BulkActionUiState,
  result: Exclude<BulkRequestResult<T>, { status: "success" }>,
  options: {
    action: string;
    scopeCount: number;
    retryLabel: string;
    retry: () => Promise<void>;
  },
): void {
  const scope = options.scopeCount.toLocaleString();
  if (result.status === "cancelled") {
    state.setOutcome({
      tone: "info",
      title: "Automatic retry cancelled",
      focusOnRender: true,
      message: `No outcome was confirmed for ${options.action}. The reviewed ${scope}-subscriber scope is retained.`,
      retry: {
        label: `${options.retryLabel} (${scope})`,
        run: () => void options.retry(),
      },
    });
    return;
  }
  const detail = bulkRequestFailureMessage(result, options.action);
  state.setOutcome({
    tone: "error",
    title: "Bulk action not confirmed",
    message: `${detail} The exact ${scope}-subscriber scope is retained for an explicit retry.`,
    retry: {
      label: `${options.retryLabel} (${scope})`,
      run: () => void options.retry(),
    },
  });
  toast.error(detail);
}

function begin(
  state: BulkActionUiState,
  kind: Exclude<BulkBusy, null>,
  label: string,
): AbortSignal | null {
  return state.beginOperation(kind, { current: 0, total: 1, label });
}

function exportRetry(
  input: BulkExtendedActionsInput,
  scope: Subscriber[],
  count: number,
): { label: string; run: () => void } {
  return {
    label: `Retry export (${count})`,
    run: () => void exportSubscribers(input, scope),
  };
}

function listName(lists: List[], listId: string): string {
  return (
    lists.find((list) => String(list.id) === listId)?.name ??
    "the selected list"
  );
}

function consentCategoryLabel(state: BulkActionUiState): string {
  return (
    BULK_CONSENT_CATEGORIES.find(
      (category) => category.value === state.consentCategory,
    )?.label ?? state.consentCategory
  );
}

function bulkResultCopy(
  prefix: string,
  result: SubscriberBulkResult,
  requested: number,
): string {
  const skipped = result.skipped ?? Math.max(0, requested - result.affected);
  return `${prefix} ${result.affected.toLocaleString()} subscriber${result.affected === 1 ? "" : "s"}${skipped > 0 ? `; ${skipped.toLocaleString()} unchanged or excluded by server checks` : ""}`;
}
