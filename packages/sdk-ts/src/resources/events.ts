// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";
import { mapError, NetworkError } from "../errors.js";

const MAX_STREAM_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_STREAM_FRAME_CHARS = 256 * 1024;
const MAX_STREAM_BUFFER_CHARS = 512 * 1024;

/** A live email event streamed via SSE. */
export interface EventRecord {
  id?: string;
  ts: string;
  event_type: string;
  subscriber_email?: string;
  campaign_id?: string;
  subscriber_id?: string;
  metadata?: Record<string, unknown>;
}

export interface StreamParams {
  /** Optional event_type filter (e.g. "opened"). */
  event_type?: string;
  /** Optional campaign filter. */
  campaign?: string;
  /** Abort signal to stop the stream. */
  signal?: AbortSignal;
}

/**
 * Live events resource. Connects to the server's SSE stream
 * `GET /api/v1/events/stream` and yields parsed event records.
 */
export interface SubscribeInput {
  event_types?: string[];
  campaign_id?: string;
  subscriber_email?: string;
}

export interface SubscribeResponse {
  subscription_id: string;
  resource_uri: string;
}

export class EventsResource extends Resource {
  /**
   * Register a declarative event subscription. Returns a subscription_id and
   * a `moosewave://events/stream` URI scoped to the requested filters.
   */
  subscribe(input: SubscribeInput): Promise<SubscribeResponse> {
    return this.client.request("POST", "/api/v1/events/subscriptions", {
      body: input,
    });
  }

  async *stream(params: StreamParams = {}): AsyncIterable<EventRecord> {
    const query: Record<string, string | undefined> = {
      event_type: params.event_type,
      campaign: params.campaign,
    };
    const resp = await this.client.fetchRaw(this.client.buildRequestUrl(
      "/api/v1/events/stream",
      query,
    ), {
      method: "GET",
      headers: this.client.buildRequestHeaders({
        Accept: "text/event-stream",
      }),
      signal: params.signal,
      credentials: this.client.credentials,
    });
    if (!resp.ok) {
      throw mapError(
        resp.status,
        await readStreamErrorBody(resp),
        resp.headers.get("x-request-id") ?? undefined,
      );
    }
    if (!resp.body) {
      throw new NetworkError({
        message: "events.stream: response body is not readable",
      });
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = normalizeSseNewlines(buf);
        if (buf.length > MAX_STREAM_BUFFER_CHARS && !buf.includes("\n\n")) {
          buf = "";
          continue;
        }
        for (const evt of drainSseBuffer(buf)) {
          buf = evt.rest;
          if (evt.record) yield evt.record;
        }
        if (buf.length > MAX_STREAM_FRAME_CHARS) buf = "";
      }
      buf += decoder.decode();
      buf = normalizeSseNewlines(buf);
      if (buf.trim()) {
        const evt = parseSseFrame(buf);
        if (evt) yield evt;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* noop */
      }
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
  }
}

function normalizeSseNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function drainSseBuffer(
  buf: string,
): Array<{ rest: string; record: EventRecord | null }> {
  const out: Array<{ rest: string; record: EventRecord | null }> = [];
  let rest = buf;
  let idx: number;
  while ((idx = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    out.push({ rest, record: parseSseFrame(frame) });
  }
  if (out.length === 0) out.push({ rest, record: null });
  return out;
}

function parseSseFrame(frame: string): EventRecord | null {
  if (frame.length > MAX_STREAM_FRAME_CHARS) return null;
  const dataLines: string[] = [];
  for (const raw of frame.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    return normalizeEventRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

function normalizeEventRecord(raw: unknown): EventRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.ts !== "string" || typeof raw.event_type !== "string") return null;

  const { metadata, ...rest } = raw;
  const record = {
    ...rest,
    ts: raw.ts,
    event_type: raw.event_type,
  } as EventRecord;

  if (metadata !== undefined) {
    if (!isRecord(metadata)) return null;
    record.metadata = metadata;
  }
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStreamErrorBody(resp: Response): Promise<unknown> {
  try {
    const text = await readTextLimited(resp, MAX_STREAM_ERROR_TEXT_BYTES);
    if (!text) return undefined;
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

async function readTextLimited(resp: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(resp.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return "";
  if (!resp.body) {
    const read = resp.text.bind(resp);
    const text = await read();
    return new TextEncoder().encode(text).byteLength > maxBytes ? "" : text;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "";
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}
