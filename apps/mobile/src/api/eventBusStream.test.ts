import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSseParser,
  createStallWatchdog,
  EVENT_BUS_INITIAL_BACKOFF_MS,
  EVENT_BUS_MAX_BACKOFF_MS,
  EventBusBodyTooLargeError,
  initialOpenStatus,
  isEventStreamContentType,
  isStreamStalled,
  jitteredBackoff,
  nextBackoff,
  parseEventBusFrame,
  readBoundedResponseText,
  shouldResetBackoff,
  type SseFrame,
} from "./eventBusStream";

function collector() {
  const frames: SseFrame[] = [];
  const overflows: string[] = [];
  const parser = createSseParser({
    onFrame: (frame) => frames.push(frame),
    onOverflow: (reason) => overflows.push(reason),
  });
  return { frames, overflows, parser };
}

describe("createSseParser", () => {
  it("emits one frame per blank-line-terminated segment", () => {
    const { frames, parser } = collector();
    expect(parser.push('data: {"topic":"campaign.sent"}\n\n')).toBe(1);
    expect(frames).toEqual([
      { event: "message", data: '{"topic":"campaign.sent"}' },
    ]);
  });

  it("normalizes CRLF frames the same as LF", () => {
    const { frames, parser } = collector();
    parser.push('event: ping\r\ndata: {"a":1}\r\n\r\n');
    expect(frames).toEqual([{ event: "ping", data: '{"a":1}' }]);
  });

  it("joins multi-line data payloads", () => {
    const { frames, parser } = collector();
    parser.push("data: {\ndata: }\n\n");
    expect(frames[0]?.data).toBe("{\n}");
  });

  it("buffers a frame split across chunk boundaries", () => {
    const { frames, parser } = collector();
    expect(parser.push('data: {"topic":"appro')).toBe(0);
    expect(parser.pending).toBeGreaterThan(0);
    expect(parser.push('val.requested"}\n\n')).toBe(1);
    expect(frames[0]?.data).toBe('{"topic":"approval.requested"}');
  });

  it("drops comment-only keepalive frames without emitting", () => {
    const { frames, parser } = collector();
    expect(parser.push(":keepalive\n\n")).toBe(0);
    expect(parser.push(":bye max-duration\n\n")).toBe(0);
    expect(frames).toEqual([]);
  });

  it("drops an oversized frame and reports the overflow", () => {
    const frames: SseFrame[] = [];
    const overflows: string[] = [];
    const parser = createSseParser({
      onFrame: (frame) => frames.push(frame),
      onOverflow: (reason) => overflows.push(reason),
      maxFrameChars: 8,
    });
    parser.push(`data: ${"x".repeat(64)}\n\n`);
    expect(frames).toEqual([]);
    expect(overflows).toEqual(["frame"]);
  });

  it("resets an oversized buffer rather than growing without bound", () => {
    const frames: SseFrame[] = [];
    const overflows: string[] = [];
    const parser = createSseParser({
      onFrame: (frame) => frames.push(frame),
      onOverflow: (reason) => overflows.push(reason),
      maxBufferChars: 64,
    });
    parser.push("data: ".concat("y".repeat(256)));
    expect(overflows).toEqual(["buffer"]);
    expect(parser.pending).toBe(0);
    // The parser stays usable afterwards.
    parser.push('data: {"topic":"list.updated"}\n\n');
    expect(frames).toHaveLength(1);
  });

  it("flushes a trailing unterminated frame exactly once", () => {
    const { frames, parser } = collector();
    parser.push('data: {"topic":"audit.written"}');
    expect(parser.flush()).toBe(1);
    expect(parser.flush()).toBe(0);
    expect(frames).toHaveLength(1);
  });

  it("flush on an empty buffer emits nothing", () => {
    const { frames, parser } = collector();
    expect(parser.flush()).toBe(0);
    expect(frames).toEqual([]);
  });
});

describe("isStreamStalled", () => {
  it("is false inside the keepalive window", () => {
    expect(isStreamStalled(1_000, 1_000 + 74_000)).toBe(false);
  });

  it("is true once two keepalives plus margin are missed", () => {
    expect(isStreamStalled(1_000, 1_000 + 76_000)).toBe(true);
  });

  it("never fires before a first observation is recorded", () => {
    expect(isStreamStalled(0, Date.now())).toBe(false);
    expect(isStreamStalled(Number.NaN, Date.now())).toBe(false);
  });

  it("treats a non-positive timeout as disabled", () => {
    expect(isStreamStalled(1_000, 10_000_000, 0)).toBe(false);
  });
});

describe("createStallWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once the keepalive window elapses with no chunk", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ onStall, timeoutMs: 75_000 });
    vi.advanceTimersByTime(70_000);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.clear();
  });

  it("keeps a stream alive on comment-only keepalives", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ onStall, timeoutMs: 75_000 });
    // The server heartbeats every 30s; each one ticks the watchdog even
    // though it carries no frame.
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(30_000);
      watchdog.tick();
    }
    expect(onStall).not.toHaveBeenCalled();
    watchdog.clear();
  });

  it("fires at most once per connection", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ onStall, timeoutMs: 10_000 });
    vi.advanceTimersByTime(120_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.clear();
  });

  it("stops observing after clear(), and clear() is idempotent", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ onStall, timeoutMs: 10_000 });
    watchdog.clear();
    watchdog.clear();
    vi.advanceTimersByTime(120_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("jitteredBackoff", () => {
  it("stays within [base/2, base]", () => {
    const random = vi.fn<() => number>();
    random.mockReturnValue(0);
    expect(jitteredBackoff(1_000, random)).toBe(500);
    random.mockReturnValue(1);
    expect(jitteredBackoff(1_000, random)).toBe(1_000);
    random.mockReturnValue(0.5);
    expect(jitteredBackoff(1_000, random)).toBe(750);
  });

  it("never returns zero for a positive base (no hot loop)", () => {
    for (const roll of [0, 0.0001, 0.5, 0.9999, 1]) {
      expect(
        jitteredBackoff(EVENT_BUS_INITIAL_BACKOFF_MS, () => roll),
      ).toBeGreaterThan(0);
    }
  });

  it("clamps a misbehaving random source", () => {
    expect(jitteredBackoff(1_000, () => Number.NaN)).toBe(750);
    expect(jitteredBackoff(1_000, () => 12)).toBe(1_000);
    expect(jitteredBackoff(1_000, () => -3)).toBe(500);
  });

  it("returns 0 for a non-positive base", () => {
    expect(jitteredBackoff(0)).toBe(0);
    expect(jitteredBackoff(-5)).toBe(0);
  });
});

describe("nextBackoff", () => {
  it("doubles up to the ceiling", () => {
    let backoff = EVENT_BUS_INITIAL_BACKOFF_MS;
    const seen: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      backoff = nextBackoff(backoff);
      seen.push(backoff);
    }
    expect(seen.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(seen.at(-1)).toBe(EVENT_BUS_MAX_BACKOFF_MS);
  });

  it("recovers from a corrupted current value", () => {
    expect(nextBackoff(Number.NaN)).toBe(2_000);
    expect(nextBackoff(0)).toBe(2_000);
  });
});

describe("isEventStreamContentType", () => {
  it("accepts the bare media type and one carrying parameters", () => {
    expect(isEventStreamContentType("text/event-stream")).toBe(true);
    expect(isEventStreamContentType("text/event-stream; charset=utf-8")).toBe(
      true,
    );
    // Some proxies rewrite the header without the space after the semicolon.
    expect(isEventStreamContentType("text/event-stream;charset=UTF-8")).toBe(
      true,
    );
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(isEventStreamContentType("Text/Event-Stream")).toBe(true);
    expect(isEventStreamContentType("  TEXT/EVENT-STREAM ; q=1 ")).toBe(true);
  });

  it("rejects the answers that produced the reconnect storm", () => {
    // The measured case: 200 with a JSON body from something that is not the
    // stream route. Also an HTML gateway page, and an absent header — HTTP's
    // default for an undeclared body is not an event stream.
    expect(isEventStreamContentType("application/json")).toBe(false);
    expect(isEventStreamContentType("application/json; charset=utf-8")).toBe(
      false,
    );
    expect(isEventStreamContentType("text/html")).toBe(false);
    expect(isEventStreamContentType(null)).toBe(false);
    expect(isEventStreamContentType(undefined)).toBe(false);
    expect(isEventStreamContentType("")).toBe(false);
  });

  it("does not match a type that merely starts with the stream type", () => {
    expect(isEventStreamContentType("text/event-stream-plus")).toBe(false);
  });
});

describe("shouldResetBackoff", () => {
  it("resets after any chunk arrived, however brief the socket", () => {
    // A keepalive comment IS a chunk: the server answered, so the ladder has
    // done its job and the next disconnect should retry promptly.
    expect(
      shouldResetBackoff({
        sawData: true,
        wasEventStream: true,
        openedAt: 1_000,
        now: 1_050,
      }),
    ).toBe(true);
  });

  it("resets a silent-but-long-lived connection", () => {
    expect(
      shouldResetBackoff({
        sawData: false,
        wasEventStream: true,
        openedAt: 1_000,
        now: 6_000,
      }),
    ).toBe(true);
  });

  it("keeps backing off when the socket flaps open-then-closed", () => {
    // The defect this guards: a server that accepts and instantly drops would
    // otherwise reset to 1s on every attempt and never throttle.
    expect(
      shouldResetBackoff({
        sawData: false,
        wasEventStream: true,
        openedAt: 1_000,
        now: 1_400,
      }),
    ).toBe(false);
  });

  it("does not treat a non-stream body as evidence of health", () => {
    // THE STORM. A 200 carrying one JSON document delivers bytes and ends
    // immediately; before the `wasEventStream` term this returned true on the
    // first line and pinned the backoff at 1s forever.
    expect(
      shouldResetBackoff({
        sawData: true,
        wasEventStream: false,
        openedAt: 1_000,
        now: 1_050,
      }),
    ).toBe(false);
  });

  it("still credits a non-stream connection that outlived the floor", () => {
    // The duration floor is independent of what the body turned out to be: a
    // connection held for MIN_HEALTHY_OPEN_MS was not a flap, whatever it sent.
    expect(
      shouldResetBackoff({
        sawData: true,
        wasEventStream: false,
        openedAt: 1_000,
        now: 6_000,
      }),
    ).toBe(true);
  });

  it("does not reset on a corrupted clock reading", () => {
    expect(
      shouldResetBackoff({
        sawData: false,
        wasEventStream: true,
        openedAt: Number.NaN,
        now: 9e9,
      }),
    ).toBe(false);
  });
});

describe("initialOpenStatus", () => {
  it("reports connecting only for the very first attempt", () => {
    expect(
      initialOpenStatus({
        hasPriorSocket: false,
        backoffMs: EVENT_BUS_INITIAL_BACKOFF_MS,
      }),
    ).toBe("connecting");
  });

  it("reports reconnecting once the ladder has advanced", () => {
    expect(initialOpenStatus({ hasPriorSocket: false, backoffMs: 2_000 })).toBe(
      "reconnecting",
    );
  });

  it("reports reconnecting while a prior socket is still being torn down", () => {
    expect(
      initialOpenStatus({
        hasPriorSocket: true,
        backoffMs: EVENT_BUS_INITIAL_BACKOFF_MS,
      }),
    ).toBe("reconnecting");
  });
});

describe("parseEventBusFrame", () => {
  it("accepts a topiced payload and hands the whole envelope back", () => {
    const result = parseEventBusFrame(
      '{"topic":"campaign.sent","tenant_id":"t1","at":"2026-07-25T00:00:00Z"}',
    );
    expect(result).toEqual({
      ok: true,
      event: {
        topic: "campaign.sent",
        tenant_id: "t1",
        at: "2026-07-25T00:00:00Z",
      },
    });
  });

  it("separates a blank keepalive artefact from a broken wire contract", () => {
    // Only `malformed` is worth logging; conflating them made an ordinary
    // keepalive look like a protocol break.
    expect(parseEventBusFrame("")).toEqual({ ok: false, reason: "empty" });
    expect(parseEventBusFrame("not json")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("drops payloads that cannot be routed", () => {
    for (const data of [
      '{"tenant_id":"t1"}',
      '{"topic":""}',
      '{"topic":7}',
      "[]",
      "null",
    ]) {
      expect(parseEventBusFrame(data)).toEqual({
        ok: false,
        reason: "untopiced",
      });
    }
  });
});

describe("readBoundedResponseText", () => {
  function streamed(chunks: string[], contentLength?: string) {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      cancelled: () => cancelled,
      res: {
        headers: {
          get: (name: string) =>
            name === "content-length" ? (contentLength ?? null) : null,
        },
        body,
        text: async () => chunks.join(""),
      },
    };
  }

  it("reads a small streamed body whole", async () => {
    const { res } = streamed(['{"token":', '"abc"}']);
    await expect(readBoundedResponseText(res, 1024)).resolves.toBe(
      '{"token":"abc"}',
    );
  });

  it("rejects on the declared content-length before reading a byte", async () => {
    const { res } = streamed(["x"], "999999");
    await expect(readBoundedResponseText(res, 1024)).rejects.toBeInstanceOf(
      EventBusBodyTooLargeError,
    );
  });

  it("aborts an ENDLESS undeclared body mid-stream and cancels the reader", async () => {
    // The reconnect loop mints a stream token on EVERY attempt, so an endless
    // body from a captive portal would otherwise grow the heap once per retry.
    // Modelled with `pull` so the stream never completes on its own — if the
    // ceiling did not fire, this test would hang rather than pass.
    const encoder = new TextEncoder();
    let cancelled = false;
    let served = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += 1;
        controller.enqueue(encoder.encode("a".repeat(64)));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readBoundedResponseText(
        { headers: { get: () => null }, body, text: async () => "" },
        100,
      ),
    ).rejects.toBeInstanceOf(EventBusBodyTooLargeError);
    expect(cancelled).toBe(true);
    // Bounded work, not "eventually stopped": two 64-byte chunks cross 100.
    expect(served).toBeLessThanOrEqual(3);
  });

  it("bounds a body-less response by its decoded byte length, not characters", async () => {
    const res = {
      headers: { get: () => null },
      text: async () => "é".repeat(8), // 16 UTF-8 bytes, 8 characters
    };
    await expect(readBoundedResponseText(res, 16)).resolves.toHaveLength(8);
    await expect(readBoundedResponseText(res, 15)).rejects.toBeInstanceOf(
      EventBusBodyTooLargeError,
    );
  });

  it("splits a multi-byte character across chunk boundaries without corruption", async () => {
    const encoded = new TextEncoder().encode("é");
    let served = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served >= encoded.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoded.slice(served, served + 1));
        served += 1;
      },
    });
    await expect(
      readBoundedResponseText(
        { headers: { get: () => null }, body, text: async () => "" },
        64,
      ),
    ).resolves.toBe("é");
  });
});
