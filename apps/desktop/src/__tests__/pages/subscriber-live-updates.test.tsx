// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  online: "online" as "online" | "connecting" | "offline",
  stream: "open" as "connecting" | "open" | "reconnecting" | "closed",
  subscriptions: new Map<string, (event: Record<string, unknown>) => void>(),
}));

vi.mock("../../lib/online-manager", () => ({
  useOnline: () => mocks.online,
}));

vi.mock("../../lib/event-bus", () => ({
  useEventBus: () => ({ status: mocks.stream }),
  useEventSubscription: (
    topic: string,
    handler: (event: Record<string, unknown>) => void,
  ) => {
    mocks.subscriptions.set(topic, handler);
  },
}));

import { useSubscriberLiveUpdates } from "../../pages/subscribers/useSubscriberLiveUpdates";
import type { SubscribersData } from "../../pages/subscribers/useSubscribersData";
import type { SubscribersPageState } from "../../pages/subscribers/useSubscribersPageState";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let hidden = false;
const reload = vi.fn();
const backgroundReloadRef = { current: false };
const audienceMutation = vi.fn();

const state = {
  filter: "all",
  debouncedQuery: "",
  page: 1,
  sortColumn: "updated_at",
  sortOrder: "desc",
  showArchived: false,
} as SubscribersPageState;

const data = {
  rows: [
    {
      id: "subscriber-existing",
      email: "existing@example.test",
      status: "enabled",
    },
  ],
  loading: false,
  refreshing: false,
  reload,
  backgroundReloadRef,
} as unknown as SubscribersData;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
});

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.online = "online";
  mocks.stream = "open";
  mocks.subscriptions.clear();
  hidden = false;
  backgroundReloadRef.current = false;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function Probe(): ReactElement {
  const live = useSubscriberLiveUpdates(state, data, audienceMutation);
  return (
    <div className="content" data-testid="owner">
      <div ref={live.listRef} data-testid="list" />
      <span data-testid="status">{live.status}</span>
      <span data-testid="count">{live.bufferedNew.length}</span>
      <span data-testid="overflow">{String(live.bufferOverflow)}</span>
      <span data-testid="required">{String(live.reconciliationRequired)}</span>
      <button type="button" onClick={live.flushBufferedNew}>
        Flush
      </button>
    </div>
  );
}

function renderProbe(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
}

function rerender(): void {
  act(() => root?.render(<Probe />));
}

function text(id: string): string | null {
  return document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
}

function emit(topic: string, payload: Record<string, unknown> = {}): void {
  act(() => {
    mocks.subscriptions.get(topic)?.({ topic, payload });
    if (topic !== "subscriber.*") {
      mocks.subscriptions.get("subscriber.*")?.({ topic, payload });
    }
  });
}

function setScrolled(scrolled: boolean): ReturnType<typeof vi.fn> {
  const owner = document.querySelector<HTMLElement>('[data-testid="owner"]');
  const list = document.querySelector<HTMLElement>('[data-testid="list"]');
  if (!owner || !list) throw new Error("Expected subscriber scroll fixtures");
  owner.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, left: 0, right: 900 }) as DOMRect;
  list.getBoundingClientRect = () =>
    ({
      top: scrolled ? -100 : 10,
      bottom: 500,
      left: 0,
      right: 900,
    }) as DOMRect;
  const scrollTo = vi.fn();
  owner.scrollTo = scrollTo;
  void act(() => owner.dispatchEvent(new Event("scroll")));
  return scrollTo;
}

describe("subscriber live-update ownership", () => {
  it("buffers identifier-only additions on the real content scroller and flushes authoritatively", () => {
    renderProbe();
    const scrollTo = setScrolled(true);

    emit("subscriber.added", {
      id: "subscriber-new",
      email: "new@example.test",
      status: "enabled",
    });
    emit("subscriber.added", {
      id: "subscriber-new",
      email: "new@example.test",
      status: "enabled",
    });

    expect(text("count")).toBe("1");
    expect(reload).not.toHaveBeenCalled();
    expect(audienceMutation).toHaveBeenCalledTimes(2);

    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent === "Flush")
        ?.click(),
    );

    expect(text("count")).toBe("0");
    expect(backgroundReloadRef.current).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("defers hidden-window events and reconciles exactly once after visibility returns", () => {
    renderProbe();
    hidden = true;
    void act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(text("status")).toBe("paused");

    emit("subscriber.updated", { id: "subscriber-existing" });
    emit("subscriber.updated", { id: "subscriber-existing" });
    expect(reload).not.toHaveBeenCalled();
    expect(text("required")).toBe("true");

    hidden = false;
    void act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(text("status")).toBe("live");
    expect(text("required")).toBe("false");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("retains the current page through a stream interruption and reloads once on reopen", () => {
    renderProbe();
    mocks.stream = "reconnecting";
    rerender();
    expect(text("status")).toBe("reconnecting");
    expect(text("required")).toBe("true");
    expect(reload).not.toHaveBeenCalled();

    mocks.stream = "open";
    rerender();
    expect(text("status")).toBe("live");
    expect(text("required")).toBe("false");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cannot starve an authoritative reload under a continuous event burst", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    renderProbe();

    for (let index = 0; index < 8; index += 1) {
      emit("subscriber.engagement_updated", {
        subscriber_id: "subscriber-existing",
      });
      void act(() => vi.advanceTimersByTime(2_000));
    }

    expect(reload).toHaveBeenCalledTimes(1);
    emit("subscriber.engagement_updated", {
      subscriber_id: "subscriber-existing",
    });
    void act(() => vi.advanceTimersByTime(2_500));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("recovers an initially offline directory only after online and stream evidence agree", () => {
    mocks.online = "offline";
    renderProbe();
    expect(text("status")).toBe("offline");
    expect(text("required")).toBe("true");
    expect(reload).not.toHaveBeenCalled();

    mocks.online = "connecting";
    rerender();
    expect(text("status")).toBe("connecting");
    expect(reload).not.toHaveBeenCalled();

    mocks.online = "online";
    rerender();
    expect(text("status")).toBe("live");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reconciles events that could be missed before the first stream opens", () => {
    mocks.stream = "connecting";
    renderProbe();
    expect(text("status")).toBe("connecting");
    expect(text("required")).toBe("true");
    expect(reload).not.toHaveBeenCalled();

    mocks.stream = "open";
    rerender();
    expect(text("status")).toBe("live");
    expect(text("required")).toBe("false");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
