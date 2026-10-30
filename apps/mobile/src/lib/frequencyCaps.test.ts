import { describe, expect, it } from "vitest";

import {
  capRuleLine,
  capScopeLine,
  capToggleAnnouncement,
  capsSummaryLine,
  humanWindow,
  parseFrequencyCap,
  parseFrequencyCaps,
  type FrequencyCap,
} from "./frequencyCaps";

function cap(over: Partial<FrequencyCap> = {}): FrequencyCap {
  return {
    id: "c1",
    label: "Marketing daily",
    channel: "email",
    messageType: "marketing",
    maxCount: 3,
    windowSeconds: 86_400,
    appliesTo: "all",
    active: true,
    ...over,
  };
}

describe("parseFrequencyCaps", () => {
  it("reads the server's {caps, count} envelope", () => {
    const rows = parseFrequencyCaps({
      count: 1,
      caps: [
        {
          id: "c1",
          label: "Marketing daily",
          channel: "email",
          message_type: "marketing",
          max_count: 3,
          window_seconds: 86_400,
          applies_to: "all",
          active: true,
        },
      ],
    });
    expect(rows).toEqual([cap()]);
  });

  it("tolerates a bare array and an {items} envelope", () => {
    expect(parseFrequencyCaps([{ id: "a" }])).toHaveLength(1);
    expect(parseFrequencyCaps({ items: [{ id: "a" }] })).toHaveLength(1);
  });

  it("drops rows with no id rather than rendering an untoggleable card", () => {
    // Every action on this screen is PATCH /frequency-caps/{id}. A row with no
    // id is a control that cannot act.
    expect(parseFrequencyCaps({ caps: [{ label: "orphan" }] })).toEqual([]);
  });

  it("never assumes a cap is active", () => {
    expect(parseFrequencyCaps({ caps: [{ id: "a" }] })[0]?.active).toBe(false);
    expect(
      parseFrequencyCaps({ caps: [{ id: "a", active: "yes" }] })[0]?.active,
    ).toBe(false);
  });

  it("reports a missing count as null, not zero", () => {
    // 0 would read as "this cap blocks everything", the opposite of unknown.
    const row = parseFrequencyCaps({ caps: [{ id: "a" }] })[0];
    expect(row?.maxCount).toBeNull();
    expect(row?.windowSeconds).toBeNull();
  });

  it("returns an empty list for junk instead of throwing", () => {
    expect(parseFrequencyCaps(null)).toEqual([]);
    expect(parseFrequencyCaps({ caps: "no" })).toEqual([]);
  });
});

describe("parseFrequencyCap", () => {
  it("unwraps the {cap} envelope the PATCH returns", () => {
    expect(parseFrequencyCap({ cap: { id: "c1", active: true } })?.id).toBe("c1");
  });
  it("accepts a bare object too", () => {
    expect(parseFrequencyCap({ id: "c1" })?.id).toBe("c1");
  });
  it("is null when there is nothing usable", () => {
    expect(parseFrequencyCap({ cap: {} })).toBeNull();
  });
});

describe("humanWindow", () => {
  it("prefers the largest exact unit", () => {
    expect(humanWindow(86_400)).toBe("day");
    expect(humanWindow(172_800)).toBe("2 days");
    expect(humanWindow(3_600)).toBe("hour");
    expect(humanWindow(7_200)).toBe("2 hours");
    expect(humanWindow(60)).toBe("minute");
    expect(humanWindow(900)).toBe("15 minutes");
  });
  it("falls back to seconds when nothing divides evenly", () => {
    expect(humanWindow(90)).toBe("90 seconds");
  });
  it("is an em-dash for absent or nonsensical windows", () => {
    expect(humanWindow(null)).toBe("—");
    expect(humanWindow(0)).toBe("—");
    expect(humanWindow(-5)).toBe("—");
  });
});

describe("capRuleLine", () => {
  it("states the rule in one sentence", () => {
    expect(capRuleLine(cap())).toBe("3 per day");
  });
  it("keeps an unknown half unknown", () => {
    expect(capRuleLine(cap({ maxCount: null }))).toBe("— per day");
    expect(capRuleLine(cap({ windowSeconds: null }))).toBe("3 per —");
  });
});

describe("capScopeLine", () => {
  it("spells out a scoped rule", () => {
    expect(capScopeLine(cap())).toBe("Email · marketing · all subscribers");
  });
  it("says All channels rather than 'all'", () => {
    expect(capScopeLine(cap({ channel: "all", messageType: "all" }))).toBe(
      "All channels · all message types · all subscribers",
    );
  });
});

describe("capsSummaryLine", () => {
  it("says nothing is configured when nothing is", () => {
    expect(capsSummaryLine([])).toBe("No frequency caps are configured.");
  });

  it("refuses to count an inactive rule as protection", () => {
    // The bug this exists to prevent: "4 caps" over four switched-off rules.
    expect(
      capsSummaryLine([cap({ active: false }), cap({ id: "c2", active: false })]),
    ).toBe("2 caps configured — none of them are enforcing.");
  });

  it("counts only the enforcing ones", () => {
    expect(capsSummaryLine([cap(), cap({ id: "c2", active: false })])).toBe(
      "1 of 2 caps enforcing right now.",
    );
  });

  it("singularises a lone cap", () => {
    expect(capsSummaryLine([cap({ active: false })])).toBe(
      "1 cap configured — none of them are enforcing.",
    );
  });
});

describe("capToggleAnnouncement", () => {
  it("says what turning it on will now do", () => {
    expect(capToggleAnnouncement(cap(), true)).toBe(
      "Marketing daily is now enforcing: 3 per day.",
    );
  });
  it("says what turning it off stops doing", () => {
    expect(capToggleAnnouncement(cap(), false)).toBe(
      "Marketing daily is now off and will not defer any message.",
    );
  });
});
