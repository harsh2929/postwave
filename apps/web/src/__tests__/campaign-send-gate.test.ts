// SPDX-License-Identifier: AGPL-3.0-only
// Guards the campaign Send gating (audit CAMP-002/011): sending is irreversible,
// so Send must stay disabled until the recipient count AND pre-send checklist
// have resolved, must block on a failing checklist, and — if the count preview
// errored — must require an explicit acknowledgment before enabling.
import { describe, expect, it } from "vitest";

import {
  a11yRowDetail,
  a11yRowStatus,
  linkRowDetail,
  linkRowStatus,
  linkStatusLabel,
  sendGateDisabled,
} from "@/app/(dashboard)/app/campaigns/campaign-send-gate";

const ready = {
  sending: false,
  countPending: false,
  countErrored: false,
  checklistPending: false,
  checklistBlocks: false,
  ackNoCount: false,
};

describe("sendGateDisabled", () => {
  it("enables Send only when count + checklist have resolved cleanly", () => {
    expect(sendGateDisabled(ready)).toBe(false);
  });

  it("disables while the recipient count is still loading", () => {
    expect(sendGateDisabled({ ...ready, countPending: true })).toBe(true);
  });

  it("disables while the pre-send checklist is still loading", () => {
    expect(sendGateDisabled({ ...ready, checklistPending: true })).toBe(true);
  });

  it("disables when the checklist has a failing gate", () => {
    expect(sendGateDisabled({ ...ready, checklistBlocks: true })).toBe(true);
  });

  it("disables when the count errored and the user has NOT acknowledged", () => {
    expect(sendGateDisabled({ ...ready, countErrored: true })).toBe(true);
  });

  it("enables when the count errored but the user acknowledged sending anyway", () => {
    expect(
      sendGateDisabled({ ...ready, countErrored: true, ackNoCount: true }),
    ).toBe(false);
  });

  it("acknowledgment does NOT override a still-loading count or a failing checklist", () => {
    expect(
      sendGateDisabled({ ...ready, countPending: true, ackNoCount: true }),
    ).toBe(true);
    expect(
      sendGateDisabled({
        ...ready,
        countErrored: true,
        ackNoCount: true,
        checklistBlocks: true,
      }),
    ).toBe(true);
  });

  it("disables while a send is already in flight", () => {
    expect(sendGateDisabled({ ...ready, sending: true })).toBe(true);
  });
});

// --- client gate rows (parity campaigns-31 / campaigns-32) ----------------
//
// These grade the accessibility lint and the broken-link sweep into the same
// pass/warn/fail vocabulary the server checklist uses. They are ADVISORY: the
// last case here is the one that matters — neither can reach `sendGateDisabled`.

function report(
  counts: { error?: number; warn?: number; info?: number },
  score: number,
) {
  return {
    counts: {
      error: counts.error ?? 0,
      warn: counts.warn ?? 0,
      info: counts.info ?? 0,
    },
    score,
    findings: [],
  };
}

describe("accessibility gate row", () => {
  it("fails on WCAG errors, warns on warnings, passes otherwise", () => {
    expect(a11yRowStatus(report({ error: 1, warn: 3 }, 55))).toBe("fail");
    expect(a11yRowStatus(report({ warn: 2 }, 90))).toBe("warn");
    expect(a11yRowStatus(report({ info: 4 }, 96))).toBe("pass");
    expect(a11yRowStatus(report({}, 100))).toBe("pass");
  });

  it("names the score and the counts that produced the status", () => {
    expect(a11yRowDetail(report({ error: 1, warn: 2 }, 75))).toBe(
      "Score 75/100 · 1 error · 2 warnings",
    );
    expect(a11yRowDetail(report({ info: 1 }, 99))).toBe(
      "Score 99/100 · 1 info note",
    );
    expect(a11yRowDetail(report({}, 100))).toBe("Score 100/100 · no findings");
  });

  it("treats a missing count as zero rather than crashing the row", () => {
    expect(
      a11yRowStatus({ counts: {} as Record<string, number>, score: 100, findings: [] }),
    ).toBe("pass");
  });
});

describe("link gate row", () => {
  const ok = { url: "https://example.com/a", status: 200, ok: true };
  const broken = {
    url: "https://example.com/b",
    status: 404,
    ok: false,
  };
  const unreachable = {
    url: "https://nope.invalid/c",
    status: 0,
    ok: false,
    error: "The link's domain doesn't exist.",
  };

  it("fails the row when any link is unreachable", () => {
    expect(linkRowStatus([ok, broken])).toBe("fail");
    expect(linkRowStatus([ok, ok])).toBe("pass");
  });

  it("never reports an empty sweep as links having been verified", () => {
    expect(linkRowStatus([])).toBe("pass");
    expect(linkRowDetail([])).toBe(
      "No links found in the saved body — nothing was checked.",
    );
    expect(linkRowDetail([ok, ok])).toBe("2 links checked — all reachable.");
    expect(linkRowDetail([ok, broken])).toBe("1 of 2 links broken.");
    expect(linkRowDetail([broken])).toBe("1 of 1 link broken.");
  });

  it("distinguishes a status code from a request that never got one", () => {
    expect(linkStatusLabel(ok)).toBe("200");
    expect(linkStatusLabel(unreachable)).toBe("No response");
    expect(linkStatusLabel({ url: "x", status: 0, ok: false })).toBe("—");
  });

  it("keeps both rows out of the irreversible Send gate", () => {
    // Every failing client row, and Send is still governed only by the server
    // checklist. If either row is ever wired into SendGateFlags this breaks.
    expect(sendGateDisabled(ready)).toBe(false);
    expect(linkRowStatus([broken])).toBe("fail");
    expect(a11yRowStatus(report({ error: 9 }, 0))).toBe("fail");
    expect(Object.keys(ready).sort()).toEqual([
      "ackNoCount",
      "checklistBlocks",
      "checklistPending",
      "countErrored",
      "countPending",
      "sending",
    ]);
  });
});
