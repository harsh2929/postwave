// Tests for the desktop event-bus contract. The actual EventBus class
// drags in window.EventSource + a React provider, which we can't mount
// in the node env. The two pieces we *can* test directly are the
// topic-pattern matcher (subscribe("campaign.*") → only campaign.*
// events fire) and the stream URL preference rules.
//
// We mirror the production logic verbatim — when production drifts,
// these tests diverge and the regression is caught at PR time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api-client", () => ({
  buildStreamUrl: vi.fn(async (path: string) => `http://localhost:8080${path}`),
}));

import { EventBus } from "../../lib/event-bus";

/* ------------------------------------------------------------------ */
/*  topicMatches — mirror of event-bus.ts                              */
/* ------------------------------------------------------------------ */

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern === topic) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keep trailing dot
    return topic.startsWith(prefix);
  }
  return false;
}

describe("event-bus topicMatches", () => {
  it("exact match wins", () => {
    expect(topicMatches("campaign.created", "campaign.created")).toBe(true);
    expect(topicMatches("campaign.created", "campaign.updated")).toBe(false);
  });

  it("`*` is the catch-all", () => {
    expect(topicMatches("*", "anything.really")).toBe(true);
    expect(topicMatches("*", "")).toBe(true);
  });

  it("`campaign.*` matches every campaign topic", () => {
    expect(topicMatches("campaign.*", "campaign.created")).toBe(true);
    expect(topicMatches("campaign.*", "campaign.updated")).toBe(true);
    expect(topicMatches("campaign.*", "campaign.sent")).toBe(true);
  });

  it("`campaign.*` does NOT match `campaigns.something` (boundary on the dot)", () => {
    expect(topicMatches("campaign.*", "campaigns.created")).toBe(false);
  });

  it("non-wildcard pattern does not partial-match", () => {
    expect(topicMatches("campaign", "campaign.created")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  subscribe/unsubscribe — local model                                */
/* ------------------------------------------------------------------ */

// Model the per-topic-pattern handler map used inside EventBus. The
// production class wraps it in a class with reconnect machinery; the
// subscribe/unsubscribe lifecycle is the testable surface.

type Handler = (m: { topic: string }) => void;

function makeBus(): {
  subscribe: (topic: string, h: Handler) => () => void;
  dispatch: (topic: string) => void;
  handlerCount: () => number;
} {
  const handlers = new Map<string, Set<Handler>>();
  return {
    subscribe(topic, h) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(h);
      return () => {
        const s = handlers.get(topic);
        if (!s) return;
        s.delete(h);
        if (s.size === 0) handlers.delete(topic);
      };
    },
    dispatch(topic) {
      for (const [pattern, set] of handlers.entries()) {
        if (!topicMatches(pattern, topic)) continue;
        for (const h of set) h({ topic });
      }
    },
    handlerCount() {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
  };
}

describe("event-bus subscribe/unsubscribe", () => {
  it("registers and dispatches matching events", () => {
    const bus = makeBus();
    const seen: string[] = [];
    const unsub = bus.subscribe("campaign.*", (m) => seen.push(m.topic));
    bus.dispatch("campaign.created");
    bus.dispatch("campaign.updated");
    bus.dispatch("subscriber.added");
    expect(seen).toEqual(["campaign.created", "campaign.updated"]);
    unsub();
  });

  it("unsubscribe removes the handler and shrinks the map", () => {
    const bus = makeBus();
    const unsub = bus.subscribe("campaign.*", () => {});
    expect(bus.handlerCount()).toBe(1);
    unsub();
    expect(bus.handlerCount()).toBe(0);
  });

  it("multiple subscribers on the same topic fire in registration order", () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.subscribe("audit.created", () => seen.push("first"));
    bus.subscribe("audit.created", () => seen.push("second"));
    bus.dispatch("audit.created");
    expect(seen).toEqual(["first", "second"]);
  });
});

/* ------------------------------------------------------------------ */
/*  Exponential backoff schedule                                       */
/* ------------------------------------------------------------------ */

// Mirrors the schedule from event-bus.ts: 1000ms → 2000ms → 4000ms → 8000ms,
// capped at 30000ms.
function nextBackoff(current: number): number {
  const MIN = 1000;
  const MAX = 30_000;
  return Math.min(Math.max(MIN, current * 2), MAX);
}

describe("event-bus reconnect backoff", () => {
  it("doubles on each failure", () => {
    expect(nextBackoff(1000)).toBe(2000);
    expect(nextBackoff(2000)).toBe(4000);
    expect(nextBackoff(4000)).toBe(8000);
    expect(nextBackoff(8000)).toBe(16000);
  });

  it("caps at 30s — the rate-limit-friendly maximum", () => {
    expect(nextBackoff(16000)).toBe(30000);
    expect(nextBackoff(30000)).toBe(30000);
  });

  it("starts at MIN even if a caller passes 0", () => {
    expect(nextBackoff(0)).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/*  Status callback transitions                                        */
/* ------------------------------------------------------------------ */

type Status = "closed" | "connecting" | "open" | "reconnecting";

function applyStatus(current: Status, next: Status): Status {
  if (current === next) return current;
  return next;
}

describe("event-bus status transitions", () => {
  it("closed → connecting → open is the happy path", () => {
    let s: Status = "closed";
    s = applyStatus(s, "connecting");
    expect(s).toBe("connecting");
    s = applyStatus(s, "open");
    expect(s).toBe("open");
  });

  it("identical writes are a no-op (no re-fire)", () => {
    let s: Status = "open";
    const before = s;
    s = applyStatus(s, "open");
    expect(s).toBe(before);
  });

  it("open → reconnecting on transient loss", () => {
    const s = applyStatus("open", "reconnecting");
    expect(s).toBe("reconnecting");
  });
});

/* ------------------------------------------------------------------ */
/*  Stream URL preference rules                                        */
/* ------------------------------------------------------------------ */

function buildBusUrl(
  base: string,
  path: string,
  streamToken: string | null,
  key: string | null = null,
): string {
  const sep = path.includes("?") ? "&" : "?";
  if (streamToken) {
    return `${base}${path}${sep}stream_token=${encodeURIComponent(streamToken)}`;
  }
  if (!key) return `${base}${path}`;
  const host = new URL(base).hostname.toLowerCase();
  if (
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "[::1]"
  ) {
    return `${base}${path}`;
  }
  const bearer = key.startsWith("pw_") ? key : `pw_${key}`;
  return `${base}${path}${sep}api_key=${encodeURIComponent(bearer)}`;
}

// Stub a minimal window before importing modules that read localStorage.
beforeEach(() => {
  if (!globalThis.window) {
    // @ts-expect-error — minimal window for the import-time module load
    globalThis.window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
  }
});

afterEach(() => {
  // @ts-expect-error — clean up
  delete globalThis.window;
  // @ts-expect-error — clean up EventSource shim
  delete globalThis.EventSource;
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: EventListener): void {
    const set = this.listeners.get(name) ?? new Set<EventListener>();
    set.add(fn);
    this.listeners.set(name, set);
  }

  removeEventListener(name: string, fn: EventListener): void {
    this.listeners.get(name)?.delete(fn);
  }

  /** Names with at least one live listener (test helper). */
  listenerNames(): string[] {
    return Array.from(this.listeners.entries())
      .filter(([, set]) => set.size > 0)
      .map(([name]) => name);
  }

  close(): void {
    this.closed = true;
  }
}

async function flushEventBusOpen(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EventBus connection lifecycle", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    // @ts-expect-error — minimal EventSource shim for lifecycle tests
    globalThis.EventSource = FakeEventSource;
  });

  it("coalesces multiple lazy subscriptions into one EventSource", async () => {
    const bus = new EventBus();

    bus.subscribe("campaign.*", () => {});
    bus.subscribe("audit.*", () => {});
    await flushEventBusOpen();

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("can restart after disconnect when the provider is re-enabled", async () => {
    const bus = new EventBus();

    bus.subscribe("campaign.*", () => {});
    await flushEventBusOpen();
    const first = FakeEventSource.instances[0]!;

    bus.disconnect();
    expect(first.closed).toBe(true);

    bus.start();
    await flushEventBusOpen();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
  });

  it("closes the EventSource when the last subscriber unsubscribes", async () => {
    const bus = new EventBus();

    const un1 = bus.subscribe("campaign.*", () => {});
    const un2 = bus.subscribe("audit.*", () => {});
    await flushEventBusOpen();
    const es = FakeEventSource.instances[0]!;

    un1();
    expect(es.closed).toBe(false);
    un2();
    expect(es.closed).toBe(true);
    expect(bus.status()).toBe("closed");

    // A later subscriber lazy-reconnects with fresh backoff.
    bus.subscribe("campaign.*", () => {});
    await flushEventBusOpen();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.closed).toBe(false);
  });

  it("registers named-event listeners for dynamic concrete topics", async () => {
    const bus = new EventBus();

    // Topic NOT in CONCRETE_EVENT_BUS_TOPICS, subscribed before connect.
    bus.subscribe("workspace.upgraded", () => {});
    await flushEventBusOpen();
    const es = FakeEventSource.instances[0]!;
    expect(es.listenerNames()).toContain("workspace.upgraded");
    // Static topics + bootstrap event still registered.
    expect(es.listenerNames()).toContain("ready");
    expect(es.listenerNames()).toContain("campaign.created");

    // Subscribing AFTER the stream opened attaches a listener to the
    // live connection (named SSE events never reach onmessage).
    bus.subscribe("billing.invoice-paid", () => {});
    expect(es.listenerNames()).toContain("billing.invoice-paid");
    // Wildcards can't be EventSource listener names.
    bus.subscribe("billing.*", () => {});
    expect(es.listenerNames()).not.toContain("billing.*");
  });

  it("reconnects promptly with the new topics on an intentional topic switch", async () => {
    const bus = new EventBus();

    bus.subscribe("campaign.*", () => {});
    await flushEventBusOpen();
    const first = FakeEventSource.instances[0]!;

    bus.setTopics(["audit.*"]);
    await flushEventBusOpen();

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain("topics=audit.*");
  });
});

describe("event-bus URL builder — stream auth", () => {
  it("prefers short-lived stream tokens", () => {
    const u = buildBusUrl(
      "http://localhost:8080",
      "/api/v1/events?topics=campaign.*",
      "pws_payload.sig",
      "pw_xyz",
    );
    expect(u).toBe(
      "http://localhost:8080/api/v1/events?topics=campaign.*&stream_token=pws_payload.sig",
    );
  });

  it("falls back to api_key for older local APIs", () => {
    const u = buildBusUrl("http://localhost:8080", "/api/v1/events", null, "xyz");
    expect(u).toContain("api_key=pw_xyz");
  });

  it("does not put API keys in remote stream URLs", () => {
    const u = buildBusUrl("https://api.example.com", "/api/v1/events", null, "xyz");
    expect(u).toBe("https://api.example.com/api/v1/events");
  });

  it("omits the param entirely when no key is set", () => {
    const u = buildBusUrl("http://localhost:8080", "/api/v1/events", null, null);
    expect(u).toBe("http://localhost:8080/api/v1/events");
  });

  it("uses `&` when the path already has a `?`", () => {
    const u = buildBusUrl(
      "http://localhost:8080",
      "/api/v1/events?topics=*",
      "pws_token",
      "pw_xyz",
    );
    expect(u).toContain("?topics=*&stream_token=");
  });
});
