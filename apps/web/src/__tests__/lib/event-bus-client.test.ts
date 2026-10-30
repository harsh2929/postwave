// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectRealtimeBus } from "@/lib/realtime/event-bus-client";
import {
  openStreamGateForTests,
  resetStreamGateForTests,
} from "@/lib/realtime/stream-gate";

// Minimal EventSource stub that records addEventListener registrations and can
// synchronously emit a named event to its listeners.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners = new Map<string, Set<(ev: { data: string }) => void>>();
  onopen: ((this: unknown, ev?: unknown) => void) | null = null;
  onerror: ((this: unknown, ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: { data: string }) => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  close(): void {}
  emit(name: string, data: string): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data });
  }
}

describe("connectRealtimeBus topic listeners (SHELL-036 regression)", () => {
  beforeEach(() => {
    // See realtime-stream-gate.test.ts for WHEN a stream opens; this suite is
    // about the listeners it registers once it has.
    resetStreamGateForTests();
    openStreamGateForTests();
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("registers a listener for a caller-supplied topic and delivers it", () => {
    const seen: Array<{ topic: string; payload?: Record<string, unknown> }> = [];
    const stop = connectRealtimeBus(
      (ev) => seen.push(ev as { topic: string; payload?: Record<string, unknown> }),
      undefined,
      { topics: ["presence.entity"] },
    );
    const es = FakeEventSource.instances[0]!;
    // The bug: only the hardcoded invalidation topics were registered, so a
    // caller topic like presence.entity was silently dropped.
    expect(es.listeners.has("presence.entity")).toBe(true);

    es.emit(
      "presence.entity",
      JSON.stringify({
        topic: "presence.entity",
        payload: { entity_ref: "campaign:1", count: 2 },
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload?.entity_ref).toBe("campaign:1");
    stop();
  });

  it("still registers the default invalidation topics too", () => {
    const stop = connectRealtimeBus(() => {}, undefined, {
      topics: ["presence.update"],
    });
    const es = FakeEventSource.instances[0]!;
    expect(es.listeners.has("presence.update")).toBe(true);
    expect(es.listeners.has("campaign.created")).toBe(true); // union, not replace
    stop();
  });
});
