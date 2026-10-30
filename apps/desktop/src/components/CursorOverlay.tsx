/**
 * CursorOverlay — live collaborative cursors over the campaign body
 * editor.
 *
 * Cross-machine sync (active path)
 * --------------------------------
 * The Go gateway exposes POST /api/v1/events/publish (added in the
 * cross-cutting features pass). This component now publishes every
 * cursor.move payload to BOTH:
 *
 *   1. The browser's BroadcastChannel — covers same-origin tab/window
 *      sync without a network round-trip. Fast, free, offline.
 *   2. POST /api/v1/events/publish (rate-limited to 20 req/sec/user
 *      server-side; we throttle to 100ms here = 10/sec). Each publish
 *      is fanned out via the existing SSE bus to peers on other
 *      machines, and arrives back as a `cursor.move` event on
 *      useEventBus().subscribe("cursor.move", …).
 *
 * Why both? BroadcastChannel is only same-origin — two tabs on the
 * same browser. Network publish is required for actual cross-machine
 * collaboration. Keeping both means a same-origin sync is instant
 * even when the network is slow.
 *
 * Wire format is preserved verbatim so a same-origin BroadcastChannel
 * payload and the SSE-relayed payload are byte-for-byte identical:
 *
 *   {
 *     campaign_id: string,
 *     user_id:     string,
 *     user_label:  string,
 *     color:       string,            // CSS color, picked by hashUserColor
 *     x:           number,            // px, relative to editor box
 *     y:           number,            // px, relative to editor box
 *     at:          number,            // Date.now(), for fade-out
 *   }
 */

import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { publishEvent } from "../lib/api-client";
import { useEventSubscription } from "../lib/event-bus";
import { useMe } from "../lib/store";

interface Props {
  campaignId: string | number;
  /** Element the cursor coordinates are scoped to. */
  editorRef: React.RefObject<HTMLElement | null>;
}

/* ------------------------------------------------------------------ */
/*  Palette                                                            */
/* ------------------------------------------------------------------ */

/**
 * Eight distinct hues with reasonable contrast on both light + dark
 * backgrounds. The order matters — the hash function below indexes
 * directly into this list.
 */
const CURSOR_PALETTE: readonly string[] = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // amber
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;

/** Stable hash of a user id → palette slot. */
function hashUserColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % CURSOR_PALETTE.length;
  return CURSOR_PALETTE[idx] ?? CURSOR_PALETTE[0]!;
}

/* ------------------------------------------------------------------ */
/*  Wire payload                                                       */
/* ------------------------------------------------------------------ */

interface CursorMove {
  campaign_id: string;
  user_id: string;
  user_label: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

interface RemoteCursor extends CursorMove {
  /** Wall-clock time we last heard from this peer. */
  receivedAt: number;
}

const CHANNEL_NAME = "postwave/cursor-move";
const FADE_AFTER_MS = 5_000;
const THROTTLE_MS = 100;

/* ------------------------------------------------------------------ */
/*  Hook: emitter                                                      */
/* ------------------------------------------------------------------ */

/**
 * Wires `mousemove` + `select` listeners on the given element and
 * broadcasts cursor.move payloads via BroadcastChannel **and** the
 * network publish endpoint. Returns null (it's purely a side-effect
 * hook); only the event listeners are the deliverable.
 *
 * Network publish is fire-and-forget: we never throw on a 429 / 5xx
 * because cursor data is lossy by design. The next mousemove (within
 * 100ms) overwrites this one anyway.
 */
export function useCursorEmitter(
  editorEl: HTMLElement | null,
  campaignId: string,
  userId: string,
  userLabel: string,
  channel: BroadcastChannel | null,
): void {
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (!editorEl || !campaignId || !userId) return;

    const color = hashUserColor(userId);

    const send = (clientX: number, clientY: number): void => {
      const now = performance.now();
      if (now - lastSentRef.current < THROTTLE_MS) return;
      lastSentRef.current = now;
      const rect = editorEl.getBoundingClientRect();
      // Drop if the pointer left the editor — keeps stale cursors out
      // of remote views.
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
      const payload: CursorMove = {
        campaign_id: campaignId,
        user_id: userId,
        user_label: userLabel,
        color,
        x,
        y,
        at: Date.now(),
      };
      // Same-origin tab sync (synchronous, no network).
      if (channel) {
        try {
          channel.postMessage(payload);
        } catch {
          /* ignore — channel may be closed mid-event */
        }
      }
      // Cross-machine sync. We `void` the promise so a slow / failing
      // publish doesn't pile up unhandled rejections — the API client
      // already returns a result envelope rather than throwing.
      void publishEvent("cursor.move", payload as unknown as Record<string, unknown>);
    };

    const onMove = (e: MouseEvent): void => {
      send(e.clientX, e.clientY);
    };
    const onSelect = (): void => {
      // For textarea/input: emit at the caret's bounding rect when we
      // can compute one cheaply, else at the editor's top-left as a
      // soft "I'm here" ping. Most browsers don't expose caret pixel
      // coords for textareas without measuring with a ghost element,
      // so we ping the top-left so the remote cursor at least appears.
      const rect = editorEl.getBoundingClientRect();
      send(rect.left + 8, rect.top + 8);
    };

    editorEl.addEventListener("mousemove", onMove);
    editorEl.addEventListener("select", onSelect);
    return () => {
      editorEl.removeEventListener("mousemove", onMove);
      editorEl.removeEventListener("select", onSelect);
    };
  }, [editorEl, channel, campaignId, userId, userLabel]);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CursorOverlay({ campaignId, editorRef }: Props): ReactElement {
  const me = useMe();
  const userId = me?.user ?? "";
  const userLabel = me?.user ?? "anonymous";

  // Both the editor element and the BroadcastChannel live in STATE,
  // not refs: useCursorEmitter keys its effect on them, and a ref
  // read during render is null on the first pass and never triggers a
  // re-render when it's later populated — the emitter wiring would
  // start late (or never, absent an unrelated re-render). State makes
  // their arrival re-run the hook.
  const [channel, setChannel] = useState<BroadcastChannel | null>(null);
  const [editorEl, setEditorEl] = useState<HTMLElement | null>(null);
  const [remotes, setRemotes] = useState<Map<string, RemoteCursor>>(
    () => new Map(),
  );

  const idStr = useMemo(() => String(campaignId ?? ""), [campaignId]);

  // Sync the parent-owned ref into state after every commit — the
  // parent attaches the ref during the same commit that mounts us, so
  // this picks the element up immediately (and tracks re-targets).
  // The setState bails out when the element is unchanged.
  useEffect(() => {
    setEditorEl(editorRef.current);
  });

  // Set up the BroadcastChannel once. SSR / older browsers without
  // BroadcastChannel get a no-op (channel stays null).
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL_NAME);
    setChannel(ch);
    const onMessage = (ev: MessageEvent<CursorMove>): void => {
      const m = ev.data;
      if (!m || typeof m !== "object") return;
      if (m.campaign_id !== idStr) return;
      if (!m.user_id || m.user_id === userId) return; // self
      setRemotes((prev) => {
        const next = new Map(prev);
        next.set(m.user_id, { ...m, receivedAt: Date.now() });
        return next;
      });
    };
    ch.addEventListener("message", onMessage);
    return () => {
      ch.removeEventListener("message", onMessage);
      try {
        ch.close();
      } catch {
        /* ignore */
      }
      setChannel((cur) => (cur === ch ? null : cur));
    };
  }, [idStr, userId]);

  // Drive the emitter from the same channel.
  useCursorEmitter(editorEl, idStr, userId, userLabel, channel);

  // Cross-machine receive path — subscribe to "cursor.move" events on
  // the realtime bus. Server-emitted shape mirrors the BroadcastChannel
  // payload so the dispatch into setRemotes is identical (single
  // source of truth in updateRemote below). The handler is a stable
  // closure; the hook re-subscribes only when (idStr, userId) change.
  useEventSubscription<CursorMove>("cursor.move", (evt) => {
    const m = evt.payload;
    if (!m || typeof m !== "object") return;
    if (m.campaign_id !== idStr) return;
    if (!m.user_id || m.user_id === userId) return; // self
    setRemotes((prev) => {
      const next = new Map(prev);
      next.set(m.user_id, { ...m, receivedAt: Date.now() });
      return next;
    });
  });

  // Periodically prune cursors we haven't heard from in FADE_AFTER_MS.
  // 1s tick is plenty — the pill itself fades via CSS opacity based on
  // age, this only deletes it from the map after the fade completes.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (remotes.size === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [remotes.size]);
  useEffect(() => {
    setRemotes((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [k, v] of prev) {
        if (now - v.receivedAt > FADE_AFTER_MS + 1500) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [now]);

  const visible = useMemo(() => {
    const out: Array<{ key: string; cursor: RemoteCursor; opacity: number }> =
      [];
    for (const [k, c] of remotes) {
      const age = now - c.receivedAt;
      if (age > FADE_AFTER_MS + 1500) continue;
      // Linear fade from 1 → 0 over the second after FADE_AFTER_MS.
      const opacity =
        age <= FADE_AFTER_MS
          ? 1
          : Math.max(0, 1 - (age - FADE_AFTER_MS) / 1500);
      out.push({ key: k, cursor: c, opacity });
    }
    return out;
  }, [remotes, now]);

  // No cursors → render nothing (keeps the DOM clean and avoids a
  // pointer-events trap over the editor).
  if (visible.length === 0) return <></>;

  return (
    <div className="cursor-overlay" aria-hidden>
      {visible.map(({ key, cursor, opacity }) => (
        <div
          key={key}
          className="cursor-overlay-marker"
          style={{
            left: `${cursor.x}px`,
            top: `${cursor.y}px`,
            opacity,
          }}
        >
          <span
            className="cursor-overlay-caret"
            style={{ borderTopColor: cursor.color }}
          />
          <span
            className="cursor-overlay-label"
            style={{ background: cursor.color }}
          >
            {cursor.user_label}
          </span>
        </div>
      ))}
    </div>
  );
}
