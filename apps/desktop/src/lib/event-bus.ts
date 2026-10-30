/**
 * Realtime event-bus — single shared SSE connection to GET /api/v1/events.
 *
 * One EventSource per session, multiplexed to N subscribers via local
 * pub/sub. Components call `useEventBus().subscribe("campaign.*", fn)`
 * and the bus dispatches to every matching handler.
 *
 * Mirrors the backoff + short-lived stream-token auth patterns from
 * `lib/sse.ts` (dashboard-live and per-campaign-events). No new deps — just
 * window.EventSource + React.
 */

import {
  type ReactElement,
  type ReactNode,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { buildStreamUrl } from "./api-client";
import { DEMO_DATA_FALLBACK_ENABLED } from "./config";
import {
  CONCRETE_EVENT_BUS_TOPICS,
  DEFAULT_EVENT_BUS_TOPICS,
  normalizeEventBusTopics,
} from "./event-bus-topics";
import { parseJsonStreamPayload } from "./stream-payload";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** State the bus reports to subscribers via the status hook. */
export type EventBusStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * The wire payload from the Go handler. Topic mirrors the pattern fed
 * back to the server via ?topics= (e.g. "campaign.created"). Payload is
 * an arbitrary domain-specific blob — callers narrow with type guards.
 */
export interface EventBusMessage<T = Record<string, unknown>> {
  topic: string;
  tenant_id: string;
  at: string;
  payload?: T;
}

export type EventHandler<T = Record<string, unknown>> = (
  evt: EventBusMessage<T>,
) => void;

/** Returned by `subscribe()`. Call to remove the handler. */
export type Unsubscribe = () => void;

/* ------------------------------------------------------------------ */
/*  Internal connection                                                */
/* ------------------------------------------------------------------ */

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

interface BusInternals {
  /** Per-topic-pattern list of handlers. */
  handlers: Map<string, Set<EventHandler<unknown>>>;
  /** Status listeners (for the React hook). */
  statusListeners: Set<(s: EventBusStatus) => void>;
  /** Latest status the bus reported. */
  status: EventBusStatus;
  /** Active EventSource, if any. */
  es: EventSource | null;
  /** Pending reconnect timer. */
  retryTimer: number | null;
  /** Current backoff window. */
  backoffMs: number;
  /** Whether the caller has called disconnect(). */
  stopped: boolean;
  /** True while buildStreamUrl/EventSource construction is in flight. */
  connecting: boolean;
  /** Topics CSV currently negotiated with the server. */
  topicsCsv: string;
  /** EventSource event-listener cleanup callbacks for the current connection. */
  esCleanup: Array<() => void>;
  /**
   * Connection generation. Bumped by cleanupEventSource() so an
   * in-flight connect (buildStreamUrl is async) that was superseded by
   * a topic switch / disconnect can detect it and abort instead of
   * installing a stale EventSource.
   */
  connectEpoch: number;
  /**
   * Registers a named-event listener on the CURRENT EventSource. Set
   * while a connection exists; used by subscribe() to attach listeners
   * for concrete topics that weren't known when the stream opened.
   */
  addEsTopicListener: ((name: string) => void) | null;
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern === topic) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing dot
    return topic.startsWith(prefix);
  }
  return false;
}

export class EventBus {
  private readonly state: BusInternals;

  constructor() {
    this.state = {
      handlers: new Map(),
      statusListeners: new Set(),
      status: "closed",
      es: null,
      retryTimer: null,
      backoffMs: MIN_BACKOFF_MS,
      stopped: false,
      connecting: false,
      topicsCsv: DEFAULT_EVENT_BUS_TOPICS.join(","),
      esCleanup: [],
      connectEpoch: 0,
      addEsTopicListener: null,
    };
  }

  /** Replace the currently-negotiated topic list. Forces a reconnect. */
  setTopics(topics: string[]): void {
    const csv = normalizeEventBusTopics(topics);
    if (csv === this.state.topicsCsv) return;
    this.state.topicsCsv = csv;
    if (this.state.stopped) return;
    // Intentional topic switch — reconnect promptly with a fresh
    // backoff. A pending retry timer (up to 30s) must not delay the new
    // negotiation, and the deliberate reconnect must not inflate the
    // failure backoff.
    if (this.state.retryTimer != null) {
      window.clearTimeout(this.state.retryTimer);
      this.state.retryTimer = null;
    }
    const wasActive = this.state.es != null || this.state.connecting;
    this.cleanupEventSource();
    this.state.backoffMs = MIN_BACKOFF_MS;
    if (wasActive || this.state.handlers.size > 0) {
      this.connect();
    }
  }

  subscribe<T = Record<string, unknown>>(
    topic: string,
    handler: EventHandler<T>,
  ): Unsubscribe {
    let set = this.state.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.state.handlers.set(topic, set);
    }
    set.add(handler as EventHandler<unknown>);
    // Dynamic topics: EventSource only delivers named events to exact-
    // name listeners, so a concrete topic outside the static lists must
    // get its own listener on the live connection.
    if (!topic.includes("*") && this.state.addEsTopicListener) {
      this.state.addEsTopicListener(topic);
    }
    // Lazy-connect on first subscriber.
    if (!this.state.es && !this.state.retryTimer && !this.state.stopped) {
      this.connect();
    }
    return (): void => {
      const s = this.state.handlers.get(topic);
      if (!s) return;
      s.delete(handler as EventHandler<unknown>);
      if (s.size === 0) this.state.handlers.delete(topic);
      if (this.state.handlers.size === 0) {
        // Last subscriber left — close the stream and cancel pending
        // retries. The next subscribe() lazy-connects with fresh backoff.
        if (this.state.retryTimer != null) {
          window.clearTimeout(this.state.retryTimer);
          this.state.retryTimer = null;
        }
        this.cleanupEventSource();
        this.state.backoffMs = MIN_BACKOFF_MS;
        this.setStatus("closed");
      }
    };
  }

  onStatus(fn: (s: EventBusStatus) => void): Unsubscribe {
    this.state.statusListeners.add(fn);
    // Fire current status synchronously so callers don't need a separate read.
    try {
      fn(this.state.status);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[postwave-event-bus] status listener threw");
    }
    return (): void => {
      this.state.statusListeners.delete(fn);
    };
  }

  status(): EventBusStatus {
    return this.state.status;
  }

  /** Allow a previously disconnected bus to reconnect when subscribers exist. */
  start(): void {
    if (!this.state.stopped && (this.state.es || this.state.connecting)) return;
    this.state.stopped = false;
    this.state.backoffMs = MIN_BACKOFF_MS;
    if (
      !this.state.es &&
      !this.state.retryTimer &&
      this.state.handlers.size > 0
    ) {
      this.connect();
    }
  }

  /** Tear down the EventSource and stop reconnect attempts. */
  disconnect(): void {
    this.state.stopped = true;
    this.state.connecting = false;
    if (this.state.retryTimer != null) {
      window.clearTimeout(this.state.retryTimer);
      this.state.retryTimer = null;
    }
    this.cleanupEventSource();
    this.setStatus("closed");
  }

  /* ----------------------- internal plumbing --------------------- */

  private setStatus(next: EventBusStatus): void {
    if (this.state.status === next) return;
    this.state.status = next;
    for (const fn of this.state.statusListeners) {
      try {
        fn(next);
      } catch {
        // eslint-disable-next-line no-console
        console.warn("[postwave-event-bus] status listener threw");
      }
    }
  }

  private cleanupEventSource(): void {
    this.state.connecting = false;
    this.state.connectEpoch += 1;
    this.state.addEsTopicListener = null;
    for (const fn of this.state.esCleanup) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.state.esCleanup = [];
    if (this.state.es) {
      try {
        this.state.es.close();
      } catch {
        /* ignore */
      }
      this.state.es = null;
    }
  }

  private connect(): void {
    if (this.state.stopped) return;
    if (this.state.connecting || this.state.es) return;
    // The explicit prospective-client build is entirely fixture-backed and
    // has no live server to subscribe to. Report a stable local connection
    // instead of making WebKit churn on an intentionally absent SSE route.
    if (DEMO_DATA_FALLBACK_ENABLED) {
      this.setStatus("open");
      return;
    }
    this.state.connecting = true;
    if (this.state.retryTimer != null) {
      window.clearTimeout(this.state.retryTimer);
      this.state.retryTimer = null;
    }
    this.setStatus(
      this.state.es == null && this.state.backoffMs === MIN_BACKOFF_MS
        ? "connecting"
        : "reconnecting",
    );

    const epoch = this.state.connectEpoch;
    const path = `/api/v1/events?topics=${encodeURIComponent(this.state.topicsCsv)}`;
    void (async () => {
      let url: string;
      try {
        url = await buildStreamUrl(path);
      } catch {
        if (epoch !== this.state.connectEpoch) return; // superseded
        this.state.connecting = false;
        if (this.state.stopped) return;
        // eslint-disable-next-line no-console
        console.warn("[postwave-event-bus] stream URL build failed");
        this.scheduleRetry(this.state.backoffMs);
        return;
      }
      if (epoch !== this.state.connectEpoch) return; // superseded
      if (this.state.stopped) {
        this.state.connecting = false;
        return;
      }
      let es: EventSource;
      try {
        es = new EventSource(url);
      } catch {
        this.state.connecting = false;
        // eslint-disable-next-line no-console
        console.warn("[postwave-event-bus] EventSource construction failed");
        this.scheduleRetry(this.state.backoffMs);
        return;
      }
      this.state.es = es;
      this.state.connecting = false;

      const onOpen = (): void => {
        if (this.state.stopped) return;
        this.state.backoffMs = MIN_BACKOFF_MS;
        this.setStatus("open");
      };
      es.onopen = onOpen;

      // Wire a generic message listener that catches both named events
      // (event: campaign.created) and any default-named message events.
      const generic = (ev: MessageEvent<string>): void => {
        this.dispatch(ev);
      };
      // Native EventSource only fires `addEventListener(name)` for an
      // EXACT `event: name` match, and `onmessage` does NOT fire for
      // named events — there is no catch-all. So every concrete topic
      // we care about needs its own listener: the static list below
      // plus any dynamic topics subscribers have registered (and any
      // they register later — see subscribe()).
      const registered = new Set<string>();
      const addEsTopicListener = (name: string): void => {
        if (!name || name.includes("*") || registered.has(name)) return;
        registered.add(name);
        const fn = generic as EventListener;
        es.addEventListener(name, fn);
        this.state.esCleanup.push(() => es.removeEventListener(name, fn));
      };
      // cleanupEventSource() nulls this when the connection goes away.
      this.state.addEsTopicListener = addEsTopicListener;
      addEsTopicListener("ready"); // server bootstrap event
      for (const name of this.knownConcreteTopics()) addEsTopicListener(name);
      for (const name of this.state.handlers.keys()) addEsTopicListener(name);
      // Default 'message' still covers events sent with no event: line.
      es.onmessage = generic;

      es.onerror = (): void => {
        if (this.state.stopped) return;
        // EventSource swallows the HTTP status. Treat every error the
        // same: cleanup, exponential-backoff reconnect.
        // eslint-disable-next-line no-console
        console.warn("[postwave-event-bus] stream error, will reconnect");
        this.cleanupEventSource();
        this.scheduleRetry(this.state.backoffMs);
      };
    })();
  }

  /**
   * Concrete (non-wildcard) topic names the server may emit. Keep in
   * sync with the Go emitters. NOTE: named SSE events do NOT fall
   * through to `onmessage`, so a topic missing from this list is only
   * delivered if a subscriber registered it explicitly (subscribe()
   * attaches per-topic listeners for dynamic topics).
   */
  private knownConcreteTopics(): string[] {
    return CONCRETE_EVENT_BUS_TOPICS;
  }

  private dispatch(ev: MessageEvent<string>): void {
    if (this.state.stopped) return;
    const result = parseJsonStreamPayload<EventBusMessage<unknown>>(ev.data);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        "[postwave-event-bus] payload parse failed:",
        result.message,
      );
      return;
    }
    const parsed = result.value;
    if (!parsed || typeof parsed.topic !== "string") return;
    for (const [pattern, set] of this.state.handlers.entries()) {
      if (!topicMatches(pattern, parsed.topic)) continue;
      for (const fn of set) {
        try {
          fn(parsed as EventBusMessage<Record<string, unknown>>);
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`[postwave-event-bus] handler for ${pattern} threw`);
        }
      }
    }
  }

  private scheduleRetry(waitMs: number): void {
    if (this.state.stopped) return;
    if (this.state.retryTimer != null) return;
    this.setStatus("reconnecting");
    const wait = Math.max(0, waitMs);
    this.state.backoffMs = Math.min(this.state.backoffMs * 2, MAX_BACKOFF_MS);
    this.state.retryTimer = window.setTimeout(() => {
      this.state.retryTimer = null;
      this.connect();
    }, wait);
  }
}

/* ------------------------------------------------------------------ */
/*  React glue: provider + hook                                        */
/* ------------------------------------------------------------------ */

interface EventBusContextValue {
  subscribe: <T = Record<string, unknown>>(
    topic: string,
    handler: EventHandler<T>,
  ) => Unsubscribe;
  status: EventBusStatus;
  setTopics: (topics: string[]) => void;
}

const EventBusContext = createContext<EventBusContextValue | null>(null);

export interface EventBusProviderProps {
  /** Initial topic list. Defaults to all known top-level globs. */
  topics?: string[];
  /**
   * When false, the bus stays disconnected. Useful when the host app
   * hasn't finished the auth boot yet — the SSE handshake would 401.
   */
  enabled?: boolean;
  children: ReactNode;
}

/**
 * Top-level provider. Mount once near the root. Holds a single
 * EventBus instance for the React tree's lifetime.
 */
export function EventBusProvider(props: EventBusProviderProps): ReactElement {
  const { topics, enabled = true, children } = props;
  const busRef = useRef<EventBus | null>(null);
  if (busRef.current == null) {
    busRef.current = new EventBus();
    if (topics && topics.length > 0) busRef.current.setTopics(topics);
  }
  const bus = busRef.current;
  const [status, setStatusState] = useState<EventBusStatus>(bus.status());

  // Track topic changes from props. Re-running setTopics with the same
  // CSV is a no-op inside the bus.
  useEffect(() => {
    if (topics && topics.length > 0) bus.setTopics(topics);
  }, [bus, topics]);

  // Subscribe to status changes once and reflect them into React state.
  useEffect(() => {
    return bus.onStatus(setStatusState);
  }, [bus]);

  // Tear down on unmount or when disabled flips false.
  useEffect(() => {
    if (!enabled) {
      bus.disconnect();
      return;
    }
    bus.start();
    return () => {
      bus.disconnect();
    };
  }, [bus, enabled]);

  const value = useMemo<EventBusContextValue>(
    () => ({
      subscribe: bus.subscribe.bind(bus),
      setTopics: bus.setTopics.bind(bus),
      status,
    }),
    [bus, status],
  );

  return createElement(EventBusContext.Provider, { value }, children);
}

/**
 * Hook into the bus from any descendent. Throws when used outside an
 * <EventBusProvider> so misuse is loud at dev time.
 */
export function useEventBus(): EventBusContextValue {
  const ctx = useContext(EventBusContext);
  if (!ctx) {
    throw new Error("useEventBus must be called inside <EventBusProvider>");
  }
  return ctx;
}

/**
 * Convenience hook: subscribe to a topic for the lifetime of the
 * component. Re-runs when `topic` changes; the latest `handler` is
 * always invoked (no need to memoize).
 */
export function useEventSubscription<T = Record<string, unknown>>(
  topic: string,
  handler: EventHandler<T>,
): void {
  const bus = useEventBus();
  // Always invoke the *current* handler — capture in a ref so the
  // effect's subscribe call doesn't churn on every parent render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const stable = useCallback<EventHandler<T>>((evt) => {
    handlerRef.current(evt);
  }, []);
  useEffect(() => {
    return bus.subscribe(topic, stable);
  }, [bus, topic, stable]);
}
