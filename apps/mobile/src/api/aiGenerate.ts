import { useAuthStore } from "@/store/auth";
import { fetch as expoFetch } from "expo/fetch";

import { utf8ByteLength } from "../lib/utf8";
import { interceptMfaRequiredResponse } from "./auth";
import { NATIVE_CLIENT_HEADERS } from "./nativeClient";
import { messageFromError } from "./request";
import { apiUrl } from "./url";

const MAX_AI_GENERATE_RESPONSE_BYTES = 512 * 1024;
const MAX_AI_GENERATE_STREAM_BUFFER_CHARS = 64 * 1024;
const MAX_AI_GENERATE_STREAM_TEXT_CHARS = 200_000;
const MAX_AI_GENERATE_DURATION_MS = 60_000;

function effectiveTenantSlug(): string | null {
  const { mode, tenantId, session } = useAuthStore.getState();
  return session?.workspaceSlug ?? (mode === "api_key" ? tenantId : null);
}

function apiURL(baseUrl: string, path: string): string {
  return apiUrl(baseUrl, path);
}

export interface AIStreamHandlers {
  onDelta: (chunk: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface AIStreamHandle {
  abort: () => void;
}

export interface AIGenerateInput {
  prompt: string;
  kind: string;
  contextRefs?: { type: string; id: string }[];
}

function errorMessageFromSSEData(data: string): string {
  const fallback = "AI generation failed";
  if (!data) return fallback;
  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) {
      return parsed.message;
    }
  } catch {
    /* the server may send a bare string instead of JSON */
  }
  return data;
}

export function parseBufferedAISSE(input: string): string[] {
  const deltas: string[] = [];
  let sawDone = false;
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const frame of normalized.split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (event === "done") {
      if (sawDone)
        throw new Error("AI stream contained duplicate terminal events");
      sawDone = true;
      continue;
    }
    if (event === "error" && dataLines.length > 0) {
      throw new Error(errorMessageFromSSEData(dataLines.join("\n")));
    }
    if (event !== "delta" || dataLines.length === 0) continue;
    if (sawDone) throw new Error("AI stream contained data after completion");
    const data = dataLines.join("\n");
    try {
      const parsed = JSON.parse(data) as { text?: unknown };
      if (typeof parsed.text === "string" && parsed.text) {
        deltas.push(parsed.text);
      }
    } catch {
      if (data) deltas.push(data);
    }
  }
  if (!sawDone) throw new Error("AI stream ended before completion");
  return deltas;
}

/**
 * The most specific message a failed response can justify.
 *
 * Falls back to the bare status rather than inventing prose: a body that is
 * missing, truncated or not JSON tells us nothing about WHY, and "HTTP 502" is
 * more honest than a guess. Both envelope shapes are accepted because the
 * gateway and the voice service disagree about which one they emit.
 */
async function errorMessageFromResponse(res: Response): Promise<string> {
  try {
    const body = await readTextLimited(res, MAX_AI_GENERATE_RESPONSE_BYTES);
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const nested = parsed.error?.message;
    if (typeof nested === "string" && nested) return nested;
    const flat = parsed.message;
    if (typeof flat === "string" && flat) return flat;
  } catch {
    /* keep the bare status when the body is missing or not JSON */
  }
  return `HTTP ${res.status}`;
}

/**
 * Text carried by a response that is NOT an event stream.
 *
 * Two legacy shapes reach this path: a buffered SSE body (the whole stream
 * arriving at once, which some proxies do) and a plain `{text}` JSON envelope
 * from before streaming existed. Anything else is returned raw, because
 * showing what the server actually said beats showing nothing.
 */
function deltasFromNonStreamedBody(
  text: string,
  isEventStream: boolean,
): string[] {
  if (isEventStream) return parseBufferedAISSE(text);
  try {
    const parsed = JSON.parse(text) as { text?: unknown };
    if (typeof parsed.text === "string") {
      return parsed.text ? [parsed.text] : [];
    }
  } catch {
    /* keep raw for a non-SSE legacy response */
  }
  return text ? [text] : [];
}

export function streamAIGenerate(
  input: AIGenerateInput,
  handlers: AIStreamHandlers,
): AIStreamHandle {
  const ctrl = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const durationTimer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, MAX_AI_GENERATE_DURATION_MS);

  const fail = (message: string): void => {
    clearTimeout(durationTimer);
    if (!cancelled) handlers.onError(message);
  };

  const complete = (): void => {
    clearTimeout(durationTimer);
    if (!cancelled) handlers.onDone();
  };

  const buildAuth = (): {
    url: string;
    baseUrl: string;
    bearer: string | null;
  } | null => {
    const { apiKey, baseUrl } = useAuthStore.getState();
    if (!baseUrl) return null;
    const bearer = apiKey
      ? apiKey.startsWith("pw_")
        ? apiKey
        : `pw_${apiKey}`
      : null;
    const url = apiURL(baseUrl, "/api/v1/voice/generate");
    return { url, baseUrl, bearer };
  };

  void (async () => {
    const auth = buildAuth();
    if (!auth) {
      fail("Not signed in");
      return;
    }
    const tenantSlug = effectiveTenantSlug();
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...NATIVE_CLIENT_HEADERS,
    };
    if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
    if (tenantSlug) headers["X-Tenant-Slug"] = tenantSlug;

    const payload = JSON.stringify({
      prompt: input.prompt,
      kind: input.kind,
      context_refs: input.contextRefs ?? [],
      context_text: "",
      stream: true,
    });

    let res: Response;
    try {
      res = await interceptMfaRequiredResponse(
        await expoFetch(auth.url, {
          method: "POST",
          headers,
          body: payload,
          signal: ctrl.signal,
          ...(auth.bearer ? {} : { credentials: "include" as const }),
        }),
        auth.baseUrl,
      );
    } catch (err) {
      if (cancelled) return;
      fail(timedOut ? "AI generation timed out" : messageFromError(err));
      return;
    }

    if (!res.ok) {
      fail(await errorMessageFromResponse(res));
      return;
    }

    const ct = res.headers.get("Content-Type") ?? "";
    if (!ct.includes("text/event-stream") || !res.body) {
      try {
        const text = await readTextLimited(res, MAX_AI_GENERATE_RESPONSE_BYTES);
        if (cancelled) return;
        for (const delta of deltasFromNonStreamedBody(
          text,
          ct.includes("text/event-stream"),
        )) {
          handlers.onDelta(delta);
        }
        complete();
      } catch (err) {
        fail(timedOut ? "AI generation timed out" : messageFromError(err));
      }
      return;
    }

    const reader = (
      res.body as unknown as ReadableStream<Uint8Array>
    ).getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let sawDone = false;
    let emittedChars = 0;

    const emitDelta = (text: string): void => {
      if (!text) return;
      const remaining = MAX_AI_GENERATE_STREAM_TEXT_CHARS - emittedChars;
      if (remaining <= 0) {
        throw new Error("AI stream response too large");
      }
      const next = text.slice(0, remaining);
      emittedChars += next.length;
      handlers.onDelta(next);
      if (next.length < text.length) {
        throw new Error("AI stream response too large");
      }
    };

    const flushFrame = (raw: string): void => {
      if (!raw.trim()) return;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      if (event === "delta") {
        if (sawDone) {
          throw new Error("AI stream contained data after completion");
        }
        try {
          const j = JSON.parse(data) as { text?: unknown };
          if (typeof j.text === "string" && j.text) emitDelta(j.text);
        } catch {
          if (data) emitDelta(data);
        }
      } else if (event === "done") {
        if (sawDone) {
          throw new Error("AI stream contained duplicate terminal events");
        }
        sawDone = true;
      } else if (event === "error") {
        throw new Error(errorMessageFromSSEData(data));
      }
    };

    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > MAX_AI_GENERATE_STREAM_BUFFER_CHARS) {
            throw new Error("AI stream frame too large");
          }
          let idx = buffer.indexOf("\n\n");
          while (idx !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            flushFrame(raw);
            idx = buffer.indexOf("\n\n");
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) flushFrame(buffer);
      if (!sawDone) {
        throw new Error("AI stream ended before completion");
      }
      complete();
    } catch (err) {
      fail(timedOut ? "AI generation timed out" : messageFromError(err));
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
  })();

  return {
    abort: () => {
      cancelled = true;
      clearTimeout(durationTimer);
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

async function readTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AIGenerateBodyTooLargeError();
  }
  if (!res.body) {
    const read = res.text.bind(res);
    const text = await read();
    if (utf8ByteLength(text) > maxBytes) {
      throw new AIGenerateBodyTooLargeError();
    }
    return text;
  }

  const reader = (
    res.body as unknown as ReadableStream<Uint8Array>
  ).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AIGenerateBodyTooLargeError();
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

class AIGenerateBodyTooLargeError extends Error {
  constructor() {
    super("Response body too large");
    this.name = "AIGenerateBodyTooLargeError";
  }
}
