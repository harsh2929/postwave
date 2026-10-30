import { describe, expect, it } from "vitest";

import {
  delegationCandidates,
  delegationDraftError,
  delegationDraftMessage,
  delegationRequestBody,
  parseWorkspaceMembers,
} from "./approvalDelegationDraft";

const NOW = new Date("2026-08-17T12:00:00Z");
const draft = (extra: Partial<Parameters<typeof delegationDraftError>[0]> = {}) => ({
  fromUserId: "user-me",
  toUserId: "user-sam",
  endsAt: "",
  reason: "",
  ...extra,
});

describe("delegationCandidates", () => {
  const members = [
    { id: "user-me", name: "Me", email: "me@x.com", status: "active" },
    { id: "user-sam", name: "Sam", email: "sam@x.com", status: "active" },
    { id: "user-old", name: "Old", email: "old@x.com", status: "suspended" },
    { id: "", name: "Broken", email: "", status: "active" },
  ];

  it("excludes the acting user, because the server refuses self-delegation", () => {
    // delegation.go:111 — "cannot delegate to self", also a DB constraint. The
    // obvious picker bug is listing yourself.
    expect(delegationCandidates(members, "user-me").map((m) => m.id)).not.toContain(
      "user-me",
    );
  });

  it("excludes non-active members", () => {
    // Handing approvals to a suspended account creates a queue nobody can clear.
    expect(delegationCandidates(members, "user-me").map((m) => m.id)).not.toContain(
      "user-old",
    );
  });

  it("excludes rows with no id, which could not be delegated to anyway", () => {
    expect(delegationCandidates(members, "user-me").every((m) => m.id !== "")).toBe(
      true,
    );
  });

  it("keeps the eligible colleague", () => {
    expect(delegationCandidates(members, "user-me").map((m) => m.id)).toEqual([
      "user-sam",
    ]);
  });
});

describe("delegationDraftError", () => {
  it("accepts a well-formed draft", () => {
    expect(delegationDraftError(draft(), NOW)).toBeNull();
  });

  it("mirrors each of the server's three refusals", () => {
    expect(delegationDraftError(draft({ toUserId: "" }), NOW)).toBe("no_target");
    expect(delegationDraftError(draft({ toUserId: "user-me" }), NOW)).toBe("self");
    expect(
      delegationDraftError(draft({ endsAt: "2026-08-16T12:00:00Z" }), NOW),
    ).toBe("ends_in_past");
  });

  it("refuses an endsAt equal to now, as `Before(time.Now())` would by the time it lands", () => {
    expect(
      delegationDraftError(draft({ endsAt: NOW.toISOString() }), NOW),
    ).toBe("ends_in_past");
  });

  it("accepts a future endsAt", () => {
    expect(
      delegationDraftError(draft({ endsAt: "2026-09-01T12:00:00Z" }), NOW),
    ).toBeNull();
  });

  it("treats an unparseable endsAt as invalid rather than sending it", () => {
    expect(delegationDraftError(draft({ endsAt: "next tuesday" }), NOW)).toBe(
      "ends_in_past",
    );
  });

  it("catches a missing acting user before the server says 'from required'", () => {
    expect(delegationDraftError(draft({ fromUserId: "" }), NOW)).toBe("no_actor");
  });

  it("gives every error its own sentence", () => {
    const codes = ["no_actor", "no_target", "self", "ends_in_past"] as const;
    const seen = codes.map((code) => delegationDraftMessage(code));
    expect(new Set(seen).size).toBe(codes.length);
  });
});

describe("delegationRequestBody", () => {
  it("uses the endpoint's camelCase, not this API's usual snake_case", () => {
    // delegation.go:25-34 tags are fromUserId/toUserId/startsAt. Getting this
    // wrong binds nothing and yields "tenant + from + to required".
    const body = delegationRequestBody(draft(), "2026-08-17T12:00:00Z");
    expect(body).toHaveProperty("fromUserId", "user-me");
    expect(body).toHaveProperty("toUserId", "user-sam");
    expect(body).toHaveProperty("startsAt", "2026-08-17T12:00:00Z");
    expect(body).not.toHaveProperty("from_user_id");
  });

  it("omits endsAt entirely rather than sending an empty string", () => {
    // The Go field is *time.Time; "" fails to parse rather than meaning
    // open-ended.
    expect(delegationRequestBody(draft(), "t")).not.toHaveProperty("endsAt");
    expect(
      delegationRequestBody(draft({ endsAt: "2026-09-01T00:00:00Z" }), "t"),
    ).toHaveProperty("endsAt", "2026-09-01T00:00:00Z");
  });

  it("omits an empty reason and trims a real one", () => {
    expect(delegationRequestBody(draft(), "t")).not.toHaveProperty("reason");
    expect(
      delegationRequestBody(draft({ reason: "  annual leave  " }), "t"),
    ).toHaveProperty("reason", "annual leave");
  });
});

describe("parseWorkspaceMembers", () => {
  it("reads both envelope shapes", () => {
    const rows = [{ id: "u1", name: "Ada", email: "a@x.com", status: "active" }];
    expect(parseWorkspaceMembers(rows)).toHaveLength(1);
    expect(parseWorkspaceMembers({ items: rows })).toHaveLength(1);
    expect(parseWorkspaceMembers(null)).toEqual([]);
  });

  it("never renders a bare uuid as a person's name", () => {
    // A picker showing "8f2c…" is one nobody can use.
    expect(parseWorkspaceMembers([{ id: "u1", email: "a@x.com" }])[0]?.name).toBe(
      "a@x.com",
    );
    expect(parseWorkspaceMembers([{ id: "u1" }])[0]?.name).toBe("u1");
  });

  it("drops rows with no id", () => {
    expect(parseWorkspaceMembers([{ name: "ghost" }])).toEqual([]);
  });

  it("defaults a missing status to active rather than hiding the member", () => {
    expect(parseWorkspaceMembers([{ id: "u1" }])[0]?.status).toBe("active");
  });
});
