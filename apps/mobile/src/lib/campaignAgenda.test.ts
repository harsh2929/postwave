import { describe, expect, it } from "vitest";

import {
  buildCampaignAgenda,
  campaignAgendaEntries,
  localDayOffset,
  localDayStart,
} from "./campaignAgenda";

/**
 * Timestamps are built through the LOCAL Date constructor so the suite is
 * timezone-agnostic: the module groups by the device's calendar, so the test
 * must express its expectations in the same calendar.
 */
function at(
  y: number,
  m: number,
  d: number,
  h = 12,
  min = 0,
): { ms: number; iso: string } {
  const date = new Date(y, m - 1, d, h, min, 0, 0);
  return { ms: date.getTime(), iso: date.toISOString() };
}

const NOW = at(2026, 7, 26, 9, 0).ms;

function scheduled(id: string, iso: string | null) {
  return { id, status: "scheduled", scheduled_at: iso };
}

describe("localDayStart / localDayOffset", () => {
  it("collapses a whole local day to one key", () => {
    expect(localDayStart(at(2026, 7, 26, 0, 1).ms)).toBe(
      localDayStart(at(2026, 7, 26, 23, 59).ms),
    );
    expect(localDayStart(at(2026, 7, 26, 12).ms)).not.toBe(
      localDayStart(at(2026, 7, 27, 12).ms),
    );
  });

  it("counts calendar days, so a DST day is still one day", () => {
    // Computed on day starts rather than by dividing by 86_400_000, which is
    // off by one on the 23- and 25-hour days.
    expect(localDayOffset(at(2026, 3, 7, 12).ms, at(2026, 3, 8, 12).ms)).toBe(1);
    expect(localDayOffset(at(2026, 11, 1, 12).ms, at(2026, 11, 2, 12).ms)).toBe(
      1,
    );
    expect(localDayOffset(at(2026, 7, 26, 12).ms, at(2026, 7, 26, 23).ms)).toBe(
      0,
    );
  });
});

describe("buildCampaignAgenda", () => {
  it("ignores every campaign that is not scheduled", () => {
    const sections = buildCampaignAgenda(
      [
        { id: "a", status: "sent", scheduled_at: at(2026, 7, 27).iso },
        { id: "b", status: "draft", scheduled_at: at(2026, 7, 27).iso },
        { id: "c", status: "cancelled", scheduled_at: at(2026, 7, 27).iso },
      ],
      NOW,
    );
    expect(sections).toEqual([]);
  });

  it("orders days ASCENDING — the next send leads, not the furthest out", () => {
    const sections = buildCampaignAgenda(
      [
        scheduled("far", at(2026, 8, 15).iso),
        scheduled("soon", at(2026, 7, 27).iso),
        scheduled("mid", at(2026, 7, 30).iso),
      ],
      NOW,
    );
    expect(sections.map((s) => s.rows[0]?.id)).toEqual(["soon", "mid", "far"]);
  });

  it("puts overdue FIRST, ahead of every future day", () => {
    const sections = buildCampaignAgenda(
      [
        scheduled("tomorrow", at(2026, 7, 27).iso),
        scheduled("stuck", at(2026, 7, 20).iso),
      ],
      NOW,
    );
    expect(sections[0]?.specialTitle).toBe("Overdue");
    expect(sections[0]?.rows.map((r) => r.id)).toEqual(["stuck"]);
    expect(sections[1]?.specialTitle).toBeNull();
  });

  it("orders overdue oldest-first — longest-silent failure leads", () => {
    const sections = buildCampaignAgenda(
      [
        scheduled("recent", at(2026, 7, 25).iso),
        scheduled("ancient", at(2026, 6, 1).iso),
      ],
      NOW,
    );
    expect(sections[0]?.rows.map((r) => r.id)).toEqual(["ancient", "recent"]);
  });

  it("marks today and tomorrow, and nothing else", () => {
    const sections = buildCampaignAgenda(
      [
        scheduled("t", at(2026, 7, 26, 18).iso),
        scheduled("tm", at(2026, 7, 27, 9).iso),
        scheduled("later", at(2026, 7, 29, 9).iso),
      ],
      NOW,
    );
    expect(sections.map((s) => s.relativeDay)).toEqual([
      "today",
      "tomorrow",
      null,
    ]);
  });

  it("keeps a scheduled campaign with no time instead of dropping it", () => {
    // Dropping it would make the agenda's count disagree with the chip's.
    const sections = buildCampaignAgenda(
      [scheduled("nodate", null), scheduled("ok", at(2026, 7, 27).iso)],
      NOW,
    );
    expect(sections.at(-1)?.specialTitle).toBe("No send time set");
    expect(sections.at(-1)?.rows.map((r) => r.id)).toEqual(["nodate"]);
  });

  it("treats an unparseable scheduled_at as no time, not as 1970", () => {
    const sections = buildCampaignAgenda(
      [{ id: "junk", status: "scheduled", scheduled_at: "soon-ish" }],
      NOW,
    );
    expect(sections[0]?.specialTitle).toBe("No send time set");
  });

  it("sorts within a day by clock time, then by id for a total order", () => {
    const sections = buildCampaignAgenda(
      [
        scheduled("evening", at(2026, 7, 27, 18).iso),
        scheduled("morning", at(2026, 7, 27, 8).iso),
        scheduled("b-same", at(2026, 7, 27, 8).iso),
      ],
      NOW,
    );
    expect(sections[0]?.rows.map((r) => r.id)).toEqual([
      "b-same",
      "morning",
      "evening",
    ]);
  });
});

describe("campaignAgendaEntries", () => {
  it("emits a header before each section's rows, with the section's count", () => {
    const entries = campaignAgendaEntries(
      [
        scheduled("a", at(2026, 7, 27, 8).iso),
        scheduled("b", at(2026, 7, 27, 9).iso),
        scheduled("c", at(2026, 7, 28, 9).iso),
      ],
      NOW,
    );
    expect(entries.map((e) => e.kind)).toEqual([
      "header",
      "row",
      "row",
      "header",
      "row",
    ]);
    const first = entries[0];
    expect(first?.kind === "header" && first.count).toBe(2);
  });

  it("gives every entry a unique key", () => {
    const entries = campaignAgendaEntries(
      [
        scheduled("a", at(2026, 7, 27, 8).iso),
        scheduled("b", at(2026, 7, 28, 8).iso),
        scheduled("c", null),
      ],
      NOW,
    );
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is empty when nothing is scheduled", () => {
    expect(campaignAgendaEntries([{ id: "x", status: "sent" }], NOW)).toEqual(
      [],
    );
  });
});
