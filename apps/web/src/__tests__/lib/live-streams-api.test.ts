// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The product-event live tail must receive the frames the server actually
// emits. internal/track/extras.go writes every row as a NAMED frame
// (`event: track`), and EventSource only routes UNNAMED frames to
// `onmessage` — so a subscription that listens with `onmessage` alone
// connects, reports "open", and never receives a single row. This fake
// dispatches frames exactly the way a browser does: a named frame reaches
// listeners registered for that name and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeTrackStream } from "@/lib/live-streams-api";
import {
  openStreamGateForTests,
  resetStreamGateForTests,
} from "@/lib/realtime/stream-gate";

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

  /** Browser semantics: `event: <name>` frames never reach `onmessage`. */
  emit(name: string | null, data: string): void {
    const event = new MessageEvent(name ?? "message", { data });
    if (name === null) this.onmessage?.(event);
    this.dispatchEvent(event);
  }

  close(): void {
    this.closed = true;
  }
}

const TRACK_ROW = {
  id: 42,
  tenantId: "22222222-2222-4222-8222-222222222222",
  subscriberId: "33333333-3333-4333-8333-333333333333",
  eventName: "checkout_started",
  properties: { cart: 3 },
  occurredAt: "2026-09-12T10:00:00Z",
  receivedAt: "2026-09-12T10:00:01Z",
};

// The gate that defers a stream's first open until the page has loaded
// and gone idle (lib/realtime/stream-gate.ts) is opened up front here:
// these tests are about what a stream does once connected. WHEN it opens
// is proved in realtime-stream-gate.test.ts.
beforeEach(() => {
  resetStreamGateForTests();
  openStreamGateForTests();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("subscribeTrackStream", () => {
  it("delivers the server's named `event: track` frames to onEvent", () => {
    const onEvent = vi.fn((_data: unknown) => undefined);
    const onStatus = vi.fn((_status: string) => undefined);
    const unsubscribe = subscribeTrackStream(
      { onEvent, onStatus },
      "checkout_started",
    );
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/v1/track/stream?event_name=checkout_started");
    expect(source.init).toEqual({ withCredentials: true });

    source.open();
    expect(onStatus).toHaveBeenLastCalledWith("open");

    source.emit("track", JSON.stringify(TRACK_ROW));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toEqual(TRACK_ROW);

    unsubscribe();
    expect(source.closed).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith("closed");
  });

  it("does not deliver the `event: hello` cursor frame as a product event", () => {
    const onEvent = vi.fn((_data: unknown) => undefined);
    subscribeTrackStream({ onEvent });
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/v1/track/stream");
    source.emit("hello", JSON.stringify({ sinceId: 41 }));
    expect(onEvent).not.toHaveBeenCalled();
  });
});
