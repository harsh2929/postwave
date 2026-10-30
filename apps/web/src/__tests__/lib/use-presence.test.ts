// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";

import { summarizePresence } from "@/lib/realtime/use-presence";

describe("summarizePresence", () => {
  it("prefers structured users_v2 and counts others (total - me)", () => {
    const s = summarizePresence({
      count: 3,
      users_v2: [
        { id: "u1", label: "Ada Lovelace" },
        { id: "u2", label: "Alan Turing" },
      ],
    });
    expect(s.total).toBe(3);
    expect(s.others).toBe(2);
    expect(s.viewers.map((v) => v.label)).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("falls back to the legacy flat users list", () => {
    const s = summarizePresence({ count: 2, users: ["Grace Hopper"] });
    expect(s.viewers).toEqual([{ label: "Grace Hopper" }]);
  });

  it("drops dev placeholders but keeps the count", () => {
    const s = summarizePresence({
      count: 2,
      users_v2: [{ label: "user-4821" }, { label: "Real Person" }],
    });
    expect(s.viewers.map((v) => v.label)).toEqual(["Real Person"]);
    expect(s.others).toBe(1);
  });

  it("caps the shown viewers at `max`", () => {
    const s = summarizePresence(
      { count: 9, users_v2: Array.from({ length: 8 }, (_, i) => ({ label: `P${i}` })) },
      3,
    );
    expect(s.viewers).toHaveLength(3);
    expect(s.others).toBe(8);
  });

  it("collapses multiple live connections from the same person", () => {
    const s = summarizePresence({
      count: 5,
      users_v2: [
        { id: "current", label: "Dev" },
        { id: "current", label: "Dev" },
        { id: "current", label: "Dev" },
        { id: "teammate", label: "Ada" },
        { id: "teammate", label: "Ada" },
      ],
    });

    expect(s.total).toBe(2);
    expect(s.others).toBe(1);
    expect(s.viewers).toEqual([
      { id: "current", label: "Dev" },
      { id: "teammate", label: "Ada" },
    ]);
  });

  it("deduplicates legacy identities by normalized label", () => {
    const s = summarizePresence({
      count: 3,
      users: ["Grace Hopper", " grace hopper ", "Ada Lovelace"],
    });
    expect(s.total).toBe(2);
    expect(s.others).toBe(1);
    expect(s.viewers.map((viewer) => viewer.label)).toEqual([
      "Grace Hopper",
      "Ada Lovelace",
    ]);
  });

  it("is empty + zero when alone or given nothing", () => {
    expect(summarizePresence({ count: 1 }).others).toBe(0);
    expect(summarizePresence(null)).toEqual({ viewers: [], total: 0, others: 0 });
  });
});
