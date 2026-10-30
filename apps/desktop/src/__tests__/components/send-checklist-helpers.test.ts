/**
 * send-checklist-helpers — coverage for the three client-side
 * checklist rows (a11y / links / send window) and the weekday-bitmap
 * helpers behind the policy editor.
 *
 * High-stakes invariant: weekday numbering is Go time.Weekday
 * (0=Sunday .. 6=Saturday) with bit `1<<day`; the server default 126
 * means Mon–Sat. Any drift here silently shifts every send window.
 */

import { describe, expect, it } from "vitest";

import type { A11yReport, LinkCheckResult } from "../../lib/api-client";
import {
  DEFAULT_WEEKDAY_BITMAP,
  a11yRowDetail,
  a11yRowStatus,
  bitmapHasDay,
  linkStatusLabel,
  linksRowDetail,
  linksRowStatus,
  sendWindowRowDetail,
  sendWindowRowStatus,
  toggleWeekday,
  validateSendWindowForm,
  weekdaysLabel,
} from "../../components/send-checklist-helpers";

const report = (
  error: number,
  warn: number,
  info = 0,
  score = 80,
): A11yReport => ({
  findings: [],
  counts: { info, warn, error },
  score,
});

describe("a11y row", () => {
  it("maps counts to fail > warn > pass", () => {
    expect(a11yRowStatus(report(1, 0))).toBe("fail");
    expect(a11yRowStatus(report(0, 2))).toBe("warn");
    expect(a11yRowStatus(report(0, 0, 3))).toBe("pass");
  });

  it("detail lists score and pluralized counts", () => {
    expect(a11yRowDetail(report(2, 1, 0, 73.4))).toBe(
      "Score 73/100 · 2 errors · 1 warning",
    );
    expect(a11yRowDetail(report(0, 0, 1, 100))).toBe(
      "Score 100/100 · 1 info note",
    );
    expect(a11yRowDetail(report(0, 0, 0, 100))).toBe(
      "Score 100/100 · no findings",
    );
  });
});

describe("links row", () => {
  const ok: LinkCheckResult = { url: "https://a.example", status: 200, ok: true };
  const broken: LinkCheckResult = {
    url: "https://b.example",
    status: 404,
    ok: false,
  };

  it("fails when any link is broken; passes when none (or no links)", () => {
    expect(linksRowStatus([])).toBe("pass");
    expect(linksRowStatus([ok, ok])).toBe("pass");
    expect(linksRowStatus([ok, broken])).toBe("fail");
  });

  it("detail copy covers all three shapes", () => {
    expect(linksRowDetail([])).toBe("No links found in the body.");
    expect(linksRowDetail([ok])).toBe("1 link checked — all reachable.");
    expect(linksRowDetail([ok, broken, broken])).toBe("2 of 3 links broken.");
  });

  it("status label prefers the HTTP code, then the error", () => {
    expect(linkStatusLabel(ok)).toBe("200");
    expect(
      linkStatusLabel({ url: "x", status: 0, ok: false, error: "timeout" }),
    ).toBe("error");
    expect(linkStatusLabel({ url: "x", status: 0, ok: false })).toBe("—");
  });
});

describe("send window row", () => {
  it("maps the server verdict's should field 1:1", () => {
    expect(
      sendWindowRowStatus({
        inside_window: true,
        enforcement: "warn",
        should: "allow",
      }),
    ).toBe("pass");
    expect(
      sendWindowRowStatus({
        inside_window: false,
        enforcement: "warn",
        should: "warn",
      }),
    ).toBe("warn");
    expect(
      sendWindowRowStatus({
        inside_window: false,
        enforcement: "block",
        should: "block",
      }),
    ).toBe("fail");
  });

  it("detail distinguishes no-policy, inside, warn, and block", () => {
    expect(
      sendWindowRowDetail({
        inside_window: true,
        enforcement: "off",
        should: "allow",
      }),
    ).toBe("No send-window policy is enforced.");
    expect(
      sendWindowRowDetail({
        inside_window: true,
        enforcement: "block",
        should: "allow",
      }),
    ).toBe("Inside the configured send window.");
    expect(
      sendWindowRowDetail({
        inside_window: false,
        enforcement: "block",
        should: "block",
        reason: "weekday Sunday not in policy bitmap",
      }),
    ).toBe(
      "Outside the send window — sends are blocked (weekday Sunday not in policy bitmap).",
    );
    expect(
      sendWindowRowDetail({
        inside_window: false,
        enforcement: "warn",
        should: "warn",
      }),
    ).toBe("Outside the send window — policy warns.");
  });
});

describe("weekday bitmap (Go time.Weekday, 0=Sun)", () => {
  it("default 126 is Monday through Saturday", () => {
    expect(bitmapHasDay(DEFAULT_WEEKDAY_BITMAP, 0)).toBe(false); // Sun
    for (let d = 1; d <= 6; d++) {
      expect(bitmapHasDay(DEFAULT_WEEKDAY_BITMAP, d)).toBe(true);
    }
    expect(weekdaysLabel(DEFAULT_WEEKDAY_BITMAP)).toBe(
      "Mon, Tue, Wed, Thu, Fri, Sat",
    );
  });

  it("toggle flips a single bit and round-trips", () => {
    const withSunday = toggleWeekday(DEFAULT_WEEKDAY_BITMAP, 0);
    expect(withSunday).toBe(127);
    expect(toggleWeekday(withSunday, 0)).toBe(DEFAULT_WEEKDAY_BITMAP);
    // Out-of-range days are no-ops.
    expect(toggleWeekday(126, 7)).toBe(126);
    expect(bitmapHasDay(126, -1)).toBe(false);
  });

  it("empty bitmap labels honestly", () => {
    expect(weekdaysLabel(0)).toBe("No days");
  });
});

describe("validateSendWindowForm", () => {
  it("accepts a sane window", () => {
    expect(
      validateSendWindowForm({ startLocal: "09:00", endLocal: "17:00", bitmap: 126 }),
    ).toBeNull();
  });

  it("rejects bad times, inverted windows, and empty weekdays", () => {
    expect(
      validateSendWindowForm({ startLocal: "9:00", endLocal: "17:00", bitmap: 126 }),
    ).toMatch(/Start time/);
    expect(
      validateSendWindowForm({ startLocal: "09:00", endLocal: "24:00", bitmap: 126 }),
    ).toMatch(/End time must be HH:MM/);
    expect(
      validateSendWindowForm({ startLocal: "17:00", endLocal: "09:00", bitmap: 126 }),
    ).toMatch(/after start/);
    expect(
      validateSendWindowForm({ startLocal: "09:00", endLocal: "17:00", bitmap: 0 }),
    ).toMatch(/weekday/);
    expect(
      validateSendWindowForm({ startLocal: "09:00", endLocal: "17:00", bitmap: 200 }),
    ).toMatch(/weekday/);
  });
});
