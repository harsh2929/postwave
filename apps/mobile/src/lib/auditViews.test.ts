import { describe, expect, it } from "vitest";

import {
  AUDIT_VIEW_NAME_MAX,
  DEFAULT_AUDIT_VIEW,
  SECURITY_ACTION_KEYWORDS,
  auditViewsEqual,
  decodeAuditView,
  describeAuditView,
  encodeAuditView,
  isNativeAuditView,
  isSecurityAction,
  savedViewNameError,
  sortSavedViews,
  type AuditViewState,
} from "./auditViews";

const VIEW: AuditViewState = {
  actor: "agent",
  windowKey: "24h",
  destructiveOnly: true,
  securityOnly: false,
  query: "  delete  ",
};

describe("isSecurityAction", () => {
  it("matches the web keyword slice", () => {
    expect(isSecurityAction("user.login")).toBe(true);
    expect(isSecurityAction("SCIM.token.rotate")).toBe(true);
    expect(isSecurityAction("session.revoke")).toBe(true);
    expect(isSecurityAction("campaign.send")).toBe(false);
  });

  it("treats an absent action as not-security rather than throwing", () => {
    expect(isSecurityAction(undefined)).toBe(false);
    expect(isSecurityAction(null)).toBe(false);
    expect(isSecurityAction("")).toBe(false);
  });

  it("keeps the vocabulary in step with apps/web", () => {
    // A silent divergence here means the two clients disagree about what a
    // security event is. Pinned so a one-word edit has to be deliberate.
    expect([...SECURITY_ACTION_KEYWORDS]).toEqual([
      "login",
      "logout",
      "session",
      "totp",
      "2fa",
      "mfa",
      "password",
      "oauth",
      "sso",
      "scim",
      "security",
      "token",
      "role",
      "device",
    ]);
  });
});

describe("encodeAuditView", () => {
  it("writes the desktop vocabulary alongside the mobile blob", () => {
    const blob = encodeAuditView(VIEW, "agent");
    expect(blob.days).toBe(1);
    expect(blob.actorType).toBe("agent");
    expect(blob.category).toBe("destructive");
    expect(blob.actionQuery).toBe("delete");
    expect(isNativeAuditView(blob)).toBe(true);
  });

  it("projects the security lens onto desktop's nearest category", () => {
    const blob = encodeAuditView(
      { ...DEFAULT_AUDIT_VIEW, securityOnly: true },
      undefined,
    );
    expect(blob.category).toBe("auth");
  });

  it("sends an empty actorType when the chip has no single wire value", () => {
    // serverActorTypeFor returns undefined for multi-value chips; writing
    // one of the values would silently drop the others on reload.
    const blob = encodeAuditView({ ...VIEW, actor: "user" }, undefined);
    expect(blob.actorType).toBe("");
  });
});

describe("decodeAuditView", () => {
  it("round-trips a mobile-written blob exactly", () => {
    const blob = encodeAuditView(VIEW, "agent");
    expect(decodeAuditView(blob)).toEqual({ ...VIEW, query: "delete" });
  });

  it("reads a desktop-written blob", () => {
    const desktop = {
      actorType: "agent",
      actorLabel: "",
      actionQuery: "purge",
      resourceType: "",
      resourceId: "",
      days: 30,
      category: "destructive",
    };
    expect(decodeAuditView(desktop)).toEqual({
      actor: "agent",
      windowKey: "30d",
      destructiveOnly: true,
      securityOnly: false,
      query: "purge",
    });
    expect(isNativeAuditView(desktop)).toBe(false);
  });

  it("maps desktop's auth category onto the security lens", () => {
    expect(decodeAuditView({ category: "auth" }).securityOnly).toBe(true);
  });

  it("widens rather than narrows for a desktop window mobile lacks", () => {
    // 90d has no mobile chip. Landing on 30d would make the log look emptier
    // than the saved view promised, so it widens to All.
    expect(decodeAuditView({ days: 90 }).windowKey).toBe("all");
    expect(decodeAuditView({ days: 0 }).windowKey).toBe("all");
  });

  it("falls back per-field instead of discarding a partly-broken blob", () => {
    const decoded = decodeAuditView({
      days: "seven",
      actionQuery: 12,
      category: "destructive",
      postwaveMobile: { actor: "martian", window: "1y", securityOnly: "yes" },
    });
    expect(decoded.windowKey).toBe(DEFAULT_AUDIT_VIEW.windowKey);
    expect(decoded.query).toBe(DEFAULT_AUDIT_VIEW.query);
    expect(decoded.actor).toBe("all");
    expect(decoded.destructiveOnly).toBe(true);
  });

  it("returns the base state for a non-object blob", () => {
    expect(decodeAuditView(null)).toEqual(DEFAULT_AUDIT_VIEW);
    expect(decodeAuditView("nope")).toEqual(DEFAULT_AUDIT_VIEW);
    expect(decodeAuditView([1, 2])).toEqual(DEFAULT_AUDIT_VIEW);
  });
});

describe("auditViewsEqual", () => {
  it("ignores surrounding whitespace in the query", () => {
    expect(
      auditViewsEqual(VIEW, { ...VIEW, query: "delete" }),
    ).toBe(true);
  });

  it("separates views that differ only by lens", () => {
    expect(auditViewsEqual(VIEW, { ...VIEW, securityOnly: true })).toBe(false);
  });
});

describe("describeAuditView", () => {
  it("names every active narrowing", () => {
    expect(describeAuditView({ ...VIEW, query: "delete" })).toBe(
      "24 hours · agent actions · destructive only · matching “delete”",
    );
  });

  it("discloses an approximated recall", () => {
    expect(describeAuditView(DEFAULT_AUDIT_VIEW, true)).toContain(
      "adapted from another device",
    );
  });
});

describe("savedViewNameError", () => {
  it("rejects blank and over-long names", () => {
    expect(savedViewNameError("   ", [])).toBe("Give the view a name.");
    expect(savedViewNameError("x".repeat(AUDIT_VIEW_NAME_MAX + 1), [])).toMatch(
      /under 60 characters/,
    );
  });

  it("rejects a case-insensitive duplicate", () => {
    expect(savedViewNameError("Break glass", ["break glass"])).toMatch(
      /already exists/,
    );
  });

  it("accepts a distinct name", () => {
    expect(savedViewNameError("Logins", ["Break glass"])).toBeNull();
  });
});

describe("sortSavedViews", () => {
  it("puts the most recently updated first and falls back to name", () => {
    const rows = [
      { id: "a", name: "Beta", filters: {}, updatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", name: "Alpha", filters: {} },
      { id: "c", name: "Gamma", filters: {}, updatedAt: "2026-02-01T00:00:00Z" },
      { id: "d", name: "Aardvark", filters: {} },
    ];
    expect(sortSavedViews(rows).map((v) => v.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { id: "a", name: "Beta", filters: {} },
      { id: "b", name: "Alpha", filters: {} },
    ];
    sortSavedViews(rows);
    expect(rows.map((v) => v.id)).toEqual(["a", "b"]);
  });
});
