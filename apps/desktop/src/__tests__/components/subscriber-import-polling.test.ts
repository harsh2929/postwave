// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubscriberImportPreview } from "../../lib/api-client";
import { createImportPollingLifecycle } from "../../components/subscribers/import-polling";

function preview(
  status: SubscriberImportPreview["status"] = "running",
  id = "import-1",
): SubscriberImportPreview {
  return { id, status, rows_total: 10, processed_rows: 2 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value,
  });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscriber import polling lifecycle", () => {
  it("never overlaps a slow request and schedules only after settlement", async () => {
    const first = deferred<{ data: SubscriberImportPreview }>();
    const fetchImport = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ data: preview() });
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: vi.fn(),
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImport).toHaveBeenCalledTimes(1);

    first.resolve({ data: preview() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImport).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("honors Retry-After, then resets to the normal cadence after recovery", async () => {
    const issues = vi.fn();
    const fetchImport = vi
      .fn()
      .mockResolvedValueOnce({
        error: {
          message: "sensitive upstream text",
          status: 429,
          retryAfterSeconds: 7,
        },
      })
      .mockResolvedValue({ data: preview() });
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: issues,
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "retrying", retryDelayMs: 7_000 }),
    );
    expect(JSON.stringify(issues.mock.calls)).not.toContain(
      "sensitive upstream",
    );
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImport).toHaveBeenCalledTimes(2);
    expect(issues).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImport).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it("clamps an excessive Retry-After to the configured backoff ceiling", async () => {
    const issues = vi.fn();
    const poller = createImportPollingLifecycle({
      fetchImport: vi.fn().mockResolvedValue({
        error: { message: "rate limited", status: 429, retryAfterSeconds: 999 },
      }),
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: issues,
      maxDelayMs: 5_000,
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ retryDelayMs: 5_000 }),
    );
    poller.stop();
  });

  it("uses bounded exponential backoff, surfaces stalled state, and recovers", async () => {
    const issues = vi.fn();
    const fetchImport = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "one", status: 503 } })
      .mockResolvedValueOnce({ error: { message: "two", status: 503 } })
      .mockResolvedValueOnce({ error: { message: "three", status: 503 } })
      .mockResolvedValue({ data: preview() });
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: issues,
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "retrying", retryDelayMs: 2_000 }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "retrying", retryDelayMs: 4_000 }),
    );
    await vi.advanceTimersByTimeAsync(4_000);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "stalled", retryDelayMs: 8_000 }),
    );
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchImport).toHaveBeenCalledTimes(4);
    expect(issues).toHaveBeenLastCalledWith(null);
    poller.stop();
  });

  it("pauses while hidden or offline and resumes immediately when runnable", async () => {
    const fetchImport = vi.fn().mockResolvedValue({ data: preview() });
    const issues = vi.fn();
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: issues,
    });

    setVisibility("hidden");
    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImport).not.toHaveBeenCalled();
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImport).toHaveBeenCalledTimes(1);

    setOnline(false);
    expect(issues).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "offline" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImport).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("aborts an in-flight GET when hidden and resumes without overlap", async () => {
    const signals: AbortSignal[] = [];
    const fetchImport = vi
      .fn()
      .mockImplementationOnce((_id: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () =>
            reject(new DOMException("", "AbortError")),
          );
        });
      })
      .mockImplementation((_id: string, signal: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve({ data: preview() });
      });
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData: vi.fn(),
      onTerminal: vi.fn(),
      onIssue: vi.fn(),
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    expect(signals[0].aborted).toBe(true);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImport).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    poller.stop();
  });

  it("cleans timers/listeners and ignores late results after stop", async () => {
    const pending = deferred<{ data: SubscriberImportPreview }>();
    const requestSignals: AbortSignal[] = [];
    const onData = vi.fn();
    const onTerminal = vi.fn();
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const poller = createImportPollingLifecycle({
      fetchImport: vi.fn((_importId: string, signal: AbortSignal) => {
        requestSignals.push(signal);
        return pending.promise;
      }),
      onData,
      onTerminal,
      onIssue: vi.fn(),
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(requestSignals[0]?.aborted).toBe(true);
    pending.resolve({ data: preview("ready") });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(onData).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      "online",
      expect.any(Function),
    );
    expect(removeWindowListener).toHaveBeenCalledWith(
      "offline",
      expect.any(Function),
    );
  });

  it("switches identities without overlap and discards the old result", async () => {
    const first = deferred<{ data: SubscriberImportPreview }>();
    const onData = vi.fn();
    const fetchImport = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ data: preview("running", "import-2") });
    const poller = createImportPollingLifecycle({
      fetchImport,
      onData,
      onTerminal: vi.fn(),
      onIssue: vi.fn(),
    });

    poller.start("import-1");
    await vi.advanceTimersByTimeAsync(0);
    poller.start("import-2");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImport).toHaveBeenCalledTimes(1);
    first.resolve({ data: preview("ready", "import-1") });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImport).toHaveBeenCalledTimes(2);
    expect(fetchImport.mock.calls.at(-1)?.[0]).toBe("import-2");
    expect(onData).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "import-1" }),
    );
    poller.stop();
  });
});
