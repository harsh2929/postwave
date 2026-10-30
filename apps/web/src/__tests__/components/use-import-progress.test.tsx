// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The CSV import wizard follows a running import over server-sent events
// (GET /api/v1/subscriber-imports/{id}/progress) and falls back to the 1.5 s
// poll when the browser cannot open a stream. Asserted by the URL the stream
// opens, the frames it accepts, the single final read, and the poll cadence.

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useImportProgress,
  type ImportProgress,
} from "@/components/subscribers/useImportProgress";
import { openStreamGateForTests } from "@/lib/realtime/stream-gate";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    super();
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  /** Browser semantics: a named frame reaches only listeners for that name. */
  emit(name: string | null, data: string): void {
    const event = new MessageEvent(name ?? "message", { data });
    if (name === null) this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    this.closed = true;
  }
}

const FULL_STATE = {
  id: "imp_1",
  status: "ready",
  rows_total: 10,
  rows_imported: 9,
  rows_skipped: 1,
  rows_failed: 0,
  processed_rows: 10,
  configuration_revision: 3,
  dry_run_results: { would_add: 9 },
};

let fetchMock: ReturnType<typeof vi.fn>;
let getCalls: string[];

function stubFetch(body: unknown = FULL_STATE) {
  getCalls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    getCalls.push(new URL(url, "http://localhost").pathname);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

let root: Root | null = null;
let latest: ImportProgress | null = null;

function Probe({ id, active }: { id: string | null; active: boolean }) {
  const progress = useImportProgress(id, active);
  useEffect(() => {
    latest = progress;
  });
  return null;
}

async function mount(id: string | null = "imp_1", active = true) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(Probe, { id, active }));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // See realtime-stream-gate.test.ts for WHEN a stream opens; this suite is
  // about the progress frames it folds once connected.
  openStreamGateForTests();
  FakeEventSource.instances = [];
  latest = null;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useImportProgress", () => {
  it("opens the import's progress stream with credentials and folds progress frames onto the state", async () => {
    stubFetch();
    await mount();
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/v1/subscriber-imports/imp_1/progress");
    expect(es.init?.withCredentials).toBe(true);

    await act(async () => es.open());
    expect(latest?.source).toBe("stream");
    await act(async () => {
      es.emit(
        "progress",
        JSON.stringify({
          status: "importing",
          processed_rows: 4,
          total_rows: 10,
          rows_imported: 3,
          rows_skipped: 1,
          rows_failed: 0,
        }),
      );
    });
    expect(latest?.state).toMatchObject({
      status: "importing",
      processed_rows: 4,
      rows_total: 10,
      rows_imported: 3,
    });
    expect(latest?.done).toBe(false);
    // No poll while the stream is delivering.
    expect(getCalls).toEqual([]);
  });

  it("makes one full read when the stream reports a terminal status, then reports done", async () => {
    stubFetch();
    await mount();
    const es = FakeEventSource.instances[0]!;
    await act(async () => es.open());
    await act(async () => {
      es.emit(
        "progress",
        JSON.stringify({
          status: "ready",
          processed_rows: 10,
          total_rows: 10,
          rows_imported: 9,
          rows_skipped: 1,
          rows_failed: 0,
        }),
      );
    });
    await flush();
    expect(getCalls).toEqual(["/api/v1/subscriber-imports/imp_1"]);
    expect(latest?.done).toBe(true);
    expect(latest?.state).toMatchObject({
      status: "ready",
      dry_run_results: { would_add: 9 },
    });
  });

  it("drops a malformed progress frame instead of rendering it as zero rows", async () => {
    stubFetch();
    await mount();
    const es = FakeEventSource.instances[0]!;
    await act(async () => es.open());
    await act(async () => {
      es.emit("progress", JSON.stringify({ status: "importing" }));
    });
    expect(latest?.state).toBeNull();
  });

  it("polls every 1.5 s when the browser has no EventSource", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", undefined);
    stubFetch({ ...FULL_STATE, status: "importing", processed_rows: 2 });
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(latest?.source).toBe("poll");
    expect(getCalls).toEqual(["/api/v1/subscriber-imports/imp_1"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(getCalls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getCalls).toHaveLength(2);
    expect(latest?.done).toBe(false);
  });

  it("falls back to polling when the server closes the stream early", async () => {
    stubFetch({ ...FULL_STATE, status: "importing" });
    await mount();
    const es = FakeEventSource.instances[0]!;
    await act(async () => es.open());
    await act(async () => {
      es.emit("closed", JSON.stringify({ reason: "max_duration" }));
    });
    await flush();
    expect(latest?.source).toBe("poll");
    expect(getCalls).toEqual(["/api/v1/subscriber-imports/imp_1"]);
  });

  it("opens nothing while inactive or without an id, and closes the stream on unmount", async () => {
    stubFetch();
    await mount(null, true);
    expect(FakeEventSource.instances).toHaveLength(0);
    act(() => root?.unmount());
    root = null;
    await mount("imp_1", false);
    expect(FakeEventSource.instances).toHaveLength(0);
    act(() => root?.unmount());
    root = null;
    await mount("imp_1", true);
    const es = FakeEventSource.instances[0]!;
    act(() => root?.unmount());
    root = null;
    expect(es.closed).toBe(true);
  });
});
