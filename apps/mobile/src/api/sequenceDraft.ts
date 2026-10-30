/**
 * api/sequenceDraft.ts — transport for `POST /api/v1/voice/sequences/draft`.
 *
 * WHY THIS IS NOT `rawRequest`, which is the obvious thing to reach for.
 * The shared `PostwaveClient` is constructed with the SDK defaults: a 30 s
 * per-attempt timeout and THREE retries on 429/5xx (packages/sdk-ts/src/
 * client.ts:190-191, :479-492). Both are right for the CRUD surface and wrong
 * here, because the voice handler consumes a quota unit BEFORE it calls the
 * model — `h.quotaOrNoop().CheckAndConsume(ctx, tenant, "sequence_draft", 1)`
 * runs at sequence_draft.go:75, ahead of `DraftFromBrief` on :97. So:
 *   - a 502 from a flaky upstream (the failure this route has, mapped by
 *     `statusForLLMError`) would be retried three times and charged four;
 *   - a whole-sequence generation that legitimately runs past 30 s would be
 *     aborted client-side, retried, and charged again — while the first call
 *     was still running server-side.
 * One attempt, one charge, a ceiling generous enough for a real generation.
 *
 * WHAT IS REUSED RATHER THAN REBUILT. The session/upgrade/MFA interceptors and
 * the availability telemetry are exactly the wrappers `sdkClient` gives the
 * SDK, so a 401-after-expiry, a 426 "please update" and an MFA challenge
 * behave identically on this route and on every other one. Only the four
 * headers and the retry policy are ours.
 *
 * DECODING IS NOT DONE HERE. The body is returned as `unknown` and handed to
 * `lib/sequenceDraft.normalizeSequenceDraft`, which is import-free and
 * therefore unit-testable in the node environment vitest runs in. This module
 * cannot be, and that split is deliberate: the part with rules is the part
 * with tests.
 */
import { useAuthStore } from "@/store/auth";

import { NATIVE_CLIENT_HEADERS } from "./nativeClient";
import { messageFromError, type AIApiResult } from "./request";
import { createMfaAwareFetch, createUpgradeAwareFetch } from "./sdkClient";
import { apiUrl } from "./url";

/**
 * One generation, one attempt, sixty seconds.
 *
 * The same ceiling `aiGenerate`'s streaming path uses
 * (MAX_AI_GENERATE_DURATION_MS), for the same reason: a model call is the one
 * request in this app where "still working" is the normal case well past the
 * point every other request would be a fault.
 */
const SEQUENCE_DRAFT_TIMEOUT_MS = 60_000;

/** A draft of ten emails is a few tens of KB. Anything past this is not a
 *  draft, and buffering it on a phone is not free. */
const MAX_DRAFT_RESPONSE_BYTES = 512 * 1024;

export interface SequenceDraftRequestInput {
  /** Free-text campaign brief. Already validated by `validateSequenceBrief`. */
  brief: string;
  /** 1..10, per `generation.DraftStepCountMax`. */
  stepCount: number;
  /** Optional; omitted from the body entirely when empty, because the handler
   *  documents an absent tone as "infer from the brief". */
  tone?: string | undefined;
}

interface DraftAuth {
  url: string;
  baseUrl: string;
  headers: Record<string, string>;
  sessionMode: boolean;
}

function resolveAuth(): DraftAuth | null {
  const { apiKey, baseUrl, mode, session, tenantId } = useAuthStore.getState();
  if (!baseUrl) return null;
  const authMode = mode ?? (apiKey ? "api_key" : null);
  if (!authMode) return null;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...NATIVE_CLIENT_HEADERS,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey.startsWith("pw_") ? apiKey : `pw_${apiKey}`}`;
  }
  const tenantSlug =
    session?.workspaceSlug ?? (authMode === "api_key" ? tenantId : null);
  if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;
  return {
    url: apiUrl(baseUrl, "/api/v1/voice/sequences/draft"),
    baseUrl,
    headers,
    sessionMode: authMode === "session",
  };
}

/**
 * The most specific failure a non-2xx body can justify.
 *
 * THREE shapes reach this route and they disagree with each other, which is
 * why this is not a one-liner:
 *   - `http.Error` plain text for every validation and upstream failure
 *     (sequence_draft.go writes bare strings);
 *   - `{"error":"quota_exceeded", "kind":…, "resets_at":…}` — note `error` is
 *     a STRING here (handlers/chat.go:428) — for the daily AI cap;
 *   - `{"error":{"code","message"}}`, the gateway's own envelope, for anything
 *     the API rejects before the proxy hop.
 * Guessing one and ignoring the others is how "quota used up" renders as a
 * generic rate-limit message an operator will keep retrying against.
 */
function decodeFailure(
  status: number,
  body: string,
  requestId: string | null,
): { status: number; message: string; code?: string; requestId?: string } {
  let message = body.trim();
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      message?: unknown;
    };
    if (typeof parsed.error === "string" && parsed.error) {
      code = parsed.error;
      message = parsed.error;
    } else if (parsed.error && typeof parsed.error === "object") {
      const envelope = parsed.error as { code?: unknown; message?: unknown };
      if (typeof envelope.code === "string") code = envelope.code;
      if (typeof envelope.message === "string" && envelope.message) {
        message = envelope.message;
      }
    } else if (typeof parsed.message === "string" && parsed.message) {
      message = parsed.message;
    }
  } catch {
    /* plain text is the documented shape for most of this route's failures */
  }
  return {
    status,
    message: message || `HTTP ${status}`,
    ...(code !== undefined ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_DRAFT_RESPONSE_BYTES) {
    throw new Error("The drafted sequence was too large to read.");
  }
  const text = await response.text();
  if (text.length > MAX_DRAFT_RESPONSE_BYTES) {
    throw new Error("The drafted sequence was too large to read.");
  }
  return text;
}

/**
 * Ask the model for a whole sequence. Resolves — never rejects — into the
 * mobile error envelope every sequences screen already branches on.
 *
 * `status: 0` marks a refusal that never reached the network (no session), so
 * the caller can tell "we did not send this" apart from a server answer.
 */
export async function draftSequenceFromBrief(
  input: SequenceDraftRequestInput,
  options?: { signal?: AbortSignal | undefined },
): Promise<AIApiResult<unknown>> {
  const auth = resolveAuth();
  if (!auth) {
    return {
      data: null,
      error: { status: 0, message: "Sign in again before drafting a sequence." },
    };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SEQUENCE_DRAFT_TIMEOUT_MS);
  const caller = options?.signal;
  const onCallerAbort = (): void => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onCallerAbort);
  }

  const fetchImpl = auth.sessionMode
    ? createMfaAwareFetch(
        (target, init) => globalThis.fetch(target, init),
        auth.baseUrl,
      )
    : createUpgradeAwareFetch((target, init) => globalThis.fetch(target, init));

  const tone = input.tone?.trim();
  const body = JSON.stringify({
    brief: input.brief,
    step_count: input.stepCount,
    // Omitted rather than sent empty: the handler's own fallback prompt is
    // better than an empty tone directive, and the body is decoded strictly
    // enough that sending noise is never the safe option.
    ...(tone ? { tone } : {}),
  });

  try {
    const response = await fetchImpl(auth.url, {
      method: "POST",
      headers: auth.headers,
      body,
      signal: controller.signal,
      ...(auth.sessionMode ? { credentials: "include" as const } : {}),
    });
    const requestId = response.headers.get("x-request-id");
    const text = await readBounded(response);
    if (!response.ok) {
      return { data: null, error: decodeFailure(response.status, text, requestId) };
    }
    try {
      return { data: JSON.parse(text) as unknown, error: null };
    } catch {
      return {
        data: null,
        error: {
          status: response.status,
          message: "The draft came back in a shape this build can't read.",
          ...(requestId ? { requestId } : {}),
        },
      };
    }
  } catch (error) {
    if (timedOut) {
      return {
        data: null,
        // 408 so `sequenceDraftErrorMessage` gives the timeout sentence; the
        // request was ours to cancel, so this is not a server status being
        // invented.
        error: {
          status: 408,
          message: "Drafting took longer than a minute and was cancelled.",
        },
      };
    }
    if (caller?.aborted) {
      return { data: null, error: { status: 0, message: "Drafting cancelled." } };
    }
    return { data: null, error: { status: 0, message: messageFromError(error) } };
  } finally {
    clearTimeout(timer);
    if (caller) caller.removeEventListener("abort", onCallerAbort);
  }
}
