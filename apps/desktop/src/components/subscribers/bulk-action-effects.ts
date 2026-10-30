import type { Dispatch, SetStateAction } from "react";

import {
  api,
  type ApiResult,
  type SubscriberBulkResult,
} from "../../lib/api-client";
import { toast } from "../Toast";
import { bulkRetryAfter, type BulkProgress } from "./bulk-action-types";

export const BULK_MAX_ATTEMPTS = 3;
export const BULK_MAX_AUTOMATIC_RETRY_DELAY_SECONDS = 60;

type BulkApiError<T> = Extract<ApiResult<T>, { error: unknown }>["error"];

export type BulkRequestResult<T> =
  | { status: "success"; data: T; attempts: number }
  | { status: "cancelled"; attempts: number }
  | {
      status: "failed";
      error: BulkApiError<T>;
      attempts: number;
      retryAfterSeconds?: number;
      stoppedBecause?: "manual_only" | "delay_too_long" | "max_attempts";
    };

export function bulkRequestFailureMessage<T>(
  result: Extract<BulkRequestResult<T>, { status: "failed" }>,
  action: string,
): string {
  const wait = result.retryAfterSeconds;
  if (result.stoppedBecause === "manual_only") {
    return `Rate limited after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}. No automatic retry occurred because replaying ${action} requires an operator decision.${wait ? ` The server requested a ${wait}s wait.` : ""}`;
  }
  if (result.stoppedBecause === "delay_too_long") {
    return `Rate limited. No automatic retry occurred because the server requested a ${wait}s wait. Retry this exact scope when the window has passed.`;
  }
  if (result.stoppedBecause === "max_attempts") {
    return `Rate limited after ${result.attempts} attempts. Automatic retry stopped at the safety limit; this scope was not confirmed.`;
  }
  return `The server did not confirm ${action}: ${result.error.message}`;
}

interface RunBulkRequestOptions {
  signal: AbortSignal;
  setProgress: Dispatch<SetStateAction<BulkProgress | null>>;
  label: string;
  /** False for writes where replay could create duplicate durable evidence. */
  automaticRetry: boolean;
  maxAttempts?: number;
}

/**
 * Owns the complete 429 lifecycle. It never overlaps attempts, only retries a
 * confirmed 429, honours a bounded Retry-After countdown, and can be cancelled
 * while waiting. Other failures are returned untouched for explicit recovery.
 */
export async function runBulkRequest<T>(
  request: () => Promise<ApiResult<T>>,
  options: RunBulkRequestOptions,
): Promise<BulkRequestResult<T>> {
  const maxAttempts = options.maxAttempts ?? BULK_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal.aborted)
      return { status: "cancelled", attempts: attempt - 1 };
    options.setProgress((progress) =>
      progress
        ? {
            ...progress,
            attempt,
            maxAttempts,
            retrySeconds: undefined,
          }
        : progress,
    );
    let result: ApiResult<T>;
    try {
      result = await request();
    } catch {
      return {
        status: "failed",
        attempts: attempt,
        error: {
          message: "The request ended before the server confirmed an outcome.",
          kind: "network",
        },
      };
    }
    if (!result.error) {
      if (options.signal.aborted) {
        return { status: "cancelled", attempts: attempt };
      }
      return { status: "success", data: result.data, attempts: attempt };
    }

    const retryAfterSeconds = bulkRetryAfter(result);
    if (retryAfterSeconds == null) {
      return { status: "failed", error: result.error, attempts: attempt };
    }
    const transportRequiresManualRetry =
      result.retryability != null && result.retryability !== "automatic";
    if (!options.automaticRetry || transportRequiresManualRetry) {
      return {
        status: "failed",
        error: result.error,
        attempts: attempt,
        retryAfterSeconds,
        stoppedBecause: "manual_only",
      };
    }
    if (attempt >= maxAttempts) {
      return {
        status: "failed",
        error: result.error,
        attempts: attempt,
        retryAfterSeconds,
        stoppedBecause: "max_attempts",
      };
    }
    const delaySeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    if (delaySeconds > BULK_MAX_AUTOMATIC_RETRY_DELAY_SECONDS) {
      return {
        status: "failed",
        error: result.error,
        attempts: attempt,
        retryAfterSeconds: delaySeconds,
        stoppedBecause: "delay_too_long",
      };
    }
    toast.info(
      `Rate limited while ${options.label.toLowerCase()}. Automatic attempt ${attempt + 1} of ${maxAttempts} starts in ${delaySeconds}s; you can cancel the wait.`,
    );
    const waited = await waitForBulkRetry(
      delaySeconds,
      options.signal,
      options.setProgress,
    );
    if (!waited) return { status: "cancelled", attempts: attempt };
  }
  return { status: "cancelled", attempts: maxAttempts };
}

async function waitForBulkRetry(
  seconds: number,
  signal: AbortSignal,
  setProgress: Dispatch<SetStateAction<BulkProgress | null>>,
): Promise<boolean> {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    setProgress((progress) =>
      progress ? { ...progress, retrySeconds: remaining } : progress,
    );
    if (!(await cancellableDelay(signal))) return false;
  }
  return true;
}

function cancellableDelay(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = globalThis.setTimeout(() => finish(true), 1_000);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function showBulkUndoToast(
  onDone: (skipReload?: boolean) => void,
  message: string,
  result: SubscriberBulkResult,
): void {
  const token = result.recovery_token;
  toast.success({
    message,
    action: token
      ? {
          label: "Undo",
          onClick: () => {
            void api
              .bulkRecoverSubscribers({ recovery_token: token })
              .then((recovery) => {
                if (recovery.error) {
                  toast.error(`Couldn't undo: ${recovery.error.message}`);
                  return;
                }
                if (
                  recovery.data.source === "recovery" &&
                  recovery.data.affected === 0
                ) {
                  toast.info("The undo window has closed.");
                  return;
                }
                toast.success(
                  `Restored ${recovery.data.affected.toLocaleString()} subscriber${recovery.data.affected === 1 ? "" : "s"}`,
                );
                onDone(false);
              });
          },
        }
      : undefined,
  });
}
