import { describe, expect, it, vi } from "vitest";

import {
  BULK_FALLBACK_REASON,
  bulkErrorReason,
  retainAfterBulkRun,
  runBulkWebhookVerb,
  type BulkWebhookRunners,
} from "./outboundWebhookBulkRun";

function hook(id: string, active = true, description?: string) {
  return {
    id,
    url: `https://receiver.example.com/hooks/${id}`,
    active,
    ...(description !== undefined ? { description } : {}),
  };
}

function runners(over: Partial<BulkWebhookRunners> = {}): BulkWebhookRunners {
  return {
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...over,
  };
}

describe("runBulkWebhookVerb", () => {
  it("calls the verb's runner once per applicable row, in list order, one at a time", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const r = runners({
      pause: vi.fn(async (id: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(id);
        await Promise.resolve();
        inFlight -= 1;
      }),
    });
    const outcome = await runBulkWebhookVerb(
      "pause",
      [hook("a", true, "A"), hook("b", true, "B"), hook("c", true, "C")],
      r,
    );
    expect(order).toEqual(["a", "b", "c"]);
    // Sequential: never two round trips at once.
    expect(maxInFlight).toBe(1);
    expect(outcome).toEqual({ succeeded: ["A", "B", "C"], failed: [], skipped: [] });
    expect(r.resume).not.toHaveBeenCalled();
    expect(r.delete).not.toHaveBeenCalled();
  });

  it("never sends a row already in the target state, and reports it as skipped by name", async () => {
    const r = runners();
    const outcome = await runBulkWebhookVerb(
      "pause",
      [hook("on", true, "Live sink"), hook("off", false, "Paused sink")],
      r,
    );
    expect(r.pause).toHaveBeenCalledTimes(1);
    expect(r.pause).toHaveBeenCalledWith("on");
    expect(outcome.skipped).toEqual(["Paused sink"]);
    expect(outcome.succeeded).toEqual(["Live sink"]);
  });

  it("routes resume to the re-enable runner and only for inactive rows", async () => {
    const r = runners();
    await runBulkWebhookVerb("resume", [hook("on", true), hook("off", false)], r);
    expect(r.resume).toHaveBeenCalledTimes(1);
    expect(r.resume).toHaveBeenCalledWith("off");
    expect(r.pause).not.toHaveBeenCalled();
  });

  it("keeps going after a refusal and quotes the server's own reason against that row", async () => {
    const r = runners({
      delete: vi.fn(async (id: string) => {
        if (id === "b") throw new Error("webhook is referenced by an active flow");
      }),
    });
    const outcome = await runBulkWebhookVerb(
      "delete",
      [hook("a", true, "A"), hook("b", true, "B"), hook("c", true, "C")],
      r,
    );
    expect(r.delete).toHaveBeenCalledTimes(3);
    expect(outcome.succeeded).toEqual(["A", "C"]);
    expect(outcome.failed).toEqual([
      { id: "b", label: "B", reason: "webhook is referenced by an active flow" },
    ]);
  });

  it("states a fallback reason when the rejection carried no message", async () => {
    const r = runners({
      pause: vi.fn(async () => {
        throw new Error("");
      }),
    });
    const outcome = await runBulkWebhookVerb("pause", [hook("a", true, "A")], r);
    expect(outcome.failed[0]?.reason).toBe(BULK_FALLBACK_REASON);
  });

  it("counts progress off from 0 of N to N of N, applicable rows only", async () => {
    const progress: [number, number][] = [];
    await runBulkWebhookVerb(
      "pause",
      [hook("a"), hook("b"), hook("off", false)],
      runners(),
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("does nothing, and says so, when no row is applicable", async () => {
    const r = runners();
    const outcome = await runBulkWebhookVerb("resume", [hook("a", true, "A")], r);
    expect(r.resume).not.toHaveBeenCalled();
    expect(outcome).toEqual({ succeeded: [], failed: [], skipped: ["A"] });
  });
});

describe("bulkErrorReason", () => {
  it("prefers the server's sentence, accepts a bare string, and falls back otherwise", () => {
    expect(bulkErrorReason(new Error("  replace the destination URL  "))).toBe(
      "replace the destination URL",
    );
    expect(bulkErrorReason("refused")).toBe("refused");
    expect(bulkErrorReason({ status: 500 })).toBe(BULK_FALLBACK_REASON);
    expect(bulkErrorReason(undefined)).toBe(BULK_FALLBACK_REASON);
  });
});

describe("retainAfterBulkRun", () => {
  it("keeps exactly the failed ids selected for retry — not the skipped ones", () => {
    expect(
      retainAfterBulkRun({
        succeeded: ["A"],
        failed: [
          { id: "b", label: "B", reason: "x" },
          { id: "d", label: "D", reason: "y" },
        ],
        skipped: ["C"],
      }),
    ).toEqual(["b", "d"]);
    expect(retainAfterBulkRun({ succeeded: [], failed: [], skipped: [] })).toEqual([]);
  });
});
