// SPDX-License-Identifier: AGPL-3.0-only
//
// stream-gate.ts — the one place that decides WHEN a server-sent-event stream
// may be opened.
//
// THE COLD-LOAD FREEZE. The dashboard opens three long-lived streams about
// three seconds into a cold load: GET /api/v1/events (the invalidation bus),
// the presence subscription on the same endpoint, and GET
// /api/v1/dashboard/live. Chrome gives an EventSource high priority. When it
// classifies the connection as slow — a ~300 ms round trip to us-west-2 rates
// as "3G" — it holds lower-priority requests behind the high-priority ones, and
// a stream never completes. Measured on staging: sixteen lazy JS chunks and
// five prefetches queued at 2.66 s were not sent until 17.67 s. One of those
// chunks is the step-up listener the shell waits for before it lifts the
// "Preparing your workspace…" overlay and clears `inert`, so every click was
// swallowed for about eighteen seconds. With the streams blocked the same load
// was interactive in 5.2 s; with Chrome told the link was 4G, 3.3 s.
//
// THE RULE. A stream carries updates to data the page does not have yet. It is
// never worth delaying the page that will render them. So no stream opens until
// the initial load has finished and the main thread has gone idle at least
// once: by then every lazy chunk and first query the first render asked for has
// been sent, and a high-priority stream can no longer queue ahead of any of
// them.
//
// WHAT THIS IS NOT. It is not a timer that hopes the queue has drained.
// `load` is the browser's own statement that the document completed every
// subresource it asked for, including the chunks that hydration injected, and
// one idle callback after it is the browser's own statement that the render
// work those chunks triggered has settled. The idle callback carries a timeout
// so a page that never goes idle still connects, and a whole-gate ceiling
// covers the pathological case where `load` itself never fires (a subresource
// that hangs rather than fails). Realtime is deferred, never withheld.
//
// RECONNECTS ARE NOT GATED. Only a stream's FIRST open waits. Once the gate is
// open it stays open for the life of the document, so backoff/reconnect timing
// and every client-side navigation afterwards are untouched.

/** A stream's own open routine, deferred until the page can afford it. */
type OpenStream = () => void;

/**
 * How long one idle callback may wait for a genuinely idle slice before the
 * browser runs it anyway. Long enough for the settling render work after
 * `load`, short enough that realtime is late by a blink, not a beat.
 */
const IDLE_TIMEOUT_MS = 1_500;

/**
 * Hard ceiling from the first stream that asks to open. `load` does not fire
 * while a subresource is still in flight, and a request that hangs rather than
 * fails would otherwise withhold realtime for the whole session. Deliberately
 * longer than the worst interactive time we measured (18–22 s was the bug; 5.2 s
 * is the fix), so it only ever fires for a page that is already broken.
 */
const CEILING_MS = 30_000;

let gateOpen = false;
let armed = false;
const waiting = new Set<{ open: OpenStream }>();
/** The armed `load` listener and ceiling timer, kept so they can be undone. */
let pendingSettle: (() => void) | null = null;
let pendingCeiling: number | null = null;

function disarm(): void {
  // Nothing can have been armed without a window; a Node-environment test that
  // opens the gate up front must not trip over one.
  if (typeof window === "undefined") {
    armed = false;
    return;
  }
  if (pendingSettle) {
    window.removeEventListener("load", pendingSettle);
    pendingSettle = null;
  }
  if (pendingCeiling !== null) {
    window.clearTimeout(pendingCeiling);
    pendingCeiling = null;
  }
  armed = false;
}

function releaseGate(): void {
  if (gateOpen) return;
  gateOpen = true;
  disarm();
  const ready = [...waiting];
  waiting.clear();
  for (const entry of ready) {
    try {
      entry.open();
    } catch {
      // One stream that throws on open must not strand the others.
    }
  }
}

function afterOneIdleSlice(run: () => void): void {
  const idle = window.requestIdleCallback;
  if (typeof idle === "function") {
    idle(run, { timeout: IDLE_TIMEOUT_MS });
    return;
  }
  // Not every browser has requestIdleCallback (Safari lacked it for years). A
  // short macrotask is the closest honest equivalent: it yields to whatever the
  // load event queued.
  window.setTimeout(run, IDLE_TIMEOUT_MS);
}

function armGate(): void {
  if (armed || gateOpen) return;
  armed = true;
  pendingCeiling = window.setTimeout(releaseGate, CEILING_MS);
  const settle = (): void => {
    afterOneIdleSlice(releaseGate);
  };
  // A stream opened after a client-side navigation finds the document already
  // complete; it waits one idle slice and no longer.
  if (document.readyState === "complete") {
    settle();
    return;
  }
  pendingSettle = settle;
  window.addEventListener("load", settle, { once: true });
}

/**
 * Run `open` as soon as the page can afford a high-priority connection, or
 * immediately if it already can. Returns a canceller for the case where the
 * caller unmounts while still waiting — call it from the same teardown that
 * would have closed the stream.
 *
 * Under SSR nothing is scheduled: every caller already reports its stream
 * closed and returns a no-op teardown when `window` or `EventSource` is
 * missing, and this must not resurrect a stream in that environment.
 */
export function whenStreamsMayOpen(open: OpenStream): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if (gateOpen) {
    open();
    return () => {};
  }
  const entry = { open };
  waiting.add(entry);
  armGate();
  return () => {
    waiting.delete(entry);
  };
}

/**
 * Forget every listener and close the gate again. For tests only: the gate is
 * document-scoped state, and a test that opened it would otherwise let the next
 * one connect immediately and prove nothing.
 */
export function resetStreamGateForTests(): void {
  gateOpen = false;
  waiting.clear();
  disarm();
}

/**
 * Open the gate now. For tests about what a stream DOES once connected
 * (reconnect backoff, gap replay, frame parsing), which would otherwise have to
 * simulate a page load to get a connection at all. Tests about WHEN a stream
 * opens drive the real `load` and idle signals instead.
 */
export function openStreamGateForTests(): void {
  releaseGate();
}
