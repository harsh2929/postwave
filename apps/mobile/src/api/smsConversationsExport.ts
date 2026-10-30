/**
 * api/smsConversationsExport.ts — transport for the audited SMS conversations
 * CSV export.
 *
 * WHY THIS IS NOT `rawRequest`: the SDK client JSON-parses response bodies and
 * exposes no response headers, while this route answers `text/csv` whose TRUTH
 * HEADERS (row count, cutoff, truncation) are the part an auditor must see.
 * So it follows `api/sequenceDraft.ts`: the same auth material the SDK uses
 * (session cookie or bearer key + tenant slug + native client headers),
 * a bare fetch, and a bounded read.
 */
import { useAuthStore } from "@/store/auth";
import {
  parseSmsExportTruth,
  SMS_EXPORT_MAX_BYTES,
  smsExportReasonError,
  type SmsExportTruth,
} from "@/lib/smsExport";

import { NATIVE_CLIENT_HEADERS } from "./nativeClient";
import { apiUrl } from "./url";

/**
 * Two clocks, not one — the shape `api/complianceEvidence.ts` already uses for
 * the AIVS bundle, for the same reason.
 *
 * This export had NO timeout at all. The caller latches a spinner and disables
 * its button for the duration, so a connection that stalls after the SYN left
 * the operator on a permanently dead control with no way back but killing the
 * app. React Native's fetch inherits the platform socket timeouts, which are
 * minutes long on a captive-portal Wi-Fi and effectively never on a stalled
 * TLS handshake.
 *
 * The split matters: a workspace with a year of conversations produces a large
 * CSV, and a single deadline generous enough for those bytes would also be a
 * generous deadline for a connection that is simply dead. So the first clock
 * only has to cover "does the server answer", and the bytes get their own
 * budget once it has.
 */
const SMS_EXPORT_RESPONSE_TIMEOUT_MS = 30_000;
const SMS_EXPORT_BODY_TIMEOUT_MS = 120_000;
export const SMS_EXPORT_TIMEOUT_MESSAGE =
  "The export took too long to arrive and was stopped. Nothing was shared. Narrow the date range and try again.";

export interface SmsConversationsExport {
  csv: string;
  truth: SmsExportTruth;
  filename: string;
}

function resolveAuth(): {
  url: string;
  headers: Record<string, string>;
  sessionMode: boolean;
} | null {
  const { apiKey, baseUrl, mode, session, tenantId } = useAuthStore.getState();
  if (!baseUrl) return null;
  const authMode = mode ?? (apiKey ? "api_key" : null);
  if (!authMode) return null;
  const headers: Record<string, string> = {
    Accept: "text/csv",
    ...NATIVE_CLIENT_HEADERS,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey.startsWith("pw_") ? apiKey : `pw_${apiKey}`}`;
  }
  const tenantSlug =
    session?.workspaceSlug ?? (authMode === "api_key" ? tenantId : null);
  if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
  return {
    url: apiUrl(baseUrl, "/api/v1/sms/conversations.csv"),
    headers,
    sessionMode: authMode === "session",
  };
}

export async function exportSmsConversationsCsv(input: {
  reason: string;
  signal?: AbortSignal;
}): Promise<SmsConversationsExport> {
  const invalid = smsExportReasonError(input.reason);
  if (invalid) throw new Error(invalid);
  const auth = resolveAuth();
  if (!auth) {
    throw new Error("Sign in again before exporting.");
  }
  const controller = new AbortController();
  let timedOut = false;
  // The caller's own signal (a screen unmounting, a Cancel button) still has to
  // work, so it is forwarded rather than replaced. Either source aborts the
  // same request; only ours sets `timedOut`, which is what lets the catch tell
  // "we gave up waiting" apart from "the operator left".
  const abortFromCaller = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromCaller);
  if (input.signal?.aborted) controller.abort();
  let timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SMS_EXPORT_RESPONSE_TIMEOUT_MS);
  try {
    return await readExport(auth, input.reason, controller, () => {
      // The server answered; the remaining budget belongs to the BYTES, which
      // is a different amount of time. Restarting the clock here is what keeps
      // a large-but-healthy CSV from being killed by the response deadline.
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, SMS_EXPORT_BODY_TIMEOUT_MS);
    });
  } catch (err) {
    // A bare "Aborted" tells an auditor nothing about what to do next.
    if (timedOut) throw new Error(SMS_EXPORT_TIMEOUT_MESSAGE);
    throw err;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readExport(
  auth: NonNullable<ReturnType<typeof resolveAuth>>,
  reason: string,
  controller: AbortController,
  onResponse: () => void,
): Promise<SmsConversationsExport> {
  const response = await fetch(auth.url, {
    method: "GET",
    headers: {
      ...auth.headers,
      "X-Postwave-Audit-Reason": reason.trim(),
    },
    ...(auth.sessionMode ? { credentials: "include" as const } : {}),
    signal: controller.signal,
  });
  onResponse();
  if (!response.ok) {
    let message = `The export failed (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body; keep the status sentence */
    }
    throw new Error(message);
  }
  const truth = parseSmsExportTruth(response.headers);
  if (!truth) {
    throw new Error(
      "The export arrived without its verification headers, so its completeness cannot be shown. Nothing was shared.",
    );
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > SMS_EXPORT_MAX_BYTES) {
    throw new Error("The export is too large to handle on this device.");
  }
  const csv = await response.text();
  if (csv.length > SMS_EXPORT_MAX_BYTES) {
    throw new Error("The export is too large to handle on this device.");
  }
  const stamp = truth.asOf.replace(/[:.]/gu, "-");
  return {
    csv,
    truth,
    filename: `postwave-sms-conversations-${stamp}.csv`,
  };
}
