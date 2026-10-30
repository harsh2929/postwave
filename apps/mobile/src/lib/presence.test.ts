import { describe, expect, it } from "vitest";

import {
  EMPTY_PRESENCE,
  excludeSelf,
  MAX_PRESENCE_VIEWERS,
  parsePresencePayload,
  presenceEntityRef,
  presenceEntityRefFor,
  presenceInitials,
  presenceSummary,
} from "./presence";

describe("parsePresencePayload", () => {
  it("prefers users_v2 so identities survive", () => {
    const snap = parsePresencePayload({
      count: 2,
      users: ["alice", "bob"],
      users_v2: [
        { id: "u1", label: "alice" },
        { id: "u2", label: "bob" },
      ],
    });
    expect(snap).toEqual({
      count: 2,
      viewers: [
        { id: "u1", label: "alice" },
        { id: "u2", label: "bob" },
      ],
      truncated: false,
    });
  });

  it("falls back to the legacy flat label list", () => {
    const snap = parsePresencePayload({ count: 1, users: ["alice"] });
    expect(snap).toEqual({
      count: 1,
      viewers: [{ id: null, label: "alice" }],
      truncated: false,
    });
  });

  it("keeps the server's connection count even when it exceeds the names", () => {
    // The server counts CONNECTIONS; a dev-mode session can be counted with no
    // resolvable identity at all. Reporting viewers.length instead would
    // disagree with every other client's badge.
    const snap = parsePresencePayload({ count: 5, users_v2: [{ id: "u1", label: "alice" }] });
    expect(snap?.count).toBe(5);
    expect(snap?.viewers).toHaveLength(1);
  });

  it("bounds the rendered viewer list but not the count", () => {
    const users = Array.from({ length: MAX_PRESENCE_VIEWERS + 4 }, (_, i) => ({
      id: `u${i}`,
      label: `user${i}`,
    }));
    const snap = parsePresencePayload({ count: users.length, users_v2: users });
    expect(snap?.viewers).toHaveLength(MAX_PRESENCE_VIEWERS);
    expect(snap?.truncated).toBe(true);
    expect(snap?.count).toBe(users.length);
  });

  it("never lets a full email address through", () => {
    // The server emits only the local part; this is the second line.
    const snap = parsePresencePayload({
      count: 1,
      users_v2: [{ id: "u1", label: "alice@example.com" }],
    });
    expect(snap?.viewers[0]?.label).toBe("alice");
  });

  it("returns null for an unusable frame so a good snapshot survives", () => {
    expect(parsePresencePayload(null)).toBeNull();
    expect(parsePresencePayload("nope")).toBeNull();
    expect(parsePresencePayload([])).toBeNull();
    expect(parsePresencePayload({})).toBeNull();
    expect(parsePresencePayload({ count: Number.NaN })).toBeNull();
  });

  it("accepts an empty-but-valid frame — the last person leaving", () => {
    expect(parsePresencePayload({ count: 0, users_v2: [] })).toEqual({
      count: 0,
      viewers: [],
      truncated: false,
    });
  });

  it("drops junk entries rather than rendering them", () => {
    const snap = parsePresencePayload({
      count: 3,
      users_v2: [{ id: "u1", label: "alice" }, null, {}, 7],
    });
    expect(snap?.viewers).toEqual([{ id: "u1", label: "alice" }]);
  });

  it("keeps an id-only entry with a placeholder label", () => {
    const snap = parsePresencePayload({ count: 1, users_v2: [{ id: "u9" }] });
    expect(snap?.viewers).toEqual([{ id: "u9", label: "Someone" }]);
  });

  it("floors and clamps a hostile count", () => {
    expect(parsePresencePayload({ count: -4, users: [] })?.count).toBe(0);
    expect(parsePresencePayload({ count: 2.7, users: [] })?.count).toBe(2);
  });
});

describe("presenceEntityRef", () => {
  it("reads the ref a scoped payload was published for", () => {
    expect(presenceEntityRef({ entity_ref: "campaign:abc" })).toBe("campaign:abc");
  });

  it("is null when absent or blank, so no record claims the frame", () => {
    expect(presenceEntityRef({})).toBeNull();
    expect(presenceEntityRef({ entity_ref: "   " })).toBeNull();
    expect(presenceEntityRef(null)).toBeNull();
  });
});

describe("presenceEntityRefFor", () => {
  it("builds the kind:id grammar web already sends", () => {
    expect(presenceEntityRefFor("campaign", "abc")).toBe("campaign:abc");
  });

  it("is null without an id, so a loading screen subscribes to nothing", () => {
    expect(presenceEntityRefFor("campaign", null)).toBeNull();
    expect(presenceEntityRefFor("campaign", "  ")).toBeNull();
  });
});

describe("excludeSelf", () => {
  const snapshot = {
    count: 3,
    viewers: [
      { id: "me", label: "alice" },
      { id: "u2", label: "bob" },
    ],
    truncated: false,
  };

  it("removes our own connection from the list and the count", () => {
    expect(excludeSelf(snapshot, "me")).toEqual({
      count: 2,
      viewers: [{ id: "u2", label: "bob" }],
      truncated: false,
    });
  });

  it("leaves the count alone when we are not in the list", () => {
    // We may be past the render bound, or unidentified. Subtracting anyway
    // would under-report every other viewer.
    expect(excludeSelf(snapshot, "someone-else").count).toBe(3);
  });

  it("is a no-op when we do not know who we are", () => {
    expect(excludeSelf(snapshot, null)).toBe(snapshot);
    expect(excludeSelf(snapshot, "  ")).toBe(snapshot);
  });

  it("subtracts only one even if duplicate ids appear", () => {
    const dupes = {
      count: 4,
      viewers: [
        { id: "me", label: "alice" },
        { id: "me", label: "alice" },
        { id: "u2", label: "bob" },
      ],
      truncated: false,
    };
    expect(excludeSelf(dupes, "me").count).toBe(3);
  });

  it("never goes negative", () => {
    expect(
      excludeSelf(
        { count: 0, viewers: [{ id: "me", label: "alice" }], truncated: false },
        "me",
      ).count,
    ).toBe(0);
  });
});

describe("presenceInitials", () => {
  it("takes one initial from a single-word label", () => {
    expect(presenceInitials("alice")).toBe("A");
  });

  it("takes two across the separators a local-part actually uses", () => {
    expect(presenceInitials("alice.smith")).toBe("AS");
    expect(presenceInitials("alice_smith")).toBe("AS");
    expect(presenceInitials("alice-smith")).toBe("AS");
    expect(presenceInitials("Alice Smith")).toBe("AS");
  });

  it("handles astral characters as one glyph, not half a surrogate pair", () => {
    expect(presenceInitials("😀nna")).toBe("😀");
  });

  it("degrades to ? rather than an empty bubble", () => {
    expect(presenceInitials("")).toBe("?");
    expect(presenceInitials("   ")).toBe("?");
  });
});

describe("presenceSummary", () => {
  it("says nothing when nobody else is here", () => {
    expect(presenceSummary(EMPTY_PRESENCE)).toBeNull();
  });

  it("names who it knows and admits to the rest", () => {
    const summary = presenceSummary({
      count: 3,
      viewers: [
        { id: "u1", label: "alice" },
        { id: "u2", label: "bob" },
      ],
      truncated: false,
    });
    expect(summary?.label).toBe("3 others here");
    expect(summary?.accessibilityLabel).toBe(
      "alice and bob and 1 more in this workspace",
    );
  });

  it("uses singular copy for one other", () => {
    const summary = presenceSummary({
      count: 1,
      viewers: [{ id: "u1", label: "alice" }],
      truncated: false,
    });
    expect(summary?.label).toBe("1 other here");
    expect(summary?.accessibilityLabel).toBe("alice in this workspace");
  });

  it("still speaks a count when the server sent no identities", () => {
    const summary = presenceSummary({ count: 2, viewers: [], truncated: false });
    expect(summary?.accessibilityLabel).toBe("2 other people in this workspace");
  });

  it("scopes the sentence to the record when asked", () => {
    const summary = presenceSummary(
      { count: 1, viewers: [{ id: "u1", label: "alice" }], truncated: false },
      "record",
    );
    expect(summary?.accessibilityLabel).toBe("alice viewing this");
  });

  it("never implies a lock", () => {
    const summary = presenceSummary({
      count: 2,
      viewers: [{ id: "u1", label: "alice" }],
      truncated: false,
    });
    const text = `${summary?.label} ${summary?.accessibilityLabel}`.toLowerCase();
    for (const forbidden of ["lock", "wait", "editing", "do not"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
