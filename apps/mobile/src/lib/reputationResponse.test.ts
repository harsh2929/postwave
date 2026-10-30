import { describe, expect, it } from "vitest";

import {
  attackModeConsequence,
  attackModeOrigin,
  attackModeSummary,
  blocklistSeverity,
  blocklistSummary,
  blocklistSuppressConsequence,
  cooldownActive,
  isSuppressibleSubject,
  spamTrapRunSummary,
  type BlocklistSubjectLike,
  type FirewallSettingsLike,
} from "./reputationResponse";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function settings(
  over: Partial<FirewallSettingsLike> = {},
): FirewallSettingsLike {
  return { attackModeEnabled: false, autoAttackMode: true, ...over };
}

describe("attackModeOrigin separates the detector from a person", () => {
  it("is off when disabled", () => {
    expect(attackModeOrigin(settings())).toBe("off");
  });

  it("is auto when the detector stamped it", () => {
    const s = settings({
      attackModeEnabled: true,
      attackModeAutoEnabledAt: "2026-08-18T11:00:00Z",
    });
    expect(attackModeOrigin(s)).toBe("auto");
  });

  it("is manual when no detector stamp exists", () => {
    expect(attackModeOrigin(settings({ attackModeEnabled: true }))).toBe(
      "manual",
    );
  });
});

describe("cooldownActive", () => {
  it("is true while the override still holds", () => {
    const s = settings({ attackModeAutoCooldownUntil: "2026-08-19T00:00:00Z" });
    expect(cooldownActive(s, NOW)).toBe(true);
  });

  it("is false once it has passed", () => {
    const s = settings({ attackModeAutoCooldownUntil: "2026-08-18T11:00:00Z" });
    expect(cooldownActive(s, NOW)).toBe(false);
  });

  it("is false when absent, and does not crash on garbage", () => {
    expect(cooldownActive(settings(), NOW)).toBe(false);
    expect(
      cooldownActive(settings({ attackModeAutoCooldownUntil: "nope" }), NOW),
    ).toBe(false);
  });
});

describe("attackModeSummary", () => {
  it("says who turned it on when it is on", () => {
    expect(
      attackModeSummary(
        settings({
          attackModeEnabled: true,
          attackModeAutoEnabledAt: "2026-08-18T11:00:00Z",
        }),
        NOW,
      ),
    ).toContain("automatic detector turned it on");
    expect(
      attackModeSummary(settings({ attackModeEnabled: true }), NOW),
    ).toContain("turned on manually");
  });

  it("does not render a held-off detector as a plain off", () => {
    // The most confusing state: an operator already turned it off and the
    // detector is deliberately being held back.
    const s = settings({ attackModeAutoCooldownUntil: "2026-08-19T00:00:00Z" });
    expect(attackModeSummary(s, NOW)).toContain("holding the automatic detector off");
  });

  it("distinguishes an armed detector from a disabled one", () => {
    expect(attackModeSummary(settings({ autoAttackMode: true }), NOW)).toContain(
      "armed",
    );
    expect(
      attackModeSummary(settings({ autoAttackMode: false }), NOW),
    ).toContain("automatic detection is disabled");
  });
});

describe("attackModeConsequence", () => {
  it("explains the 24-hour cooldown when turning OFF", () => {
    // Without this the operator cannot tell whether their override took.
    expect(attackModeConsequence(false)).toContain("24 hours");
  });

  it("describes turning ON in terms of what subscribers experience", () => {
    expect(attackModeConsequence(true)).toContain("turned away");
  });
});

describe("blocklist severity and copy", () => {
  function subject(
    over: Partial<BlocklistSubjectLike> = {},
  ): BlocklistSubjectLike {
    return {
      subject_type: "ip",
      subject: "203.0.113.9",
      listed_zones: [],
      tier1_hit: false,
      listed_count: 0,
      total_zones: 12,
      would_auto_suppress: false,
      last_checked: "2026-08-18T11:00:00Z",
      ...over,
    };
  }

  it("separates a tier-1 hit from an ordinary listing", () => {
    expect(blocklistSeverity(subject())).toBe("clean");
    expect(blocklistSeverity(subject({ listed_count: 2 }))).toBe("listed");
    expect(
      blocklistSeverity(subject({ listed_count: 1, tier1_hit: true })),
    ).toBe("critical");
  });

  it("calls out a tier-1 zone in the summary", () => {
    const s = blocklistSummary(
      subject({ listed_count: 1, tier1_hit: true, listed_zones: ["zen.spamhaus.org"] }),
    );
    expect(s).toContain("most receivers act on");
  });

  it("names the zones but overflows by count", () => {
    const s = blocklistSummary(
      subject({
        listed_count: 5,
        listed_zones: ["a", "b", "c", "d", "e"],
      }),
    );
    expect(s).toContain("a, b, c and 2 more");
  });

  it("says clean plainly rather than rendering an empty listing", () => {
    expect(blocklistSummary(subject())).toContain("Clean across");
  });

  it("only offers suppress for the two subject types the handler accepts", () => {
    expect(isSuppressibleSubject(subject({ subject_type: "ip" }))).toBe(true);
    expect(isSuppressibleSubject(subject({ subject_type: "domain" }))).toBe(true);
    expect(isSuppressibleSubject(subject({ subject_type: "url" }))).toBe(false);
  });

  it("says outright when manual suppression is the only brake", () => {
    const s = blocklistSuppressConsequence(
      subject({ listed_count: 1, would_auto_suppress: false }),
    );
    expect(s).toContain("nothing else is going to stop it");
  });

  it("does not overstate when automatic suppression would also fire", () => {
    const s = blocklistSuppressConsequence(
      subject({ listed_count: 1, would_auto_suppress: true }),
    );
    expect(s).toContain("would also have caught this");
    expect(s).not.toContain("nothing else is going to stop it");
  });

  it("always warns that suppression is not undone here", () => {
    expect(blocklistSuppressConsequence(subject())).toContain("not undone");
  });
});

describe("spamTrapRunSummary", () => {
  it("reports a clean sweep as a real answer, not an empty one", () => {
    expect(
      spamTrapRunSummary({ blocklisted: 0, completed_at: "" }),
    ).toContain("no new spam-trap hits");
  });

  it("singularises one address", () => {
    expect(spamTrapRunSummary({ blocklisted: 1, completed_at: "" })).toContain(
      "1 address blocklisted",
    );
  });

  it("pluralises more than one", () => {
    expect(spamTrapRunSummary({ blocklisted: 4, completed_at: "" })).toContain(
      "4 addresses blocklisted",
    );
  });

  it("does not render NaN when the server omits the count", () => {
    const s = spamTrapRunSummary({
      blocklisted: Number.NaN,
      completed_at: "",
    });
    expect(s).not.toContain("NaN");
    expect(s).toContain("no new spam-trap hits");
  });
});
