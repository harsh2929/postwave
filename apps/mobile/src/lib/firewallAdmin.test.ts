import { describe, expect, it } from "vitest";

import {
  firewallActionTone,
  firewallDraftFrom,
  firewallEventDetail,
  firewallPatch,
  firewallPatchLines,
  normalizeDetectResult,
  normalizeFirewallEvents,
  normalizeFirewallStats,
  parseIntField,
  surgeResultCopy,
  validateFirewallDraft,
  windowCountsLine,
  type FirewallDraft,
} from "./firewallAdmin";

const SERVER: FirewallDraft = {
  attackModeEnabled: false,
  autoAttackMode: true,
  fingerprintRequired: false,
  attackModeThreshold: 50,
  surgeMultiplier: 5,
  surgeMinPerHour: 50,
};

describe("firewallDraftFrom", () => {
  it("copies only the editable fields off the settings view", () => {
    expect(
      firewallDraftFrom({
        ...SERVER,
        autoEnabledAt: "2026-09-01T00:00:00Z",
      }),
    ).toEqual(SERVER);
  });
});

describe("firewallPatch", () => {
  it("sends only the changed field", () => {
    expect(firewallPatch(SERVER, { ...SERVER, attackModeEnabled: true })).toEqual(
      { attack_mode_enabled: true },
    );
  });

  it("is null when the draft equals the server", () => {
    expect(firewallPatch(SERVER, { ...SERVER })).toBeNull();
  });

  it("carries every changed number in the server's snake_case", () => {
    expect(
      firewallPatch(SERVER, {
        ...SERVER,
        attackModeThreshold: 70,
        surgeMultiplier: 8,
        surgeMinPerHour: 120,
      }),
    ).toEqual({
      attack_mode_threshold: 70,
      surge_multiplier: 8,
      surge_min_per_hour: 120,
    });
  });
});

describe("validateFirewallDraft", () => {
  it("accepts the server's own defaults", () => {
    expect(validateFirewallDraft(SERVER)).toBeNull();
  });

  it("mirrors the threshold bound 0..100", () => {
    expect(
      validateFirewallDraft({ ...SERVER, attackModeThreshold: 101 }),
    ).toBe("Block score must be a whole number between 0 and 100.");
    expect(validateFirewallDraft({ ...SERVER, attackModeThreshold: 0 })).toBeNull();
  });

  it("mirrors the multiplier bound 2..100", () => {
    expect(validateFirewallDraft({ ...SERVER, surgeMultiplier: 1 })).toBe(
      "Surge multiplier must be a whole number between 2 and 100.",
    );
  });

  it("mirrors the minimum-per-hour bound 1..100000", () => {
    expect(validateFirewallDraft({ ...SERVER, surgeMinPerHour: 0 })).toBe(
      "Surge minimum per hour must be a whole number between 1 and 100,000.",
    );
    expect(
      validateFirewallDraft({ ...SERVER, surgeMinPerHour: 100_001 }),
    ).toBe("Surge minimum per hour must be a whole number between 1 and 100,000.");
  });

  it("rejects a fractional value the server would also reject", () => {
    expect(
      validateFirewallDraft({ ...SERVER, attackModeThreshold: 50.5 }),
    ).toBe("Block score must be a whole number between 0 and 100.");
  });
});

describe("parseIntField", () => {
  it("reads a whole number, with surrounding whitespace", () => {
    expect(parseIntField(" 70 ")).toBe(70);
    expect(parseIntField("0")).toBe(0);
  });

  it("answers null for anything that is not a whole number", () => {
    expect(parseIntField("")).toBeNull();
    expect(parseIntField("1.5")).toBeNull();
    expect(parseIntField("abc")).toBeNull();
    expect(parseIntField("1e3")).toBeNull();
  });
});

describe("firewallPatchLines", () => {
  it("restates each field in the patch and nothing else", () => {
    expect(
      firewallPatchLines({
        attack_mode_enabled: true,
        attack_mode_threshold: 70,
      }),
    ).toEqual(["Attack mode: on", "Block score: 70"]);
  });

  it("names the off state explicitly", () => {
    expect(
      firewallPatchLines({ auto_attack_mode: false, fingerprint_required: false }),
    ).toEqual([
      "Automatic escalation: off",
      "Browser fingerprint: not required",
    ]);
  });
});

describe("normalizeFirewallEvents", () => {
  it("reads Event rows off ListEvents", () => {
    expect(
      normalizeFirewallEvents({
        events: [
          {
            id: "e1",
            form_id: "f1",
            risk_score: 72,
            action: "rejected",
            ip: "203.0.113.4",
            at: "2026-09-01T10:00:00Z",
          },
          { id: "", action: "accepted" },
        ],
        count: 2,
      }),
    ).toEqual([
      {
        id: "e1",
        action: "rejected",
        riskScore: 72,
        ip: "203.0.113.4",
        formId: "f1",
        at: "2026-09-01T10:00:00Z",
      },
    ]);
  });

  it("answers an empty list for a hostile payload", () => {
    expect(normalizeFirewallEvents(null)).toEqual([]);
    expect(normalizeFirewallEvents("<!DOCTYPE html>")).toEqual([]);
    expect(normalizeFirewallEvents({ events: "nope" })).toEqual([]);
  });
});

describe("normalizeFirewallStats", () => {
  it("reads both windows", () => {
    expect(
      normalizeFirewallStats({
        last_24h: { accepted: 10, rejected: 3, observed: 1 },
        last_7d: { accepted: 90, rejected: 20, observed: 4 },
      }),
    ).toEqual({
      last24h: { accepted: 10, rejected: 3, observed: 1 },
      last7d: { accepted: 90, rejected: 20, observed: 4 },
    });
  });

  it("reads a missing window as zeros rather than crashing", () => {
    expect(normalizeFirewallStats({ last_24h: { rejected: 2 } })).toEqual({
      last24h: { accepted: 0, rejected: 2, observed: 0 },
      last7d: { accepted: 0, rejected: 0, observed: 0 },
    });
    expect(normalizeFirewallStats([]).last7d.rejected).toBe(0);
  });
});

describe("normalizeDetectResult / surgeResultCopy", () => {
  it("reports `flipped` verbatim in desktop's two sentences", () => {
    expect(normalizeDetectResult({ flipped: true })).toBe(true);
    expect(normalizeDetectResult({ flipped: "true" })).toBe(false);
    expect(normalizeDetectResult(null)).toBe(false);
    expect(surgeResultCopy(true)).toBe(
      "Surge detected — attack mode was enabled by this check.",
    );
    expect(surgeResultCopy(false)).toBe("No surge detected — settings unchanged.");
  });
});

describe("event and window copy", () => {
  it("colours actions as desktop does and falls back to neutral", () => {
    expect(firewallActionTone("rejected")).toBe("danger");
    expect(firewallActionTone("observed")).toBe("warning");
    expect(firewallActionTone("accepted")).toBe("success");
    expect(firewallActionTone("weird")).toBe("neutral");
  });

  it("writes the detail line from whatever identifiers exist", () => {
    expect(
      firewallEventDetail({
        id: "e1",
        action: "rejected",
        riskScore: 72,
        ip: "203.0.113.4",
        formId: "f1",
        at: "",
      }),
    ).toBe("risk 72 · 203.0.113.4 · form f1");
    expect(
      firewallEventDetail({
        id: "e2",
        action: "accepted",
        riskScore: 5,
        ip: "",
        formId: "",
        at: "",
      }),
    ).toBe("risk 5");
  });

  it("puts rejected first — it is the number an operator opened this for", () => {
    expect(windowCountsLine({ accepted: 10, rejected: 3, observed: 1 })).toBe(
      "3 rejected · 10 accepted · 1 observed",
    );
  });
});
