import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTOR_FILTERS,
  classifyAction,
  matchesAuditActor,
  serverActorTypeFor,
  severityLabel,
  severityTone,
} from "./auditSeverity";

describe("classifyAction", () => {
  it("treats an empty or missing action as ops", () => {
    expect(classifyAction("")).toBe("ops");
    expect(classifyAction(undefined as unknown as string)).toBe("ops");
  });

  it("ranks destructive above export above auth", () => {
    // Contains both "export" and "delete" — destructive must win.
    expect(classifyAction("subscriber.export.delete")).toBe("destructive");
    // Contains both "export" and "token" — export must win over auth.
    expect(classifyAction("api_token.export")).toBe("export");
    expect(classifyAction("session.login")).toBe("auth");
  });

  it("is case-insensitive and matches substrings of dotted actions", () => {
    expect(classifyAction("Campaign.ARCHIVE")).toBe("destructive");
    expect(classifyAction("settings.patched")).toBe("ops");
  });
});

describe("severity presentation", () => {
  it("labels and tones every severity distinctly", () => {
    const labels = (["destructive", "auth", "export", "ops"] as const).map(
      severityLabel,
    );
    expect(new Set(labels).size).toBe(4);
    expect(severityTone("destructive")).toBe("danger");
    expect(severityTone("auth")).toBe("warning");
    expect(severityTone("export")).toBe("info");
    expect(severityTone("ops")).toBe("neutral");
  });
});

describe("actor chip vocabulary", () => {
  const namedKeys = AUDIT_ACTOR_FILTERS.filter((f) => f.key !== "all").map(
    (f) => f.key,
  );

  it("ends with a catch-all so no row is unreachable", () => {
    expect(AUDIT_ACTOR_FILTERS.at(-1)?.key).toBe("other");
  });

  it("puts every arbitrary actor_type under exactly one non-all chip", () => {
    const samples = [
      "user",
      "human",
      "impersonator",
      "portal_session",
      "api",
      "api_key",
      "agent",
      "system",
      "service",
      "automation",
      "slack",
      "partner_app",
      // Types this build predates — the regression the "Other" chip exists for.
      "webhook_relay",
      "scim_provisioner",
      "",
      "  MIXED_Case  ",
    ];
    for (const sample of samples) {
      const matches = namedKeys.filter((key) =>
        matchesAuditActor(key, sample),
      );
      expect(matches, `${JSON.stringify(sample)} matched ${matches}`).toHaveLength(1);
    }
  });

  it("matches everything under All", () => {
    expect(matchesAuditActor("all", "anything")).toBe(true);
    expect(matchesAuditActor("all", null)).toBe(true);
  });

  it("normalises case and whitespace before matching", () => {
    expect(matchesAuditActor("agent", " Agent ")).toBe(true);
    expect(matchesAuditActor("other", " Agent ")).toBe(false);
  });
});

describe("serverActorTypeFor", () => {
  it("only pushes single-value chips to the server", () => {
    // The server filter is exact equality, so a multi-value chip would drop rows.
    expect(serverActorTypeFor("agent")).toBe("agent");
    expect(serverActorTypeFor("user")).toBeUndefined();
    expect(serverActorTypeFor("api")).toBeUndefined();
    expect(serverActorTypeFor("system")).toBeUndefined();
    expect(serverActorTypeFor("all")).toBeUndefined();
    expect(serverActorTypeFor("other")).toBeUndefined();
  });
});
