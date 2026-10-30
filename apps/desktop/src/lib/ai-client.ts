/**
 * Moosewave AI client — thin wrapper around the voice generate endpoint
 * that adds streaming + a draft-extraction heuristic.
 *
 * The Go gateway owns `/api/v1/voice/generate`: it validates the request,
 * tokenizes sensitive prompt/context values through its fail-closed privacy
 * boundary, and makes exactly one call to the voice service. If that boundary
 * or the model client is unavailable, the route returns a contained 5xx and
 * the UI degrades honestly without a raw-proxy escape hatch.
 *
 * Streaming strategy:
 *   1. Make one POST that can consume the gateway's bounded JSON receipt or a
 *      backwards-compatible Server-Sent Event response.
 *   2. Consume whichever format that same request returns; never issue a
 *      format-probing retry.
 *   3. Never repeat a generation automatically. A network failure, error
 *      event, malformed stream, or missing `done` receipt is surfaced for a
 *      deliberate user retry; a second request could duplicate model spend
 *      and produce two different drafts.
 *
 * No external streaming library — uses fetch() + manual ReadableStream
 * parsing for SSE. EventSource isn't usable here because we need to send
 * an Authorization header.
 */

import {
  api,
  getApiKey,
  getApiUrl,
  NATIVE_CLIENT_HEADERS,
  type AIContextRef,
  type AIGenerateDraft,
  type AIGenerateKind,
} from "./api-client";
import { nativeAwareFetch } from "./native-api-fetch";

/* ---------- context-ref resolution ---------------------------------- */

/**
 * Maximum characters of resolved context we'll inline into the prompt.
 * Roughly 4× tokens, so this caps us at ~3k tokens of context — well
 * under Claude's input cap and leaves room for the system prompt + reply.
 */
const MAX_CONTEXT_CHARS = 12_000;
export const MAX_AI_CONTEXT_REFS = 20;
const MAX_CONTEXT_REF_ID_BYTES = 254;
const MAX_CONTEXT_FETCH_CONCURRENCY = 4;
const MAX_AI_STREAM_TEXT_CHARS = 200_000;
const MAX_AI_SSE_BUFFER_CHARS = 64 * 1024;
const MAX_AI_JSON_RESPONSE_BYTES = 1_000_000;

const SUPPORTED_CONTEXT_REF_TYPES = new Set([
  "campaign",
  "form",
  "sequence",
  "template",
  "voice_profile",
]);

export interface NormalizedAIContextRefs {
  refs: AIContextRef[];
  duplicateCount: number;
  invalidCount: number;
  overflowCount: number;
}

/**
 * Canonical desktop boundary for every attached resource. It mirrors the API's
 * 20-ref/254-byte contract, removes unsupported or malformed references before
 * any authenticated read, and stable-deduplicates repeated mention tokens.
 */
export function normalizeAIContextRefs(
  refs: readonly AIContextRef[] | undefined,
  maximum = MAX_AI_CONTEXT_REFS,
): NormalizedAIContextRefs {
  const limit = Math.max(0, Math.min(MAX_AI_CONTEXT_REFS, Math.floor(maximum)));
  const normalized: AIContextRef[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;
  let overflowCount = 0;
  for (const candidate of refs ?? []) {
    const type =
      typeof candidate?.type === "string"
        ? candidate.type.trim().toLowerCase()
        : "";
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    if (
      !SUPPORTED_CONTEXT_REF_TYPES.has(type) ||
      !id ||
      new TextEncoder().encode(id).length > MAX_CONTEXT_REF_ID_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(id)
    ) {
      invalidCount += 1;
      continue;
    }
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    if (normalized.length >= limit) {
      overflowCount += 1;
      continue;
    }
    normalized.push({ type, id });
  }
  return { refs: normalized, duplicateCount, invalidCount, overflowCount };
}

function apiUrl(path: string): string {
  const base = `${getApiUrl().replace(/\/+$/, "")}/`;
  return new URL(`./${path.replace(/^\/+/, "")}`, base).toString();
}

/**
 * Resolve `{type, id}` refs into a single text block the model can read.
 * Each ref becomes a labeled section so Claude can disambiguate. Errors
 * fetching one ref are inlined as `<error>` placeholders rather than
 * failing the whole request — the rest of the conversation still works.
 *
 * The voice-service chat handler reads this verbatim from `context_text`
 * and prepends it to the user's prompt, wrapped in <workspace_context>
 * tags. We don't do the cross-resource fetch on the server because that
 * would require a callback path (voice → apps/api), and the desktop
 * already has every endpoint it needs.
 */
export async function resolveContextRefs(
  refs: AIContextRef[],
  signal?: AbortSignal,
): Promise<string> {
  if (!refs || refs.length === 0) return "";
  const normalized = normalizeAIContextRefs(refs);
  if (normalized.overflowCount > 0) {
    throw new Error("too_many_context_refs");
  }
  const blocks = await resolveContextRefsBounded(normalized.refs, signal);
  const sections: string[] = [];
  let sectionLength = 0;
  for (const block of blocks) {
    if (!block) continue;
    sections.push(block);
    sectionLength += block.length + (sections.length > 1 ? 2 : 0);
    if (sectionLength > MAX_CONTEXT_CHARS) break;
  }
  let joined = sections.join("\n\n");
  if (joined.length > MAX_CONTEXT_CHARS) {
    joined = joined.slice(0, MAX_CONTEXT_CHARS) + "\n\n…(context truncated)";
  }
  return joined;
}

async function resolveContextRefsBounded(
  refs: AIContextRef[],
  signal?: AbortSignal,
): Promise<string[]> {
  const blocks = new Array<string>(refs.length).fill("");
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < refs.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = cursor;
      cursor += 1;
      const ref = refs[index];
      if (ref) blocks[index] = await resolveOneRef(ref);
    }
  };
  const workerCount = Math.min(MAX_CONTEXT_FETCH_CONCURRENCY, refs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return blocks;
}

async function resolveOneRef(ref: AIContextRef): Promise<string> {
  const resolver = CONTEXT_REF_RESOLVERS[ref.type];
  if (!resolver) return "";
  try {
    return await resolver(ref);
  } catch {
    // Backend and transport errors may contain infrastructure details, request
    // identifiers, or echoed customer input. Keep those out of model context.
    return contextFetchError(ref);
  }
}

type ContextRefResolver = (ref: AIContextRef) => Promise<string>;

const CONTEXT_REF_RESOLVERS: Readonly<Record<string, ContextRefResolver>> = {
  campaign: resolveCampaignRef,
  form: resolveFormRef,
  sequence: resolveSequenceRef,
  template: resolveTemplateRef,
  voice_profile: resolveVoiceProfileRef,
};

async function resolveCampaignRef(ref: AIContextRef): Promise<string> {
  const result = await api.getCampaign(ref.id);
  if (result.error) return contextFetchError(ref);
  const campaign = result.data;
  return labeled(
    ref,
    [
      contextLine("name", campaign?.name),
      contextLine("subject", campaign?.subject),
      contextLine("status", campaign?.status),
      contextLine("from", campaign?.from_email),
      `body (plain text):\n${contextBody(
        stripHTML(String(campaign?.body_html ?? campaign?.plain_text ?? "")),
        3000,
      )}`,
    ].join("\n"),
  );
}

async function resolveSequenceRef(ref: AIContextRef): Promise<string> {
  const result = await api.getSequence(ref.id);
  if (result.error) return contextFetchError(ref);
  const sequence = result.data;
  const stepCount = Array.isArray(sequence?.steps)
    ? sequence.steps.length
    : sequence?.steps;
  return labeled(
    ref,
    [
      contextLine("name", sequence?.name),
      contextLine("status", sequence?.status),
      contextLine("steps", stepCount),
    ].join("\n"),
  );
}

async function resolveTemplateRef(ref: AIContextRef): Promise<string> {
  const result = await api.getCampaignTemplate(ref.id);
  if (result.error) return contextFetchError(ref);
  const template = result.data;
  return labeled(
    ref,
    [
      contextLine("name", template?.name),
      contextLine("subject", template?.subject),
      contextLine("category", template?.category),
      `body (plain text):\n${contextBody(
        stripHTML(String(template?.body_html ?? "")),
        2000,
      )}`,
    ].join("\n"),
  );
}

async function resolveFormRef(ref: AIContextRef): Promise<string> {
  const result = await api.getForm(ref.id);
  if (result.error) return contextFetchError(ref);
  const form = result.data;
  return labeled(
    ref,
    [
      contextLine("name", form?.name),
      contextLine("slug", form?.slug),
      contextLine("opt-in", form?.optInMode),
    ].join("\n"),
  );
}

/**
 * Resolve only the compact, derived voice fingerprint. Representative samples,
 * tenant identifiers, source metadata, and embedding vectors are deliberately
 * excluded: they add privacy risk and token cost without improving the short
 * style instruction Chat needs. The API's strict text gateway still sanitizes
 * this block before it can reach the model.
 */
async function resolveVoiceProfileRef(ref: AIContextRef): Promise<string> {
  const result = await api.getVoiceProfile();
  if (result.error || !isRecord(result.data)) return contextFetchError(ref);
  const profile = result.data;
  const stylistic = compactNumericAxes(profile.stylistic, [
    "avg_sentence_length",
    "avg_paragraph_length",
    "formality_score",
    "hedging_frequency",
    "passive_voice_pct",
  ]);
  const tonal = compactNumericAxes(profile.tonal ?? profile.axes, [
    "humor",
    "optimism",
    "personal_vs_observational",
    "directness",
    "formality",
    "warmth",
  ]);
  const structural = compactScalarFields(profile.structural, [
    "opening_hook_style",
    "closing_pattern",
    "bullet_list_usage_rate",
    "markdown_style_hint",
  ]);
  const vocabulary = isRecord(profile.vocabulary)
    ? compactTermList(profile.vocabulary.distinctive_terms, "term", 6)
    : [];
  const themes = isRecord(profile.persona)
    ? compactStringList(profile.persona.recurring_themes, 8)
    : [];

  return labeled(
    ref,
    [
      contextLine("version", profile.version),
      contextLine("built", profile.generated_at ?? profile.built_at),
      `tonal axes: ${tonal.length ? tonal.join(", ") : "—"}`,
      `stylistic signals: ${stylistic.length ? stylistic.join(", ") : "—"}`,
      `structural habits: ${structural.length ? structural.join(", ") : "—"}`,
      `distinctive terms: ${vocabulary.length ? vocabulary.join(", ") : "—"}`,
      `recurring themes: ${themes.length ? themes.join(", ") : "—"}`,
    ].join("\n"),
  );
}

function compactNumericAxes(value: unknown, keys: string[]): string[] {
  if (!isRecord(value)) return [];
  const output: string[] = [];
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    output.push(`${key}=${Number(candidate.toFixed(3))}`);
  }
  return output;
}

function compactScalarFields(value: unknown, keys: string[]): string[] {
  if (!isRecord(value)) return [];
  const output: string[] = [];
  for (const key of keys) {
    const candidate = value[key];
    if (
      (typeof candidate !== "string" && typeof candidate !== "number") ||
      (typeof candidate === "number" && !Number.isFinite(candidate))
    ) {
      continue;
    }
    output.push(`${key}=${contextScalar(candidate).slice(0, 120)}`);
  }
  return output;
}

function compactTermList(
  value: unknown,
  field: string,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate[field] !== "string") {
        return [];
      }
      const item = contextScalar(candidate[field]).slice(0, 80);
      return item === "—" ? [] : [item];
    })
    .slice(0, limit);
}

function compactStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => contextScalar(candidate).slice(0, 80))
    .filter((candidate) => candidate !== "—")
    .slice(0, limit);
}

function contextFetchError(ref: AIContextRef): string {
  return labeled(ref, "<error>Resource unavailable.</error>");
}

function contextLine(label: string, value: unknown): string {
  return `${label}: ${contextScalar(value)}`;
}

function contextScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return escapeContextMarkup(String(value).replace(/[\r\n\t]+/g, " ")).slice(
    0,
    1000,
  );
}

function contextBody(value: string, maxChars: number): string {
  return escapeContextMarkup(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""),
  )
    .slice(0, maxChars)
    .trim();
}

function escapeContextMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function labeled(ref: AIContextRef, body: string): string {
  return `[[${safeContextLabel(ref.type)}:${safeContextLabel(ref.id)}]]\n${body}`;
}

function safeContextLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._+@-]/g, "_").slice(0, 254) || "unknown";
}

/** Cheap HTML→text. Avoids pulling in a sanitiser; the result only
 *  reaches Claude, never a DOM. Keeps newlines on block-level tags. */
function stripHTML(html: string): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- public types ------------------------------------------- */

export interface AIStreamHandlers {
  /** Called for each incremental text chunk. Append to the live message. */
  onDelta: (chunk: string) => void;
  /**
   * Called once when the stream finishes successfully. `full` is the
   * complete concatenated text; `draft`, when present, was returned by
   * the server (preferred over the heuristic).
   */
  onDone: (result: {
    full: string;
    draft?: AIGenerateDraft | undefined;
  }) => void;
  /** Called once with a human-readable message on any error. */
  onError: (message: string) => void;
}

export interface AIStreamHandle {
  /** Best-effort cancel. Aborts the in-flight fetch (if any). */
  abort: () => void;
}

export interface AIRequestInput {
  prompt: string;
  kind: AIGenerateKind;
  contextRefs?: AIContextRef[];
}

/* ---------- streaming entry point ---------------------------------- */

/**
 * Kick off an AI generation. Returns a handle that can abort the
 * in-flight request. Handlers are called on the main thread.
 *
 * Failure semantics: every call performs exactly one model-facing request.
 * A failure invokes `onError`; content already streamed remains visible.
 */
export function streamAIGenerate(
  input: AIRequestInput,
  handlers: AIStreamHandlers,
): AIStreamHandle {
  const ctrl = new AbortController();
  let cancelled = false;

  void (async () => {
    // Resolve only explicitly approved campaign/sequence/template/form and
    // compact voice-profile refs. Subscriber records remain excluded: the
    // strict server privacy gateway protects supplied text but does not grant
    // subscriber-read authority. We do this once per request and forward the
    // same context on either response format.
    let contextText = "";
    if (input.contextRefs && input.contextRefs.length > 0) {
      try {
        contextText = await resolveContextRefs(input.contextRefs, ctrl.signal);
      } catch {
        if (!cancelled) {
          handlers.onError(
            `Attach no more than ${MAX_AI_CONTEXT_REFS} supported workspace resources, then retry.`,
          );
        }
        return;
      }
    }
    if (cancelled) return;

    // One model-facing request. The response may be SSE or synchronous JSON.
    const sseResult = await trySSE({ ...input, contextText }, ctrl.signal, {
      onDelta: (chunk) => {
        if (cancelled) return;
        handlers.onDelta(chunk);
      },
      onDone: (result) => {
        if (cancelled) return;
        handlers.onDone(result);
      },
    });
    if (!cancelled && sseResult.status === "terminal-error") {
      handlers.onError(sseResult.message);
    }
  })();

  return {
    abort: () => {
      cancelled = true;
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ---------- SSE path ----------------------------------------------- */

/**
 * Try to read the response as `text/event-stream`. JSON fallback is only safe
 * before the server accepts an SSE response. Once a 200 event stream exists,
 * every error is terminal because retrying could invoke the model twice.
 *
 * Server-side wire format we expect:
 *   event: delta
 *   data: {"text":"...partial..."}
 *
 *   event: done
 *   data: {"draft":{...} or null}
 *
 * Unknown events are ignored. A successful stream must contain an explicit
 * terminal `done` event; transport EOF is not a completion receipt.
 */
type SSEAttemptResult =
  | { status: "completed" }
  | { status: "terminal-error"; message: string };

async function trySSE(
  input: AIRequestInput & { contextText?: string },
  signal: AbortSignal,
  handlers: Pick<AIStreamHandlers, "onDelta" | "onDone">,
): Promise<SSEAttemptResult> {
  const url = apiUrl("/api/v1/voice/generate");
  const headers: Record<string, string> = {
    // D02-http-auth#8: this POST carries `credentials: "include"`, so for
    // session-cookie users the backend origin-CSRF gate 403s it unless we
    // identify as a trusted native client — same contract request()/
    // authRequest() honour. Without this the SSE attempt always 403s and
    // silently downgrades to the blocking JSON path on every generation.
    ...NATIVE_CLIENT_HEADERS,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  };
  const key = getApiKey();
  if (key) {
    const bearer = key.startsWith("pw_") ? key : `pw_${key}`;
    headers["Authorization"] = `Bearer ${bearer}`;
  }

  let res: Response;
  try {
    res = await nativeAwareFetch(url, {
      method: "POST",
      headers,
      credentials: "include",
      mode: "cors",
      cache: "no-store",
      signal,
      body: JSON.stringify({
        prompt: input.prompt,
        kind: input.kind,
        context_refs: (input.contextRefs ?? []).map((ref) => ({
          kind: ref.type,
          id: ref.id,
        })),
        context_text: input.contextText ?? "",
        stream: true,
      }),
    });
  } catch {
    return {
      status: "terminal-error",
      message:
        "AI service could not be reached. Retry when the connection is stable.",
    };
  }

  const ct = res.headers.get("Content-Type") ?? "";
  if (!res.ok) {
    try {
      void res.body?.cancel();
    } catch {
      /* ignore */
    }
    return {
      status: "terminal-error",
      message: formatError({
        status: res.status,
        message: "AI request failed",
      }),
    };
  }

  if (!ct.includes("text/event-stream")) {
    if (ct.includes("application/json")) {
      return consumeJSONGenerationResponse(res, handlers);
    }
    try {
      void res.body?.cancel();
    } catch {
      /* ignore */
    }
    return {
      status: "terminal-error",
      message: "AI service returned an unsupported response format.",
    };
  }

  if (!res.body) {
    return {
      status: "terminal-error",
      message:
        "AI stream ended before completion. The response was not retried.",
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collectedText = "";
  let serverDraft: AIGenerateDraft | undefined;
  let sawDone = false;
  const applyParsedMessage = (parsed: SSEMessage | null): void => {
    if (!parsed) return;
    if (parsed.event === "delta") {
      if (sawDone) {
        throw new Error("AI stream emitted content after completion");
      }
      const chunk =
        typeof parsed.data?.text === "string" ? parsed.data.text : "";
      if (chunk) {
        const remaining = MAX_AI_STREAM_TEXT_CHARS - collectedText.length;
        if (remaining <= 0) {
          throw new Error("AI stream response too large");
        }
        const next = chunk.slice(0, remaining);
        collectedText += next;
        handlers.onDelta(next);
        if (next.length < chunk.length) {
          throw new Error("AI stream response too large");
        }
      }
    } else if (parsed.event === "done") {
      if (sawDone) {
        throw new Error("AI stream emitted more than one completion receipt");
      }
      sawDone = true;
      const d = parsed.data?.draft;
      if (d !== undefined && d !== null) {
        const decodedDraft = parseAIGenerateDraft(d);
        if (!decodedDraft) {
          throw new Error("AI stream returned an invalid completion draft");
        }
        serverDraft = decodedDraft;
      }
    } else if (parsed.event === "error") {
      throw new Error("AI generation failed before completion");
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_AI_SSE_BUFFER_CHARS) {
        throw new Error("AI stream frame too large");
      }
      // SSE message boundary is a blank line. Process complete messages.
      let boundary = findSSEMessageBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        applyParsedMessage(parseSSEMessage(raw));
        boundary = findSSEMessageBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      applyParsedMessage(parseSSEMessage(buffer));
    }
  } catch (error) {
    const message =
      error instanceof Error &&
      error.message === "AI generation failed before completion"
        ? error.message
        : "AI stream ended before completion. The partial response was not retried.";
    return { status: "terminal-error", message };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (!sawDone) {
    return {
      status: "terminal-error",
      message:
        "AI stream ended before completion. The partial response was not retried.",
    };
  }

  const finalDraft = serverDraft ?? extractDraftHeuristic(collectedText);
  handlers.onDone({ full: collectedText, draft: finalDraft });
  return { status: "completed" };
}

function findSSEMessageBoundary(
  buffer: string,
): { index: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match?.index === undefined
    ? null
    : { index: match.index, length: match[0].length };
}

async function consumeJSONGenerationResponse(
  response: Response,
  handlers: Pick<AIStreamHandlers, "onDelta" | "onDone">,
): Promise<SSEAttemptResult> {
  let raw: string;
  try {
    raw = await readBoundedResponseText(response, MAX_AI_JSON_RESPONSE_BYTES);
  } catch {
    return {
      status: "terminal-error",
      message: "AI service returned an invalid or oversized response.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "terminal-error",
      message: "AI service returned an invalid response.",
    };
  }
  if (!isRecord(parsed) || typeof parsed.text !== "string") {
    return {
      status: "terminal-error",
      message: "AI service returned an invalid response.",
    };
  }
  if (parsed.text.length > MAX_AI_STREAM_TEXT_CHARS) {
    return {
      status: "terminal-error",
      message: "AI service returned an oversized response.",
    };
  }

  const draft =
    parseAIGenerateDraft(parsed.draft) ?? extractDraftHeuristic(parsed.text);
  if (parsed.text) handlers.onDelta(parsed.text);
  handlers.onDone({ full: parsed.text, draft });
  return { status: "completed" };
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("response too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) throw new Error("response too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseAIGenerateDraft(value: unknown): AIGenerateDraft | undefined {
  if (!isRecord(value)) return undefined;
  const name = boundedOptionalString(value.name, 500);
  const subject = boundedOptionalString(value.subject, 500);
  const body = boundedOptionalString(value.body, MAX_AI_STREAM_TEXT_CHARS);
  const previewText = boundedOptionalString(value.preview_text, 1_000);
  if (
    name === null ||
    subject === null ||
    body === null ||
    previewText === null
  ) {
    return undefined;
  }
  if (
    name === undefined &&
    subject === undefined &&
    body === undefined &&
    previewText === undefined
  ) {
    return undefined;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(subject === undefined ? {} : { subject }),
    ...(body === undefined ? {} : { body }),
    ...(previewText === undefined ? {} : { preview_text: previewText }),
  };
}

function boundedOptionalString(
  value: unknown,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SSEMessage {
  event: string;
  data: { text?: unknown; draft?: unknown } | null;
}

function parseSSEMessage(raw: string): SSEMessage | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join("\n");
  try {
    const parsed = JSON.parse(joined) as { text?: unknown; draft?: unknown };
    return { event, data: parsed };
  } catch {
    // Allow plain-text data: lines as a `text` field.
    return { event, data: { text: joined } };
  }
}

/* ---------- error formatting --------------------------------------- */

function formatError(err: { message: string; status?: number }): string {
  if (err.status === 404) {
    // D14-settings-misc#13: there is no "Settings → AI" section — the voice
    // service is enabled server-side, not from a desktop settings surface.
    // Match AudienceSyncs' honest-404 copy: say it isn't available here.
    return (
      "AI generation isn't available on this deployment — the Moosewave " +
      "voice service must be enabled server-side."
    );
  }
  if (err.status === 401 || err.status === 403) {
    return "Not authorised to call the AI service.";
  }
  if (err.status === 429) {
    return "AI rate limit reached — try again in a moment.";
  }
  if (err.status && err.status >= 500) {
    return `AI service error (${err.status}). Try again shortly.`;
  }
  return err.message || "Could not reach the AI service.";
}

/* ---------- draft extraction heuristic ------------------------------ */

/**
 * Pull a `{name, subject, body}` skeleton out of a free-form assistant
 * response so the user can hand off to the New Campaign modal. The
 * server's structured `draft` field is preferred; this is the fallback
 * when only `text` is returned.
 *
 * Heuristic:
 *   1. Look for a `Subject:` line (case-insensitive). The capture continues
 *      to the end of that line. Body is everything after that line.
 *   2. Otherwise, look for a leading markdown heading (`# Title`); use it
 *      as the campaign name. Subject defaults to the heading. Body is the
 *      remaining content.
 *   3. If neither pattern matches, return null — the chat bubble simply
 *      won't show a "Use as draft" CTA.
 */
export function extractDraftHeuristic(
  text: string,
): AIGenerateDraft | undefined {
  if (!text || !text.trim()) return undefined;

  // Pattern 1: Subject: line
  const subjMatch = text.match(/^[ \t]*Subject:[ \t]*(.+)$/im);
  if (subjMatch) {
    const subject = subjMatch[1]?.trim() ?? "";
    const before = text.slice(0, subjMatch.index ?? 0).trim();
    const after = text
      .slice((subjMatch.index ?? 0) + subjMatch[0].length)
      .trim();
    const body = after || before;
    return {
      name: deriveName(before, subject),
      subject,
      body,
    };
  }

  // Pattern 2: leading "# Heading"
  const headingMatch = text.match(/^[ \t]*#[ \t]+(.+)$/m);
  if (headingMatch && (headingMatch.index ?? 0) < 32) {
    const heading = headingMatch[1]?.trim() ?? "";
    const after = text
      .slice((headingMatch.index ?? 0) + headingMatch[0].length)
      .trim();
    if (heading && after) {
      return {
        name: heading,
        subject: heading,
        body: after,
      };
    }
  }

  return undefined;
}

/**
 * Pick a campaign name from the first line of `before` (the lead-in
 * paragraph above `Subject:`) or fall back to the subject itself.
 */
function deriveName(before: string, subject: string): string {
  const firstLine = before.split(/\n/)[0]?.trim() ?? "";
  if (firstLine && firstLine.length <= 80) return firstLine;
  if (subject.length <= 80) return subject;
  return subject.slice(0, 77) + "…";
}

/**
 * Quickly classify whether a free-form assistant response *looks* like a
 * campaign draft (and is therefore worth surfacing the "Use as draft"
 * CTA on). Used by the chat bubble so we only show the button when the
 * heuristic can extract a usable draft.
 */
export function looksLikeCampaignDraft(text: string): boolean {
  return Boolean(extractDraftHeuristic(text));
}

/* ---------- mention token serialization --------------------------- */

/**
 * Mention pill syntax recognised by the composer / backdrop:
 *   `@[Label](kind:id)` — canonical, what the picker emits.
 *   `@kind:id`          — legacy shorthand, no display label.
 *   `#kind/id`          — alt legacy shorthand.
 *
 * These helpers own the durable token round-trip used by chat history. Search,
 * scoped completion and keyboard selection live in the Moosewave AI mention
 * controller and MentionMenu rather than in this serialization layer.
 */

const PILL_RE = /@\[([^\]]+)\]\(([a-zA-Z_]+):([^)]+)\)/g;
const LEGACY_AT_RE = /@([a-zA-Z_]+):([a-zA-Z0-9_-]+)/g;
const LEGACY_HASH_RE = /#([a-zA-Z_]+)\/([a-zA-Z0-9_-]+)/g;

/**
 * Pull `{type, id}` refs out of a free-form prompt string. Order is
 * preserved; duplicates are NOT deduped (callers that care should
 * dedup on `${type}:${id}`).
 */
export function detectContextRefs(text: string): AIContextRef[] {
  if (!text) return [];
  const out: AIContextRef[] = [];
  for (const m of text.matchAll(PILL_RE)) {
    out.push({ type: m[2] as AIContextRef["type"], id: m[3] });
  }
  for (const m of text.matchAll(LEGACY_AT_RE)) {
    out.push({ type: m[1] as AIContextRef["type"], id: m[2] });
  }
  for (const m of text.matchAll(LEGACY_HASH_RE)) {
    out.push({ type: m[1] as AIContextRef["type"], id: m[2] });
  }
  return out;
}

/**
 * Replace `@[Label](kind:id)` with `@Label` so the model reads a
 * friendly mention instead of the structured token. Legacy
 * shorthands pass through unchanged — they're already terse.
 */
export function stripMentionSyntax(text: string): string {
  if (!text) return "";
  return text.replace(PILL_RE, (_m, label) => `@${label}`);
}

export interface AIMentionSegment {
  kind: "text" | "mention";
  text: string;
  type?: string;
  id?: string;
  label?: string;
}

/**
 * Split a string into alternating text + mention segments so the
 * composer backdrop can paint pills inline. Only canonical
 * `@[Label](kind:id)` pills are tokenised; legacy shorthands stay as
 * plain text.
 */
export function parseMentionSegments(text: string): AIMentionSegment[] {
  if (!text) return [];
  const out: AIMentionSegment[] = [];
  let cursor = 0;
  PILL_RE.lastIndex = 0;
  for (const m of text.matchAll(PILL_RE)) {
    const idx = m.index ?? 0;
    if (idx > cursor) {
      out.push({ kind: "text", text: text.slice(cursor, idx) });
    }
    out.push({
      kind: "mention",
      text: m[0],
      type: m[2],
      id: m[3],
      label: m[1],
    });
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) {
    out.push({ kind: "text", text: text.slice(cursor) });
  }
  return out;
}

/* ---------- grounding-chip projection ----------------------------- */

export interface AIGroundingChipDescriptor {
  id: string;
  label: string;
  /** Optional sidebar section to navigate to on click. */
  target?: string;
  /** Tooltip / aria-label. */
  title?: string;
}

/**
 * Build the deterministic chip strip that records the resource references and
 * optional voice-profile snapshot requested for an answer. The transport does
 * not currently return per-reference resolution receipts, so these chips must
 * not claim that every requested resource was successfully resolved.
 */
export function buildGroundingChips(
  refs: AIContextRef[] | undefined,
  voiceSnapshot?: {
    label?: string;
    title?: string;
    version?: string | number | null;
  } | null,
): AIGroundingChipDescriptor[] {
  const out: AIGroundingChipDescriptor[] = [];
  for (const r of refs ?? []) {
    out.push({
      id: `${r.type}:${r.id}`,
      label: `${r.type} ${r.id.slice(0, 8)}`,
      target: r.type,
      title: `Requested ${r.type} context ${r.id}`,
    });
  }
  if (voiceSnapshot && (voiceSnapshot.label || voiceSnapshot.version != null)) {
    const label =
      voiceSnapshot.label ??
      (voiceSnapshot.version != null
        ? `Voice v${voiceSnapshot.version}`
        : "Voice");
    out.push({
      id: `voice:${voiceSnapshot.version ?? "snap"}`,
      label,
      title:
        voiceSnapshot.title ?? "Workspace voice profile requested as context",
    });
  }
  return out;
}
