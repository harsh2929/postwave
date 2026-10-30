// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
    get: mocks.apiGet,
  },
  isApiError: () => false,
}));

import {
  subscribeMigrationEvents,
  type MigrationStreamDone,
} from "@/lib/migration-progress-api";
import {
  openStreamGateForTests,
  resetStreamGateForTests,
} from "@/lib/realtime/stream-gate";

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.closed = true;
  }
}

const originalEventSource = globalThis.EventSource;

// The gate that defers a stream's first open until the page has loaded and gone
// idle (lib/realtime/stream-gate.ts) is opened up front: this suite is about
// what the migration stream does once connected. WHEN it opens is proved in
// realtime-stream-gate.test.ts.
beforeEach(() => {
  resetStreamGateForTests();
  openStreamGateForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  FakeEventSource.instances = [];
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    writable: true,
    value: originalEventSource,
  });
});

describe("subscribeMigrationEvents", () => {
  it("preserves ActiveCampaign automation review counts from terminal done frames", () => {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    });
    const onDone = vi.fn<(evt: MigrationStreamDone) => void>();

    subscribeMigrationEvents("job_activecampaign", { onDone });

    const stream = FakeEventSource.instances[0];
    expect(stream.url).toBe("/api/v1/migrations/job_activecampaign/events");
    expect(stream.options).toEqual({ withCredentials: true });

    stream.emit("done", {
      status: "completed",
      resources: {
        automations: {
          imported: 0,
          skipped: 4,
          failed: 0,
          review: 4,
        },
      },
      job: {
        id: "job_activecampaign",
        source: "activecampaign",
        status: "completed",
      },
    } satisfies MigrationStreamDone);

    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: {
          automations: {
            imported: 0,
            skipped: 4,
            failed: 0,
            review: 4,
          },
        },
      }),
    );
    expect(stream.closed).toBe(true);
  });

  it("aborts polling and ignores a protected response after disconnect", async () => {
    class UnavailableEventSource {
      constructor() {
        throw new Error("SSE unavailable");
      }
    }
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      writable: true,
      value: UnavailableEventSource,
    });
    let resolvePoll!: (job: unknown) => void;
    const poll = new Promise<unknown>((resolve) => {
      resolvePoll = resolve;
    });
    mocks.apiGet.mockReturnValue(poll);
    const onSnapshot = vi.fn();
    const onDone = vi.fn();

    const disconnect = subscribeMigrationEvents("job_stale", {
      onSnapshot,
      onDone,
    });
    await Promise.resolve();
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    const signal = mocks.apiGet.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    disconnect();
    expect(signal.aborted).toBe(true);
    resolvePoll({ id: "job_stale", status: "completed" });
    await poll;
    await Promise.resolve();

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
