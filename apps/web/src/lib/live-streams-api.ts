/**
 * lib/live-streams-api.ts — the two server-sent event streams desktop
 * consumed and web did not.
 *
 * COVERAGE: this module wires:
 *   /api/v1/track/stream
 *   /api/v1/mcp/executions/stream
 *   /api/v1/dashboard/live
 *
 * THESE ARE NOT REQUEST/RESPONSE, WHICH IS WHY THEY LOOKED BROKEN. Probing
 * them with curl returned exit code 000 — the connection is HELD OPEN and
 * emits nothing until something happens, so a timeout reads exactly like an
 * unreachable endpoint. I recorded both as blocked on that evidence. They
 * were reachable the whole time.
 *
 * AN IDLE STREAM IS NOT A BROKEN ONE, and that distinction has to survive
 * into the UI. A consumer that shows "connecting…" forever cannot be told
 * apart from one that connected fine and has had no events, so the callback
 * surface reports connection state SEPARATELY from event arrival.
 *
 * EventSource is used rather than fetch: React Native has no streaming fetch
 * (which is why mobile cannot consume these at all), but the browser does,
 * and `withCredentials` carries the session cookie the proxy needs.
 */

import { DASHBOARD_LIVE_PATH } from "./analytics-api";
import { whenStreamsMayOpen } from "./realtime/stream-gate";

export type StreamStatus = "connecting" | "open" | "closed";

export interface StreamHandlers {
  onStatus?: (status: StreamStatus) => void;
  onEvent?: (data: unknown) => void;
  /**
   * A server-authored `event: error` frame (e.g. the dashboard stream's
   * `{code, message}` before it closes). Distinct from a transport error:
   * this one carries a sentence the server wants shown.
   */
  onServerError?: (data: unknown) => void;
}

function subscribe(
  path: string,
  handlers: StreamHandlers,
  namedEvents: readonly string[] = [],
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    // Server render, or an environment without SSE. Report closed rather than
    // leaving the caller on "connecting" forever.
    handlers.onStatus?.("closed");
    return () => undefined;
  }

  let es: EventSource | null = null;
  let stopped = false;

  const deliver = (ev: MessageEvent<string>) => {
    // A malformed frame must not kill the subscription — the stream is long
    // lived and one bad payload should cost one event, not the connection.
    try {
      handlers.onEvent?.(JSON.parse(ev.data));
    } catch {
      handlers.onEvent?.(ev.data);
    }
  };

  // Opening waits for the page to finish loading and go idle once; see
  // lib/realtime/stream-gate.ts. Until then the caller's own polling is the
  // source of truth and its status stays what it was — reporting "connecting"
  // for a stream that has not been asked for yet would be untrue, and the
  // dashboard indicator renders that difference ("Polling every 60s" rather
  // than "Connecting live updates").
  const cancelPendingOpen = whenStreamsMayOpen(() => {
    if (stopped) return;
    handlers.onStatus?.("connecting");
    try {
      es = new EventSource(path, { withCredentials: true });
    } catch {
      handlers.onStatus?.("closed");
      return;
    }
    es.onopen = () => handlers.onStatus?.("open");
    es.onmessage = deliver;
    // `onmessage` ONLY fires for frames with no `event:` line. Both Moosewave
    // streams name every frame they emit (`event: execution`, `event: track`,
    // `event: heartbeat`), so a consumer that binds only `onmessage` connects,
    // stays open, and receives nothing forever — which is indistinguishable
    // from an idle stream and was exactly the bug on the agent-tools page.
    for (const name of namedEvents) {
      es.addEventListener(name, deliver as EventListener);
    }
    if (handlers.onServerError) {
      // A named `event: error` frame is dispatched as a MessageEvent of type
      // "error" — the same type as a transport failure, which is a plain Event
      // with no data. Only the former carries the server's sentence.
      const onServerError = handlers.onServerError;
      es.addEventListener("error", (ev: Event) => {
        if (!(ev instanceof MessageEvent) || typeof ev.data !== "string") return;
        try {
          onServerError(JSON.parse(ev.data));
        } catch {
          onServerError(ev.data);
        }
      });
    }
    es.onerror = () => {
      // EventSource reconnects on its own; report the gap without tearing down.
      handlers.onStatus?.("connecting");
    };
  });

  return () => {
    stopped = true;
    cancelPendingOpen();
    handlers.onStatus?.("closed");
    es?.close();
  };
}

/**
 * Product events as they arrive. Optionally filtered by event name.
 *
 * The server names every row frame `event: track` (internal/track/extras.go),
 * so that name is bound explicitly — an `onmessage`-only listener connects,
 * stays open, and never receives a row. The `event: hello` cursor frame is
 * deliberately NOT delivered: it carries `{sinceId}`, not a product event.
 */
export function subscribeTrackStream(
  handlers: StreamHandlers,
  eventName?: string,
): () => void {
  const q = eventName ? `?event_name=${encodeURIComponent(eventName)}` : "";
  return subscribe(`/api/v1/track/stream${q}`, handlers, ["track"]);
}

export interface McpStreamScope {
  /** `all` widens past the self-identified npm-proxy user agent. */
  include?: "mcp" | "all";
  /** Exact canonical tool token; the server 400s on anything else. */
  tool?: string;
}

/**
 * Agent tool executions as they run.
 *
 * The server names every row frame `event: execution`
 * (internal/apikeycalls/stream.go), so that name is bound explicitly.
 * `heartbeat` frames are deliberately NOT delivered: they prove the
 * connection is alive, which `onStatus` already reports, and counting them
 * as executions would invent activity that never happened.
 */
export function subscribeMcpExecutions(
  handlers: StreamHandlers,
  scope: McpStreamScope = {},
): () => void {
  const params = new URLSearchParams();
  if (scope.include === "all") params.set("include", "all");
  if (scope.tool) params.set("tool", scope.tool);
  const query = params.toString();
  return subscribe(
    `/api/v1/mcp/executions/stream${query ? `?${query}` : ""}`,
    handlers,
    ["execution"],
  );
}

/**
 * The home dashboard's live stats (GET /api/v1/dashboard/live).
 *
 * The server (internal/analytics/dashboard_live.go) names every snapshot
 * frame `event: stats` — the same DashboardStats payload as
 * GET /api/v1/dashboard/stats with the rich 30-day defaults — so that name is
 * bound explicitly. `:keepalive` / `:bye` lines are SSE comments and never
 * reach a listener. A failed refresh arrives as a named `event: error` frame
 * carrying `{code, message}` before the server closes; pass `onServerError`
 * to render that sentence.
 */
export function subscribeDashboardLive(handlers: StreamHandlers): () => void {
  return subscribe(DASHBOARD_LIVE_PATH, handlers, ["stats"]);
}

/** One `event: progress` frame from GET /api/v1/subscriber-imports/{id}/progress. */
export interface ImportProgressFrame {
  status: string;
  processed_rows: number;
  total_rows: number;
  rows_imported: number;
  rows_skipped: number;
  rows_failed: number;
}

function isImportProgressFrame(value: unknown): value is ImportProgressFrame {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.status === "string" &&
    [
      "processed_rows",
      "total_rows",
      "rows_imported",
      "rows_skipped",
      "rows_failed",
    ].every((key) => typeof row[key] === "number" && Number.isFinite(row[key]))
  );
}

/**
 * Live CSV-import progress (internal/subscriber_import Progress handler). The
 * server names every frame — `event: progress` while the worker advances and
 * once more at a terminal status, `event: heartbeat` to keep proxies open, and
 * `event: closed` `{reason:"max_duration"}` when it gives up — so `progress`
 * and `closed` are bound by name. A malformed progress frame is dropped, never
 * rendered as zero rows.
 */
export function subscribeImportProgress(
  importId: string,
  handlers: {
    onStatus?: (status: StreamStatus) => void;
    onProgress: (frame: ImportProgressFrame) => void;
    onClosed?: (reason: string) => void;
  },
): () => void {
  return subscribe(
    `/api/v1/subscriber-imports/${encodeURIComponent(importId)}/progress`,
    {
      onStatus: handlers.onStatus,
      onEvent: (data) => {
        if (isImportProgressFrame(data)) {
          handlers.onProgress(data);
        } else if (
          typeof data === "object" &&
          data !== null &&
          typeof (data as { reason?: unknown }).reason === "string"
        ) {
          handlers.onClosed?.((data as { reason: string }).reason);
        }
      },
    },
    ["progress", "closed"],
  );
}
