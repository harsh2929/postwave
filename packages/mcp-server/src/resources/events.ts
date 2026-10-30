// SPDX-License-Identifier: MIT
import type { PostwaveClient } from "@postwave/sdk";

/**
 * Events MCP streaming resource (FF — feature-flagged).
 *
 * Templated MCP resource:
 *
 *     moosewave://events/stream{?type,campaign}
 *
 * MCP resources are pull-based: a host calls `read` and gets back the
 * current value. There is no push channel for templated resources in the
 * MCP V1 spec, so this handler batches the most recent 50 events from
 * the SDK's `events.stream()` async iterator and returns them as a
 * JSON array. Agents that want a tailing view should poll the resource
 * (e.g. every 10–30 seconds) — they SHOULD NOT expect server push.
 *
 * Query parameters:
 *   - `type`     — optional event_type filter (e.g. "opened", "clicked")
 *   - `campaign` — optional campaign id filter
 *
 * Both params are encoded into the SSE upstream as filters; the read
 * handler aborts the stream as soon as 50 events have arrived OR a soft
 * deadline of 2 seconds elapses, whichever comes first, so the MCP
 * read call always returns promptly.
 */
export interface EventsStreamTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  pattern: RegExp;
  read: (match: RegExpMatchArray) => Promise<unknown>;
}

const URI_PATTERN = /^moosewave:\/\/events\/stream(?:\?(.*))?$/;

const MAX_BATCH = 50;
const SOFT_DEADLINE_MS = 2_000;
const FILTER_VALUE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Parse the `?type=…&campaign=…` query string portion. */
export function parseEventsQuery(query: string | undefined): {
  type?: string;
  campaign?: string;
} {
  if (!query || query.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(query)) return {};
  const out: { type?: string; campaign?: string } = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = safeDecodeComponent(eq < 0 ? part : part.slice(0, eq));
    const v = eq < 0 ? "" : safeDecodeComponent(part.slice(eq + 1));
    if (!k || !v || !FILTER_VALUE_RE.test(v)) continue;
    if (k === "type" && v) out.type = v;
    else if (k === "campaign" && v) out.campaign = v;
  }
  return out;
}

function safeDecodeComponent(raw: string): string | null {
  if (!raw || raw.length > 512 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, "%20"));
    if (
      !decoded ||
      decoded !== decoded.trim() ||
      decoded.length > 256 ||
      /[\u0000-\u001f\u007f\\]/.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Pull up to `MAX_BATCH` events from `client.events.stream()` honouring
 * the soft deadline. Always closes the underlying SSE stream via
 * `AbortController.abort()` before resolving.
 */
export async function collectBatch(
  client: PostwaveClient,
  filters: { type?: string; campaign?: string },
  opts: { max?: number; deadlineMs?: number } = {},
): Promise<unknown[]> {
  const max = opts.max ?? MAX_BATCH;
  const deadlineMs = opts.deadlineMs ?? SOFT_DEADLINE_MS;

  const ac = new AbortController();
  const events: unknown[] = [];

  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    const iterable = (
      client as unknown as {
        events: {
          stream: (p: {
            event_type?: string;
            campaign?: string;
            signal?: AbortSignal;
          }) => AsyncIterable<unknown>;
        };
      }
    ).events.stream({
      event_type: filters.type,
      campaign: filters.campaign,
      signal: ac.signal,
    });

    for await (const evt of iterable) {
      events.push(evt);
      if (events.length >= max) break;
    }
  } catch (err) {
    // Abort-after-deadline is expected; ignore. Re-throw real errors.
    const e = err as { name?: string; message?: string };
    const aborted =
      e?.name === "AbortError" ||
      (e?.message ?? "").toLowerCase().includes("abort");
    if (!aborted) throw err;
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }

  return events;
}

export function eventsStreamTemplate(
  client: PostwaveClient,
): EventsStreamTemplate {
  return {
    uriTemplate: "moosewave://events/stream{?type,campaign}",
    name: "Live events (batched)",
    description:
      "Latest 50 deliverability events for this tenant. Pull-only: poll every 10–30s; MCP resources do not push.",
    mimeType: "application/json",
    pattern: URI_PATTERN,
    read: async (match) => {
      const filters = parseEventsQuery(match[1]);
      const batch = await collectBatch(client, filters);
      return batch;
    },
  };
}
