import { useAuthStore } from "@/store/auth";
import { eventBusRequestPath } from "./eventBusConnection";
import { parseEventBusFrame } from "./eventBusStream";
import { connectSse } from "./sseConnect";
import { buildStreamRequest } from "./streamCredentials";

/**
 * The bus's URL + credentials for one attempt. Exported because api/client.ts
 * reports the resolved connection in its diagnostics.
 */
export async function buildEventBusConnection(
  topics: string[],
  entityRef?: string | null,
): Promise<{
  url: string;
  bearer: string | null;
  /** Local-development tenant slug (legacy property name retained). */
  tenantId: string | null;
}> {
  // With no configured host `buildStreamRequest` hands back the bare path
  // (and mints nothing), which is what makes the caller's "not connected"
  // branch reachable rather than a half-formed URL.
  const request = await buildStreamRequest(
    eventBusRequestPath(topics, entityRef),
  );
  return {
    url: request.url,
    bearer: request.bearer ?? null,
    tenantId: request.tenantSlug ?? null,
  };
}

/**
 * Wire payload from the Moosewave realtime event-bus. Mirrors the
 * desktop's EventBusEvent shape so domain consumers can import the
 * same Topic strings (campaign.created, subscriber.added, ...).
 */
export interface MobileEventBusEvent<T = Record<string, unknown>> {
  topic: string;
  tenant_id: string;
  at: string;
  payload?: T;
}

export type MobileEventBusStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "unsupported"
  | "closed";

export type MobileEventBusDisconnect = () => void;

export interface ConnectEventBusOptions {
  /**
   * Gap recovery. Awaited after the socket opens and BEFORE live frames are
   * dispatched, so events published while the stream was down are replayed in
   * order (see api/eventReplay.ts). Failures here must not break the tail, so
   * a rejection is logged and swallowed.
   */
  onBeforeTail?: () => Promise<void>;
  /**
   * Called once per watchdog-forced reconnect: the socket went silent through
   * two keepalives and we aborted the read ourselves (NATIVE#9). This is the
   * only signal that distinguishes "the OS tore a suspended socket down" from
   * an ordinary server-side close, so the health store counts it (see
   * lib/eventBusStatus.ts `noteEventBusStall`) and the diagnostics screen
   * reports it. Fires BEFORE the abort, and never throws into the transport.
   */
  onStall?: () => void;
  /**
   * Per-record presence scope (SHELL-036), e.g. `"campaign:abc"`. The server
   * registers THIS connection as a viewer of that record and broadcasts the
   * membership on the `presence.entity` topic, so a detail screen can show who
   * else is looking at the same thing. Omit for workspace-global presence,
   * which every connection already contributes to just by being open.
   */
  entity?: string | null;
  /** Watchdog window; exposed for tests. */
  stallTimeoutMs?: number;
  /** Injectable jitter source; exposed for tests. */
  random?: () => number;
}

/**
 * connectEventBus opens an SSE-style stream against
 * GET /api/v1/events?topics=<csv> and pushes each parsed payload into
 * onEvent. Backoff matches the desktop wrapper (1s -> 30s, exponential) with
 * equal jitter so a fleet-wide reconnect is not synchronised (NATIVE-V#6).
 *
 * Implementation notes:
 *   - THE STREAM IS READ THROUGH `expo/fetch`, NOT THE GLOBAL `fetch`. This
 *     distinction is the whole capability. React Native's global fetch is
 *     XHR-backed and exposes no `response.body`, which is what several
 *     comments in this app generalised into "mobile cannot consume SSE";
 *     `expo/fetch` is a separate networking stack whose body IS a real
 *     `ReadableStream`, and `api/sseConnect` calls `.getReader()` on it. The
 *     frame decode is ours (api/eventBusStream) because there is still no
 *     `EventSource`.
 *   - Auth prefers short-lived /streams/token credentials. When token minting
 *     is unavailable, React Native still sends the API key in Authorization;
 *     credentials are never copied into the URL, including on localhost.
 *   - A keepalive watchdog observes EVERY chunk, including the server's 30s
 *     `:keepalive` comments. iOS routinely tears a suspended socket without
 *     surfacing an error to the awaiting reader, which used to leave the
 *     status pinned on "open" with no live updates until the process
 *     restarted (NATIVE#9).
 *   - The reconnect loop itself lives in `api/sseConnect`, shared with the
 *     other SSE routes this app opens. This function is the bus's URL, its
 *     frame decode, and nothing else.
 *
 * Returns a disconnect function that aborts the in-flight fetch and
 * stops further reconnection attempts.
 */
export function connectEventBus(
  topics: string[],
  onEvent: (evt: MobileEventBusEvent) => void,
  onStatus?: (status: MobileEventBusStatus) => void,
  options: ConnectEventBusOptions = {},
): MobileEventBusDisconnect {
  return connectSse({
    label: "event-bus",
    // Rebuilt per attempt: stream tokens live two minutes and the server
    // closes the connection at five, so a reconnect always needs a fresh one.
    buildRequest: async () => {
      const { url, bearer, tenantId } = await buildEventBusConnection(
        topics,
        options.entity,
      );
      return {
        url,
        bearer,
        tenantSlug: tenantId,
        // An unconfigured base URL hands back a BARE PATH, and `new URL()` on
        // a bare path throws — which would turn "not signed in yet" into a
        // stream error on a retry loop.
        origin: useAuthStore.getState().baseUrl ?? null,
      };
    },
    onFrame: (frame) => {
      // The decode rule (and the difference between a keepalive artefact, an
      // untopiced payload and a broken wire contract) lives in eventBusStream,
      // which is import-free and therefore node-tested.
      const result = parseEventBusFrame(frame.data);
      if (result.ok) {
        onEvent(result.event as unknown as MobileEventBusEvent);
        return;
      }
      if (result.reason === "malformed") {
        console.warn("[postwave-mobile] event-bus payload parse failed");
      }
    },
    ...(onStatus ? { onStatus } : {}),
    ...(options.onBeforeTail ? { onBeforeTail: options.onBeforeTail } : {}),
    ...(options.onStall ? { onStall: options.onStall } : {}),
    ...(options.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: options.stallTimeoutMs }
      : {}),
    ...(options.random ? { random: options.random } : {}),
  });
}
