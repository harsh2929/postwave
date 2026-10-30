/**
 * gpcSignals — the GPC derivation, pinned against desktop's semantics.
 */
import { describe, expect, it } from "vitest";

import {
  gpcHeadline,
  gpcUncorrelatedNotice,
  isGpcEvent,
  parseConsentEvents,
  summarizeGpcSignals,
  type ConsentEventLike,
} from "./gpcSignals";

const NOW = Date.parse("2026-08-28T12:00:00Z");

function event(over: Partial<ConsentEventLike>): ConsentEventLike {
  return {
    subject_type: "visitor",
    source: "gpc",
    created_at: "2026-08-27T12:00:00Z",
    ...over,
  };
}

describe("parseConsentEvents", () => {
  it("reads the {events} page ListEvents writes and drops junk rows", () => {
    const rows = parseConsentEvents({
      events: [
        {
          subject_type: "subscriber",
          subject_email: "a@example.test",
          source: "gpc",
          created_at: "2026-08-27T12:00:00Z",
        },
        "not-a-row",
        null,
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject_email).toBe("a@example.test");
  });

  it("degrades malformed bodies to an empty list", () => {
    expect(parseConsentEvents(null)).toEqual([]);
    expect(parseConsentEvents({ events: "nope" })).toEqual([]);
    expect(parseConsentEvents([])).toEqual([]);
  });
});

describe("isGpcEvent", () => {
  it("matches preferences.gpc === true or source 'gpc', case/space-insensitively", () => {
    expect(isGpcEvent(event({ source: "cookie_banner", preferences: { gpc: true } }))).toBe(true);
    expect(isGpcEvent(event({ source: " GPC " }))).toBe(true);
    expect(isGpcEvent(event({ source: "cookie_banner" }))).toBe(false);
    expect(
      isGpcEvent(event({ source: "cookie_banner", preferences: { gpc: "yes" } })),
    ).toBe(false);
  });
});

describe("summarizeGpcSignals", () => {
  it("counts window-bounded signals, dedups subjects, flags uncorrelated rows", () => {
    const summary = summarizeGpcSignals(
      [
        // Two signals from the SAME subscriber id → one known subject.
        event({ subject_type: "subscriber", subject_id: "s-1" }),
        event({ subject_type: "subscriber", subject_id: "s-1" }),
        // A second subject, correlated by email only.
        event({ subject_email: "B@Example.test" }),
        // Neither id nor email → uncorrelated.
        event({}),
        // Non-GPC noise is invisible to the summary.
        event({ source: "cookie_banner" }),
      ],
      NOW,
    );
    expect(summary).toEqual({
      signalRows: 4,
      knownSubjects: 2,
      uncorrelatedRows: 1,
    });
  });

  it("excludes rows outside the 30-day window, future-dated and unparsable ones", () => {
    const summary = summarizeGpcSignals(
      [
        event({ created_at: "2026-07-01T00:00:00Z", subject_id: "old" }),
        event({ created_at: "2026-09-01T00:00:00Z", subject_id: "future" }),
        event({ created_at: "not a time", subject_id: "junk" }),
        event({ created_at: "2026-08-20T00:00:00Z", subject_id: "recent" }),
      ],
      NOW,
    );
    expect(summary.signalRows).toBe(1);
    expect(summary.knownSubjects).toBe(1);
  });
});

describe("copy", () => {
  it("headline carries signals, subjects and the window", () => {
    expect(
      gpcHeadline({ signalRows: 4, knownSubjects: 2, uncorrelatedRows: 1 }),
    ).toBe(
      "4 GPC opt-out signals recorded in the last 30 days, from 2 known subjects.",
    );
    expect(
      gpcHeadline({ signalRows: 1, knownSubjects: 1, uncorrelatedRows: 0 }),
    ).toMatch(/^1 GPC opt-out signal recorded/);
  });

  it("uncorrelated notice appears only when there is something to warn about", () => {
    expect(
      gpcUncorrelatedNotice({ signalRows: 2, knownSubjects: 2, uncorrelatedRows: 0 }),
    ).toBeNull();
    expect(
      gpcUncorrelatedNotice({ signalRows: 2, knownSubjects: 1, uncorrelatedRows: 1 }),
    ).toMatch(/no stable subject ID or email/);
  });
});
