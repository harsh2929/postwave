/**
 * lib/aiChatFailures.ts — one sentence per way a chat turn can fail.
 *
 * THE RELEASE HOLD. The in-app AGENT family (/api/v1/ai-agent/*) answers 503
 * `{error: "the in-app agent is release-held", code:
 * "agent_interactive_release_held"}` (ai_agent/sessions.go:79-93). The SDK's
 * parseErrorBody drops `code` from that FLAT shape — it reads `b.message`,
 * never `b.code` — and substitutes `http_503`, so the classifier recovers the
 * code from the raw payload through the shared envelope parser. A held answer
 * is rendered as a blocked server, verbatim, never as a chat.
 *
 * EVERY 5xx FROM THE CHAT ROUTE IS ANONYMOUS. httperror.Write normalises the
 * code and message of any ≥500 to `internal_error` / "an internal error
 * occurred" (httperror.go:135-139); only the STATUS survives — 503 when the
 * voice service or the PII gateway is unavailable, 504 on the deadline, 502
 * otherwise — so the sentence is chosen by status and the request id is kept
 * for support.
 *
 * No react-native / expo import: vitest runs this in node.
 */
import { parseErrorEnvelope } from "@postwave/errors";

import type { AIApiError } from "@/api/request";
import {
  capabilityUnavailableMessage,
  type CapabilityEnvelope,
} from "@/lib/capabilityEnvelope";
import { denialPresentation } from "@/lib/denialEnvelope";

/** ai_agent.AgentInteractiveReleaseHoldCode, verbatim. */
export const AI_CHAT_RELEASE_HOLD_CODE = "agent_interactive_release_held";
/** The SDK's client-wide request ceiling; mobile does not override it. */
export const AI_CHAT_REPLY_TIMEOUT_SECONDS = 30;

export type AiChatFailureKind =
  | "held"
  | "unavailable"
  | "denied"
  | "invalid"
  | "busy"
  | "timeout"
  | "cancelled"
  | "offline"
  | "failed";

export interface AiChatFailure {
  kind: AiChatFailureKind;
  message: string;
  retryable: boolean;
  requestId: string | null;
  code: string | null;
}

/** The subset of the mobile error envelope the classifier reads. */
export type AiChatErrorInput = Pick<
  AIApiError,
  | "status"
  | "message"
  | "code"
  | "payload"
  | "requestId"
  | "capability"
  | "runtimeStatus"
  | "retryable"
  | "denial"
  | "retryAfterSeconds"
>;

const SDK_SYNTHETIC_CODE = /^http_\d{3}$/u;
const SDK_SYNTHETIC_MESSAGE = /^HTTP \d{3}$/u;

/**
 * The server's code and message, recovering both from the raw payload when
 * the SDK substituted its `http_<status>` / `HTTP <status>` placeholders.
 */
function serverEnvelope(error: AiChatErrorInput): {
  code: string | null;
  message: string | null;
} {
  const fromPayload =
    error.payload === undefined || error.payload === null
      ? {}
      : parseErrorEnvelope(error.payload);
  const code =
    error.code && !SDK_SYNTHETIC_CODE.test(error.code)
      ? error.code
      : (fromPayload.code ?? null);
  const message =
    error.message && !SDK_SYNTHETIC_MESSAGE.test(error.message)
      ? error.message
      : (fromPayload.message ?? null);
  return { code, message: message?.trim() ? message.trim() : null };
}

function failure(
  kind: AiChatFailureKind,
  message: string,
  retryable: boolean,
  error: AiChatErrorInput,
  code: string | null,
): AiChatFailure {
  return {
    kind,
    message,
    retryable,
    requestId: error.requestId ?? null,
    code,
  };
}

/** Status 0: the request never produced a response. Three different reasons. */
function transportFailure(
  error: AiChatErrorInput,
  code: string | null,
): AiChatFailure {
  if (code === "request_aborted") {
    return failure("cancelled", "Stopped before a reply arrived.", true, error, code);
  }
  if (code === "request_timeout") {
    return failure(
      "timeout",
      `No reply within ${AI_CHAT_REPLY_TIMEOUT_SECONDS} seconds. The server may still be working on it; send again when you are ready.`,
      true,
      error,
      code,
    );
  }
  return failure(
    "offline",
    "Could not reach the server. Check your connection and try again.",
    true,
    error,
    code,
  );
}

/** ≥500: anonymous by contract, so the status picks the sentence. */
function upstreamFailure(
  error: AiChatErrorInput,
  code: string | null,
): AiChatFailure {
  const sentence =
    error.status === 503
      ? "AI chat is unavailable on the server right now."
      : error.status === 504
        ? "The server gave up waiting for the model."
        : "The AI could not complete this reply.";
  return failure("failed", `${sentence} (HTTP ${error.status})`, true, error, code);
}

function rateLimited(
  error: AiChatErrorInput,
  code: string | null,
): AiChatFailure {
  const wait = error.retryAfterSeconds;
  return failure(
    "busy",
    wait && wait > 0
      ? `The workspace has hit its AI rate limit. Try again in ${wait} seconds.`
      : "The workspace has hit its AI rate limit. Try again shortly.",
    true,
    error,
    code,
  );
}

/**
 * One sentence per outcome, and the sentence is the server's wherever the
 * server wrote one. Order matters: the release hold outranks everything, a
 * capability envelope outranks a bare 503, and a classified denial outranks a
 * bare 401/403.
 */
export function classifyAiChatFailure(error: AiChatErrorInput): AiChatFailure {
  const { code, message } = serverEnvelope(error);

  if (code === AI_CHAT_RELEASE_HOLD_CODE) {
    return failure(
      "held",
      message ?? "This AI surface is release-held on the server.",
      false,
      error,
      code,
    );
  }
  if (
    error.status === 503 &&
    error.capability &&
    error.runtimeStatus === "unavailable"
  ) {
    const envelope: CapabilityEnvelope = {
      capability: error.capability,
      runtimeStatus: "unavailable",
      retryable: error.retryable ?? false,
    };
    return failure(
      "unavailable",
      capabilityUnavailableMessage(envelope, message ?? undefined),
      false,
      error,
      code,
    );
  }
  if (error.denial) {
    const presented = denialPresentation(error.denial);
    return failure(
      error.denial.reason === "quota" ? "busy" : "denied",
      presented.message,
      presented.retryable,
      error,
      code,
    );
  }
  if (error.status === 401 || error.status === 403) {
    return failure(
      "denied",
      "Moosewave AI needs editor access in this workspace. Ask an administrator to change your role.",
      false,
      error,
      code,
    );
  }
  if (error.status === 0) return transportFailure(error, code);
  if (error.status === 429) return rateLimited(error, code);
  if (error.status === 400 || error.status === 413 || error.status === 422) {
    return failure(
      "invalid",
      message ?? "The server could not read that prompt.",
      false,
      error,
      code,
    );
  }
  if (error.status >= 500) return upstreamFailure(error, code);
  return failure(
    "failed",
    message ?? "The AI could not complete this reply.",
    true,
    error,
    code,
  );
}
