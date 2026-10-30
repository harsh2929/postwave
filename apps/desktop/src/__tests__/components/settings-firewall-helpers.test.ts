// Firewall section helpers (full-surface wiring #48): the PUT body
// only carries changed fields (server uses pointer semantics), the
// client validation mirrors the server bounds exactly, and the surge
// check reports {flipped} verbatim.

import { describe, expect, it } from "vitest";

import {
  type FirewallDraft,
  firewallActionTone,
  firewallPatch,
  firewallStatCounts,
  firewallWindowCounts,
  surgeResultCopy,
  validateFirewallDraft,
} from "../../components/settings/firewall-helpers";

const base: FirewallDraft = {
  attack_mode_enabled: false,
  auto_attack_mode: true,
  fingerprint_required: false,
  attack_mode_threshold: 70,
  surge_multiplier: 5,
  surge_min_per_hour: 100,
};

describe("firewallPatch", () => {
  it("returns null when nothing changed", () => {
    expect(firewallPatch(base, { ...base })).toBeNull();
  });

  it("sends only the changed fields", () => {
    expect(
      firewallPatch(base, {
        ...base,
        attack_mode_enabled: true,
        surge_multiplier: 10,
      }),
    ).toEqual({ attack_mode_enabled: true, surge_multiplier: 10 });
  });

  it("includes boolean flips to false (pointer semantics, not omit-falsy)", () => {
    expect(
      firewallPatch(
        { ...base, auto_attack_mode: true },
        {
          ...base,
          auto_attack_mode: false,
        },
      ),
    ).toEqual({ auto_attack_mode: false });
  });
});

describe("validateFirewallDraft", () => {
  it("accepts the server-side bounds inclusively", () => {
    expect(
      validateFirewallDraft({ ...base, attack_mode_threshold: 0 }),
    ).toBeNull();
    expect(
      validateFirewallDraft({ ...base, attack_mode_threshold: 100 }),
    ).toBeNull();
    expect(validateFirewallDraft({ ...base, surge_multiplier: 2 })).toBeNull();
    expect(
      validateFirewallDraft({ ...base, surge_multiplier: 100 }),
    ).toBeNull();
    expect(
      validateFirewallDraft({ ...base, surge_min_per_hour: 1 }),
    ).toBeNull();
    expect(
      validateFirewallDraft({ ...base, surge_min_per_hour: 100000 }),
    ).toBeNull();
  });

  it("rejects out-of-bounds values with field-specific messages", () => {
    expect(
      validateFirewallDraft({ ...base, attack_mode_threshold: 101 }),
    ).toContain("threshold");
    expect(validateFirewallDraft({ ...base, surge_multiplier: 1 })).toContain(
      "multiplier",
    );
    expect(validateFirewallDraft({ ...base, surge_min_per_hour: 0 })).toContain(
      "minimum per hour",
    );
  });

  it("rejects fractional and non-finite values before the integer API", () => {
    expect(
      validateFirewallDraft({ ...base, attack_mode_threshold: Number.NaN }),
    ).toContain("whole number");
    expect(validateFirewallDraft({ ...base, surge_multiplier: 2.5 })).toContain(
      "whole number",
    );
    expect(
      validateFirewallDraft({
        ...base,
        surge_min_per_hour: Number.POSITIVE_INFINITY,
      }),
    ).toContain("whole number");
  });
});

describe("firewallActionTone", () => {
  it("maps the three wire actions and stays neutral on unknowns", () => {
    expect(firewallActionTone("rejected")).toBe("danger");
    expect(firewallActionTone("observed")).toBe("warning");
    expect(firewallActionTone("accepted")).toBe("success");
    expect(firewallActionTone("whatever")).toBe("");
  });
});

describe("firewallWindowCounts", () => {
  it("passes through a fully-populated window", () => {
    expect(
      firewallWindowCounts({ accepted: 3, rejected: 2, observed: 9 }),
    ).toEqual({ accepted: 3, rejected: 2, observed: 9 });
  });

  it("defaults every counter to 0 on an empty or nil window", () => {
    // The /stats response can omit a window entirely for a tenant with
    // no firewall rows — reading `.rejected` off it must not crash.
    expect(firewallWindowCounts(undefined)).toEqual({
      accepted: 0,
      rejected: 0,
      observed: 0,
    });
    expect(firewallWindowCounts(null)).toEqual({
      accepted: 0,
      rejected: 0,
      observed: 0,
    });
    expect(firewallWindowCounts({})).toEqual({
      accepted: 0,
      rejected: 0,
      observed: 0,
    });
  });

  it("fills only the missing counters in a partial window", () => {
    expect(firewallWindowCounts({ rejected: 5 })).toEqual({
      accepted: 0,
      rejected: 5,
      observed: 0,
    });
  });
});

describe("firewallStatCounts", () => {
  it("normalises both windows from a full stats payload", () => {
    expect(
      firewallStatCounts({
        last_24h: { accepted: 1, rejected: 2, observed: 3 },
        last_7d: { accepted: 4, rejected: 5, observed: 6 },
      }),
    ).toEqual({
      last24h: { accepted: 1, rejected: 2, observed: 3 },
      last7d: { accepted: 4, rejected: 5, observed: 6 },
    });
  });

  it("returns zeroed windows for an empty/undefined stats response", () => {
    const zero = { accepted: 0, rejected: 0, observed: 0 };
    expect(firewallStatCounts(undefined)).toEqual({
      last24h: zero,
      last7d: zero,
    });
    expect(firewallStatCounts({})).toEqual({ last24h: zero, last7d: zero });
  });
});

describe("surgeResultCopy", () => {
  it("reports flipped=true as attack mode having been enabled", () => {
    expect(surgeResultCopy(true)).toContain("attack mode was enabled");
  });

  it("reports flipped=false as no change — never claims a sweep didn't run", () => {
    const copy = surgeResultCopy(false);
    expect(copy).toContain("No surge detected");
    expect(copy).toContain("unchanged");
  });
});
