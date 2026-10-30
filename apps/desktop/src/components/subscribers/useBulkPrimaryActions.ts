import {
  api,
  type Subscriber,
  type SubscriberBulkResult,
} from "../../lib/api-client";
import { toast } from "../Toast";
import {
  bulkRequestFailureMessage,
  runBulkRequest,
  showBulkUndoToast,
  type BulkRequestResult,
} from "./bulk-action-effects";
import {
  parseBulkTags,
  selectedSubscriberIds,
  type BulkActionBarProps,
  type BulkActionUiState,
} from "./bulk-action-types";

interface BulkPrimaryActionsInput {
  selected: Subscriber[];
  onDone: BulkActionBarProps["onDone"];
  state: BulkActionUiState;
}

export interface BulkPrimaryActions {
  addTag: () => Promise<void>;
  suppress: () => Promise<void>;
  bulkDelete: () => Promise<void>;
}

export function useBulkPrimaryActions({
  selected,
  onDone,
  state,
}: BulkPrimaryActionsInput): BulkPrimaryActions {
  const ids = selectedSubscriberIds(selected);
  const locallyExcluded = selected.length - ids.length;

  async function runTags(tags: string[], startIndex: number): Promise<void> {
    const signal = state.beginOperation("tag", {
      current: startIndex,
      total: tags.length,
      label: "Tagging",
    });
    if (!signal) return;
    state.setShowTag(false);
    let last: SubscriberBulkResult | null = null;
    for (let index = startIndex; index < tags.length; index += 1) {
      const tag = tags[index]!;
      const result = await runBulkRequest(
        () => api.bulkTagSubscribers({ subscriber_ids: ids, tag }),
        {
          signal,
          setProgress: state.setProgress,
          label: "Tagging",
          automaticRetry: true,
        },
      );
      if (result.status !== "success") {
        state.finishOperation(signal);
        const completed = index;
        const remaining = tags.length - index;
        const scope = `${ids.length.toLocaleString()} subscriber${ids.length === 1 ? "" : "s"}`;
        if (result.status === "cancelled") {
          state.setOutcome({
            tone: "info",
            title: "Automatic tag retry cancelled",
            focusOnRender: true,
            message: `${completed} of ${tags.length} tag steps completed. ${remaining} tag step${remaining === 1 ? " remains" : "s remain"} for the retained ${scope} scope.`,
            retry: {
              label: `Resume ${remaining} remaining tag step${remaining === 1 ? "" : "s"}`,
              run: () => void runTags(tags, index),
            },
          });
          return;
        }
        const detail = bulkRequestFailureMessage(
          result,
          `tagging with “${tag}”`,
        );
        state.setOutcome({
          tone: completed > 0 ? "warning" : "error",
          title:
            completed > 0 ? "Tagging partially completed" : "Tagging failed",
          message: `${completed} of ${tags.length} tag steps completed for ${scope}. ${detail}`,
          retry: {
            label: `Retry ${remaining} remaining tag step${remaining === 1 ? "" : "s"} for ${ids.length}`,
            run: () => void runTags(tags, index),
          },
        });
        toast.error(`Couldn't finish tagging. ${detail}`);
        return;
      }
      last = result.data;
      state.setProgress((progress) =>
        progress ? { ...progress, current: index + 1 } : progress,
      );
    }

    state.finishOperation(signal);
    state.setTagInput("");
    const scopeCopy = bulkSuccessScope(ids.length, locallyExcluded, last);
    if (last && tags.length === 1) {
      showBulkUndoToast(onDone, `Tagged ${scopeCopy}`, last);
    } else {
      toast.success(
        `Added ${tags.length.toLocaleString()} tags across ${scopeCopy}. Multi-tag undo is unavailable because each tag has a separate recovery receipt.`,
      );
    }
    onDone(false);
  }

  async function addTag(): Promise<void> {
    const tags = parseBulkTags(state.tagInput);
    if (tags.length === 0) {
      toast.error("Enter at least one tag.");
      return;
    }
    if (ids.length === 0) {
      toast.error("None of the selected rows carry an id.");
      return;
    }
    await runTags(tags, 0);
  }

  async function suppress(): Promise<void> {
    if (ids.length === 0) {
      toast.error("None of the selected rows carry an id.");
      return;
    }
    const signal = state.beginOperation("suppress", {
      current: 0,
      total: 1,
      label: "Suppressing",
    });
    if (!signal) return;
    state.setShowSuppress(false);
    const result = await runBulkRequest(
      () => api.bulkUnsubscribeSubscribers({ subscriber_ids: ids }),
      {
        signal,
        setProgress: state.setProgress,
        label: "Suppressing",
        automaticRetry: true,
      },
    );
    state.finishOperation(signal);
    if (result.status !== "success") {
      showRetryableFailure(result, "suppression", "Suppress", suppress);
      return;
    }
    toast.success(
      `Suppressed ${bulkSuccessScope(ids.length, locallyExcluded, result.data)}. Consent withdrawal recorded; reactivation requires a reviewed consent receipt.`,
    );
    onDone(false);
  }

  async function bulkDelete(): Promise<void> {
    if (ids.length === 0) {
      toast.error("None of the selected rows carry an id.");
      return;
    }
    const signal = state.beginOperation("delete", {
      current: 0,
      total: 1,
      label: "Deleting",
    });
    if (!signal) return;
    state.setShowDelete(false);
    const result = await runBulkRequest(
      () => api.bulkDeleteSubscribers({ subscriber_ids: ids }),
      {
        signal,
        setProgress: state.setProgress,
        label: "Deleting",
        automaticRetry: true,
      },
    );
    state.finishOperation(signal);
    if (result.status !== "success") {
      showRetryableFailure(result, "deletion", "Delete", bulkDelete);
      return;
    }
    toast.success(
      `Permanently erased ${bulkSuccessScope(ids.length, locallyExcluded, result.data)}. Every known address remains suppressed; no recovery copy was created.`,
    );
    onDone(false);
  }

  function showRetryableFailure<T>(
    result: Exclude<BulkRequestResult<T>, { status: "success" }>,
    noun: string,
    retryLabel: string,
    retry: () => Promise<void>,
  ): void {
    const count = ids.length.toLocaleString();
    if (result.status === "cancelled") {
      state.setOutcome({
        tone: "info",
        title: `Automatic ${noun} retry cancelled`,
        focusOnRender: true,
        message: `No outcome was confirmed for the retained scope of ${count} subscriber${ids.length === 1 ? "" : "s"}.`,
        retry: {
          label: `${retryLabel} retained scope (${count})`,
          run: () => void retry(),
        },
      });
      return;
    }
    const detail = bulkRequestFailureMessage(result, noun);
    state.setOutcome({
      tone: "error",
      title: `${capitalize(noun)} not confirmed`,
      message: `${detail} The exact ${count}-subscriber scope remains selected for an explicit retry.`,
      retry: {
        label: `${retryLabel} retained scope (${count})`,
        run: () => void retry(),
      },
    });
    toast.error(detail);
  }

  return { addTag, suppress, bulkDelete };
}

function bulkSuccessScope(
  requested: number,
  locallyExcluded: number,
  result: SubscriberBulkResult | null,
): string {
  const affected = result?.affected ?? requested;
  const skipped = result?.skipped ?? 0;
  const suffix = [
    skipped > 0 ? `${skipped.toLocaleString()} unchanged by server checks` : "",
    locallyExcluded > 0
      ? `${locallyExcluded.toLocaleString()} id-less selection${locallyExcluded === 1 ? "" : "s"} excluded before submission`
      : "",
  ].filter(Boolean);
  return `${affected.toLocaleString()} subscriber${affected === 1 ? "" : "s"}${suffix.length > 0 ? `; ${suffix.join("; ")}` : ""}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
