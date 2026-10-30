import { describe, expect, it } from "vitest";

import { isSecurityAction } from "./auditViews";
import {
  recentSecurityActivity,
  securityActionLabel,
  securityActivityState,
  securityActorLine,
} from "./securityActivity";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  action: "user.login.succeeded",
  actorLabel: "ada@example.test",
  actorType: "user",
  ip: "203.0.113.4",
  at: "2026-07-20T09:00:00Z",
  ...over,
});

describe("recentSecurityActivity", () => {
  it("keeps only security actions", () => {
    const out = recentSecurityActivity(
      [
        row({ id: 1, action: "user.login.succeeded" }),
        row({ id: 2, action: "campaign.sent" }),
        row({ id: 3, action: "mfa.enrolled" }),
      ],
      isSecurityAction,
    );
    expect(out.map((r) => r.id)).toEqual([1, 3]);
  });

  it("orders newest first regardless of wire order", () => {
    const out = recentSecurityActivity(
      [
        row({ id: 1, at: "2026-07-01T00:00:00Z" }),
        row({ id: 2, at: "2026-07-20T00:00:00Z" }),
        row({ id: 3, at: "2026-07-10T00:00:00Z" }),
      ],
      isSecurityAction,
    );
    expect(out.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("caps at the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ id: i, at: `2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    expect(recentSecurityActivity(rows, isSecurityAction)).toHaveLength(5);
    expect(recentSecurityActivity(rows, isSecurityAction, 2)).toHaveLength(2);
  });

  it("is empty for an absent list rather than throwing", () => {
    expect(recentSecurityActivity(undefined, isSecurityAction)).toEqual([]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      row({ id: 1, at: "2026-07-01T00:00:00Z" }),
      row({ id: 2, at: "2026-07-20T00:00:00Z" }),
    ];
    recentSecurityActivity(rows, isSecurityAction);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("securityActorLine", () => {
  it("prefers the actor label and appends the IP", () => {
    expect(securityActorLine(row() as never)).toBe(
      "ada@example.test · 203.0.113.4",
    );
  });

  it("falls back to the actor TYPE when there is no label", () => {
    expect(
      securityActorLine(row({ actorLabel: null, ip: null }) as never),
    ).toBe("user");
  });

  it("never renders an empty run for a fully anonymous row", () => {
    expect(
      securityActorLine(
        row({ actorLabel: "", actorType: "", ip: "" }) as never,
      ),
    ).toBe("Unknown actor");
  });
});

describe("securityActionLabel", () => {
  it("turns a dotted token into a sentence fragment", () => {
    expect(securityActionLabel("user.login.succeeded")).toBe(
      "User login succeeded",
    );
    expect(securityActionLabel("api_key.rotated")).toBe("Api key rotated");
  });

  it("names an empty action rather than rendering nothing", () => {
    expect(securityActionLabel("")).toBe("Unknown action");
  });
});

describe("securityActivityState — 'we couldn't look' is never 'nothing happened'", () => {
  const base = {
    canRead: true as boolean | null,
    online: true,
    loading: false,
    failed: false,
    rowCount: 0,
  };

  it("hides itself entirely without the audit:read scope", () => {
    expect(securityActivityState({ ...base, canRead: false }).kind).toBe(
      "hidden",
    );
  });

  it("hides itself while the scope answer is still in flight", () => {
    expect(securityActivityState({ ...base, canRead: null }).kind).toBe(
      "hidden",
    );
  });

  it("reports a failed read as failed, not as an empty history", () => {
    const state = securityActivityState({ ...base, failed: true });
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toMatch(/couldn't read/i);
  });

  it("reports OFFLINE as an inability to check, not as an all-clear", () => {
    const state = securityActivityState({ ...base, online: false });
    expect(state.kind).toBe("failed");
    expect(state.kind === "failed" && state.message).toMatch(/offline/i);
  });

  it("claims 'nothing happened' only on a successful, online, loaded read", () => {
    expect(securityActivityState(base).kind).toBe("empty");
  });

  it("shows rows the moment there are any, even mid-refetch", () => {
    expect(
      securityActivityState({ ...base, loading: true, rowCount: 3 }).kind,
    ).toBe("rows");
  });

  it("shows the loading rung before anything has arrived", () => {
    expect(securityActivityState({ ...base, loading: true }).kind).toBe(
      "loading",
    );
  });
});
