import {
  emailValidationApi,
  type Subscriber,
} from "../../lib/api-client";
import { toast } from "../Toast";
import {
  bulkRequestFailureMessage,
  runBulkRequest,
  type BulkRequestResult,
} from "./bulk-action-effects";
import {
  type BulkActionUiState,
} from "./bulk-action-types";

interface BulkUtilityActionsInput {
  selected: Subscriber[];
  state: BulkActionUiState;
}

export interface BulkUtilityActions {
  validateEmails: () => Promise<void>;
}

export function useBulkUtilityActions({
  selected,
  state,
}: BulkUtilityActionsInput): BulkUtilityActions {
  async function validateEmails(): Promise<void> {
    const emails = selected.flatMap((subscriber) =>
      subscriber.email ? [subscriber.email] : [],
    );
    if (emails.length === 0) {
      toast.error("None of the selected rows carry an email address.");
      return;
    }
    const signal = state.beginOperation("validate", {
      current: 0,
      total: 1,
      label: "Validating emails",
    });
    if (!signal) return;
    const result = await runBulkRequest(
      () => emailValidationApi.checkBatch(emails),
      {
        signal,
        setProgress: state.setProgress,
        label: "Validating emails",
        automaticRetry: true,
      },
    );
    state.finishOperation(signal);
    if (result.status !== "success") {
      showFailure(result, "email validation", emails.length, validateEmails);
      return;
    }
    state.setValidationResult(result.data);
    state.setValidationSkipped(selected.length - emails.length);
    state.setShowValidation(true);
  }

  function showFailure<T>(
    result: Exclude<BulkRequestResult<T>, { status: "success" }>,
    action: string,
    scopeCount: number,
    retry: () => Promise<void>,
  ): void {
    if (result.status === "cancelled") {
      state.setOutcome({
        tone: "info",
        title: "Automatic retry cancelled",
        focusOnRender: true,
        message: `No outcome was confirmed for ${action}. The exact ${scopeCount}-subscriber scope is retained.`,
        retry: {
          label: `Retry retained scope (${scopeCount})`,
          run: () => void retry(),
        },
      });
      return;
    }
    const detail = bulkRequestFailureMessage(result, action);
    state.setOutcome({
      tone: "error",
      title: "Bulk action not confirmed",
      message: `${detail} The exact ${scopeCount}-subscriber scope is retained for an explicit retry.`,
      retry: {
        label: `Retry retained scope (${scopeCount})`,
        run: () => void retry(),
      },
    });
    toast.error(detail);
  }

  return { validateEmails };
}
