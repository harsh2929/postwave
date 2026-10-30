// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { parseFilters, printEvent } from "../src/commands/logs.js";

describe("logs filters", () => {
  it("parses event_type filter", () => {
    const f = parseFilters("event_type=opened");
    expect(f.event_type).toBe("opened");
  });

  it("parses campaign filter and aliases campaign_id", () => {
    expect(parseFilters("campaign=cmp_1").campaign).toBe("cmp_1");
    expect(parseFilters("campaign_id=cmp_2").campaign).toBe("cmp_2");
  });

  it("collects extra filters", () => {
    const f = parseFilters(["event_type=opened", "country=US"]);
    expect(f.event_type).toBe("opened");
    expect(f.extra.country).toBe("US");
  });

  it("handles undefined / empty input", () => {
    expect(parseFilters(undefined)).toEqual({ extra: {} });
  });
});

describe("printEvent", () => {
  it("writes one line per event including type and email", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    printEvent({
      ts: "2026-05-01T00:00:00Z",
      event_type: "opened",
      subscriber_email: "a@example.com",
      campaign_id: "cmp_1",
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("opened");
    expect(line).toContain("a@example.com");
    expect(line).toContain("cmp_1");
    spy.mockRestore();
  });
});

describe("fake SSE source consumer", () => {
  // A minimal in-memory async iterable mimicking client.events.stream(),
  // demonstrating that downstream code can iterate without real network IO.
  it("iterates a fake stream", async () => {
    async function* fake() {
      yield { ts: "t1", event_type: "delivered" };
      yield { ts: "t2", event_type: "opened" };
    }
    const out: string[] = [];
    for await (const e of fake()) out.push(e.event_type);
    expect(out).toEqual(["delivered", "opened"]);
  });
});
