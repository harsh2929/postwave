/**
 * The audited SMS conversations export had NO timeout on its fetch.
 *
 * The screen that calls it latches a spinner and disables the button for the
 * duration, so a connection that stalls after the handshake left the operator
 * on a dead control with no way out but killing the app — and React Native's
 * fetch inherits platform socket timeouts that are minutes long at best.
 *
 * These tests drive the real function against a fetch that never settles, so
 * they fail if the timer is removed. They also pin the two things a naive
 * timeout would break: a large-but-healthy body must not be killed by the
 * response deadline, and the caller's own cancel must still work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  exportSmsConversationsCsv,
  SMS_EXPORT_TIMEOUT_MESSAGE,
} from "./smsConversationsExport";

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      apiKey: null,
      baseUrl: "https://api.example.com",
      mode: "session",
      session: { workspaceSlug: "acme" },
      tenantId: null,
    }),
  },
}));

const TRUTH: Record<string, string> = {
  "X-Postwave-Export-Limit": "10000",
  "X-Postwave-Export-As-Of": "2026-08-21T10:00:00Z",
  "X-Postwave-Export-Row-Count": "2",
  "X-Postwave-Truncated": "false",
};

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const aborted = () => Object.assign(new Error("Aborted"), { name: "AbortError" });

/**
 * A fetch that never answers, rejecting the way the platform does when its
 * signal aborts — INCLUDING the spec's synchronous rejection for a signal that
 * was already aborted before the call. Modelling only the listener would make
 * the pre-aborted case hang here while working in production, which is the
 * wrong direction for a test to be wrong in.
 */
function neverAnswers(): void {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(aborted());
          return;
        }
        init.signal?.addEventListener("abort", () => reject(aborted()));
      }),
  );
}

describe("the export cannot hang forever", () => {
  it("gives up on a server that never answers", async () => {
    neverAnswers();
    const promise = exportSmsConversationsCsv({ reason: "compliance review" });
    const assertion = expect(promise).rejects.toThrow(SMS_EXPORT_TIMEOUT_MESSAGE);

    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });

  it("does not give up while the response deadline is still running", async () => {
    neverAnswers();
    const promise = exportSmsConversationsCsv({ reason: "compliance review" });
    let settled = false;
    void promise.catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    // Drain it so the rejection is not unhandled.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(promise).rejects.toThrow();
  });

  it("restarts the clock for the bytes once the server has answered", async () => {
    // A year of conversations is a big CSV. A single deadline generous enough
    // for those bytes would also be generous for a connection that is dead,
    // which is the whole reason there are two clocks.
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => TRUTH[name] ?? null },
        text: () =>
          new Promise<string>((resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(aborted()));
            // Slower than the 30s response budget, well inside the 120s body one.
            setTimeout(() => resolve("phone_e164\n+15551234567\n"), 60_000);
          }),
      } as unknown as Response),
    );

    const promise = exportSmsConversationsCsv({ reason: "compliance review" });
    await vi.advanceTimersByTimeAsync(61_000);

    const result = await promise;
    expect(result.csv).toContain("+15551234567");
  });

  it("still honours a cancel from the caller, and does not blame a timeout", async () => {
    neverAnswers();
    const controller = new AbortController();
    const promise = exportSmsConversationsCsv({
      reason: "compliance review",
      signal: controller.signal,
    });
    const assertion = expect(promise).rejects.toThrow(/Aborted/u);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    // The operator left the screen; telling them the export "took too long"
    // would be a false explanation for something they did on purpose.
    await assertion;
  });

  it("aborts immediately when handed a signal that is already aborted", async () => {
    neverAnswers();
    const controller = new AbortController();
    controller.abort();

    await expect(
      exportSmsConversationsCsv({
        reason: "compliance review",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Aborted/u);
  });
});
