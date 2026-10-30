import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectGarbageCollectedDomCounters } from "./collect-dom-metric.mjs";

describe("cold renderer DOM metric", () => {
  it("collects garbage before reading the renderer-wide DOM counters", async () => {
    const calls = [];
    const counters = await collectGarbageCollectedDomCounters({
      async send(method) {
        calls.push(method);
        if (method === "Memory.getDOMCounters") {
          return { documents: 1, nodes: 2378, jsEventListeners: 151 };
        }
        return {};
      },
    });

    assert.deepEqual(calls, [
      "HeapProfiler.collectGarbage",
      "Memory.getDOMCounters",
    ]);
    assert.deepEqual(counters, {
      documents: 1,
      nodes: 2378,
      jsEventListeners: 151,
    });
  });

  it("fails closed when Chromium returns malformed counters", async () => {
    await assert.rejects(
      collectGarbageCollectedDomCounters({
        async send(method) {
          return method === "Memory.getDOMCounters"
            ? { documents: 1, nodes: Number.NaN, jsEventListeners: 0 }
            : {};
        },
      }),
      /invalid garbage-collected DOM counters/,
    );
  });
});
