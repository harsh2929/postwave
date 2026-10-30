/**
 * sms-settings-helpers — pure logic behind SmsQuietHoursCard and
 * SmsKeywordResponsesCard.
 *
 * High-stakes invariants:
 *   1. Day numbering is 0=Sunday .. 6=Saturday (Go time.Weekday / JS
 *      Date#getDay), matching apps/api/internal/sms/quiet_hours.go —
 *      NOT ISO 1..7. Sending ISO days would silently shift every
 *      window by one weekday.
 *   2. HH:MM ↔ minute conversion is strict and round-trips — the form
 *      maps `<input type="time">` values onto start_minute/end_minute.
 *   3. The reserved-keyword set matches the server's
 *      reservedSMSKeywords map exactly, so the client pre-check and
 *      the 422 `reserved_keyword` backstop agree.
 */

import { describe, expect, it } from "vitest";

import {
  QUIET_DAY_OPTIONS,
  RESERVED_SMS_KEYWORDS,
  SMS_KEYWORD_ACTIONS,
  canMutateSmsKeywordAction,
  formatQuietDays,
  hhmmToMinute,
  isOvernightWindow,
  isReservedSmsKeyword,
  keywordActionMeta,
  minuteToHHMM,
  normalizeQuietDays,
  normalizeSmsKeyword,
  parseSmsKeywordResponseRows,
  parseSmsPolicyDeleteReceipt,
  parseSmsQuietHoursRows,
  previewSmsResponse,
  quietWindowLabel,
  smsKeywordHasWhitespace,
} from "../../components/sms/sms-settings-helpers";

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const QUIET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEYWORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function rowId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function envelope<T>(items: T[], tenantId = TENANT) {
  return { tenantId, items };
}

const quietRow = {
  id: QUIET_ID,
  tenant_id: TENANT,
  label: "Night",
  country_code: "US",
  start_minute: 1260,
  end_minute: 540,
  start_local: "21:00",
  end_local: "09:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  timezone: "America/New_York",
  enabled: true,
  created_at: "2026-05-10T12:00:00Z",
  updated_at: "2026-05-10T12:00:00Z",
};

const keywordRow = {
  id: KEYWORD_ID,
  tenant_id: TENANT,
  keyword: "PROMO",
  response_body: "Reply",
  response_text: "Reply",
  action: "reply_only",
  enabled: true,
  autoReplyDispatchAvailable: false,
  autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held",
  opt_in_count: 0,
  created_at: "2026-05-10T12:00:00Z",
  updated_at: "2026-05-10T12:00:00Z",
};

describe("SMS settings response contracts", () => {
  it("rejects malformed quiet-hours rows before iterable day rendering", () => {
    expect(parseSmsQuietHoursRows(envelope([{ days: 30 }]), TENANT)).toBeNull();
    expect(parseSmsQuietHoursRows(envelope([quietRow]), TENANT)).toHaveLength(
      1,
    );
  });

  it("rejects keyword rows with missing string/action fields", () => {
    expect(
      parseSmsKeywordResponseRows(envelope([{ keyword: "PROMO" }]), TENANT),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(envelope([keywordRow]), TENANT),
    ).toHaveLength(1);
  });

  it("accepts projection-compatible legacy label whitespace and SMS body text", () => {
    expect(
      parseSmsQuietHoursRows(
        envelope([{ ...quietRow, label: "  Night shift  " }]),
        TENANT,
      ),
    ).toHaveLength(1);
    const body = "  First line\nSecond line \u202e isolated by the renderer  ";
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, response_body: body, response_text: body }]),
        TENANT,
      ),
    ).toHaveLength(1);
  });

  it("binds every private row to the exact canonical tenant", () => {
    expect(
      parseSmsQuietHoursRows(
        envelope([{ ...quietRow, tenant_id: OTHER_TENANT }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, tenant_id: OTHER_TENANT }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([keywordRow]),
        "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      ),
    ).toBeNull();
    expect(
      parseSmsQuietHoursRows(envelope([], OTHER_TENANT), TENANT),
    ).toBeNull();
    expect(parseSmsKeywordResponseRows({ items: [] }, TENANT)).toBeNull();
  });

  it("rejects aliases, extra keys, unsafe text, and impossible timestamps", () => {
    expect(
      parseSmsQuietHoursRows(
        envelope([{ ...quietRow, id: QUIET_ID.toUpperCase() }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsQuietHoursRows(
        envelope([{ ...quietRow, created_at: "2026-02-30T12:00:00Z" }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, keyword: "PRO\u202eMO" }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, unexpected: "proxy detail" }]),
        TENANT,
      ),
    ).toBeNull();
    for (const body of [" \n\t ", "contains\u0000nul", "bad\ud800body"]) {
      expect(
        parseSmsKeywordResponseRows(
          envelope([
            { ...keywordRow, response_body: body, response_text: body },
          ]),
          TENANT,
        ),
      ).toBeNull();
    }
    const oversizedBody = "😀".repeat(4_097);
    expect(
      parseSmsKeywordResponseRows(
        envelope([
          {
            ...keywordRow,
            response_body: oversizedBody,
            response_text: oversizedBody,
          },
        ]),
        TENANT,
      ),
    ).toBeNull();
  });

  it("rejects duplicate identities and contradictory derived fields", () => {
    expect(
      parseSmsQuietHoursRows(envelope([quietRow, quietRow]), TENANT),
    ).toBeNull();
    expect(
      parseSmsQuietHoursRows(
        envelope([{ ...quietRow, start_local: "20:59" }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, response_text: "Different" }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([{ ...keywordRow, opt_in_count: 2_147_483_648 }]),
        TENANT,
      ),
    ).toBeNull();
  });

  it("enforces complete inventory caps and backend sort order", () => {
    const quietInventory = Array.from({ length: 256 }, (_, index) => ({
      ...quietRow,
      id: rowId(index),
    }));
    expect(
      parseSmsQuietHoursRows(envelope(quietInventory), TENANT),
    ).toHaveLength(256);
    expect(
      parseSmsQuietHoursRows(
        envelope([...quietInventory, { ...quietRow, id: rowId(256) }]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsQuietHoursRows(
        envelope([
          { ...quietRow, id: rowId(2) },
          { ...quietRow, id: rowId(1) },
        ]),
        TENANT,
      ),
    ).toBeNull();

    const keywordInventory = Array.from({ length: 512 }, (_, index) => ({
      ...keywordRow,
      id: rowId(index),
      keyword: `K${String(index).padStart(4, "0")}`,
    }));
    expect(
      parseSmsKeywordResponseRows(envelope(keywordInventory), TENANT),
    ).toHaveLength(512);
    expect(
      parseSmsKeywordResponseRows(
        envelope([
          ...keywordInventory,
          { ...keywordRow, id: rowId(512), keyword: "K0512" },
        ]),
        TENANT,
      ),
    ).toBeNull();
    expect(
      parseSmsKeywordResponseRows(
        envelope([
          { ...keywordRow, id: rowId(1), keyword: "ZULU" },
          { ...keywordRow, id: rowId(2), keyword: "ALPHA" },
        ]),
        TENANT,
      ),
    ).toBeNull();
  });

  it("accepts only the exact policy delete receipt", () => {
    expect(
      parseSmsPolicyDeleteReceipt(
        { ok: true, tenantId: TENANT, id: QUIET_ID },
        TENANT,
        QUIET_ID,
      ),
    ).toBe(true);
    expect(
      parseSmsPolicyDeleteReceipt(
        { ok: true, tenantId: OTHER_TENANT, id: QUIET_ID },
        TENANT,
        QUIET_ID,
      ),
    ).toBe(false);
    expect(
      parseSmsPolicyDeleteReceipt(
        { ok: true, tenantId: TENANT, id: QUIET_ID, detail: "deleted" },
        TENANT,
        QUIET_ID,
      ),
    ).toBe(false);
  });
});

describe("minuteToHHMM / hhmmToMinute", () => {
  it("round-trips every quarter-hour of the day", () => {
    for (let m = 0; m < 1440; m += 15) {
      expect(hhmmToMinute(minuteToHHMM(m))).toBe(m);
    }
  });

  it("formats boundaries", () => {
    expect(minuteToHHMM(0)).toBe("00:00");
    expect(minuteToHHMM(9 * 60)).toBe("09:00");
    expect(minuteToHHMM(21 * 60)).toBe("21:00");
    expect(minuteToHHMM(1439)).toBe("23:59");
  });

  it("clamps out-of-range minutes instead of emitting 24:00", () => {
    expect(minuteToHHMM(1440)).toBe("23:59");
    expect(minuteToHHMM(-5)).toBe("00:00");
  });

  it("parses strict 24-hour HH:MM only", () => {
    expect(hhmmToMinute("00:00")).toBe(0);
    expect(hhmmToMinute("23:59")).toBe(1439);
    expect(hhmmToMinute(" 09:30 ")).toBe(570);
    // Cleared <input type="time"> emits "" — must be null, not 0.
    expect(hhmmToMinute("")).toBeNull();
    expect(hhmmToMinute("24:00")).toBeNull();
    expect(hhmmToMinute("9:00")).toBeNull();
    expect(hhmmToMinute("09:60")).toBeNull();
    expect(hhmmToMinute("garbage")).toBeNull();
  });
});

describe("quiet-hours window semantics", () => {
  it("start > end is overnight (valid, crosses midnight)", () => {
    expect(isOvernightWindow(21 * 60, 9 * 60)).toBe(true);
    expect(isOvernightWindow(9 * 60, 17 * 60)).toBe(false);
    expect(isOvernightWindow(600, 600)).toBe(false);
  });

  it("labels same-day, overnight, and all-day windows", () => {
    expect(quietWindowLabel(9 * 60, 17 * 60)).toBe("09:00 – 17:00");
    expect(quietWindowLabel(21 * 60, 9 * 60)).toBe("21:00 – 09:00 (overnight)");
    // start == end holds the whole listed day (backend semantics).
    expect(quietWindowLabel(600, 600)).toBe("All day");
  });
});

describe("quiet-hours day handling (0=Sun .. 6=Sat)", () => {
  it("day options cover Sun..Sat in backend numbering", () => {
    expect(QUIET_DAY_OPTIONS.map((d) => d.value)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(QUIET_DAY_OPTIONS[0]?.short).toBe("Sun");
    expect(QUIET_DAY_OPTIONS[6]?.short).toBe("Sat");
  });

  it("normalizes: dedupe, drop out-of-range, sort", () => {
    expect(normalizeQuietDays([6, 0, 6, 3])).toEqual([0, 3, 6]);
    expect(normalizeQuietDays([7, -1, 2.5, 1])).toEqual([1]);
    expect(normalizeQuietDays([])).toEqual([]);
  });

  it("formats the named groupings", () => {
    expect(formatQuietDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(formatQuietDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(formatQuietDays([0, 6])).toBe("Weekends");
    expect(formatQuietDays([6, 0])).toBe("Weekends");
  });

  it("falls back to short names for other subsets", () => {
    expect(formatQuietDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatQuietDays([0])).toBe("Sun");
    expect(formatQuietDays([])).toBe("—");
  });
});

describe("reserved SMS keywords", () => {
  it("matches the server's reservedSMSKeywords set exactly", () => {
    // Mirrors apps/api/internal/sms/keyword_responses.go.
    expect([...RESERVED_SMS_KEYWORDS].sort()).toEqual(
      [
        "CANCEL",
        "END",
        "HELP",
        "OPTOUT",
        "QUIT",
        "REVOKE",
        "START",
        "STOP",
        "STOPALL",
        "UNSTOP",
        "UNSUBSCRIBE",
      ].sort(),
    );
  });

  it("checks case-insensitively with trimming (like Go's ReservedSMSKeyword)", () => {
    expect(isReservedSmsKeyword("stop")).toBe(true);
    expect(isReservedSmsKeyword("  Help ")).toBe(true);
    expect(isReservedSmsKeyword("STOPALL")).toBe(true);
    expect(isReservedSmsKeyword("PRICING")).toBe(false);
    // STOP2 etc. are NOT reserved — only exact words.
    expect(isReservedSmsKeyword("STOP2")).toBe(false);
    expect(isReservedSmsKeyword("")).toBe(false);
  });
});

describe("keyword normalization + validation", () => {
  it("normalizes to trimmed uppercase (server canonical form)", () => {
    expect(normalizeSmsKeyword("  pricing ")).toBe("PRICING");
    expect(normalizeSmsKeyword("Promo")).toBe("PROMO");
  });

  it("flags internal whitespace (first-word matching can never hit it)", () => {
    expect(smsKeywordHasWhitespace("TWO WORDS")).toBe(true);
    expect(smsKeywordHasWhitespace("TAB\tHERE")).toBe(true);
    expect(smsKeywordHasWhitespace("  PADDED  ")).toBe(false);
    expect(smsKeywordHasWhitespace("ONE")).toBe(false);
  });
});

describe("keyword action metadata", () => {
  it("exposes only current custom keyword actions in the select options", () => {
    expect(SMS_KEYWORD_ACTIONS.map((a) => a.value)).toEqual(["opt_out"]);
    expect(canMutateSmsKeywordAction("reply_only")).toBe(false);
    expect(canMutateSmsKeywordAction("opt_out")).toBe(true);
    expect(canMutateSmsKeywordAction("opt_in")).toBe(false);
  });

  it("maps only current wire actions", () => {
    expect(keywordActionMeta("opt_out")).toEqual({
      label: "Opt out",
      badgeClass: "badge danger",
    });
    expect(keywordActionMeta("reply_only")).toEqual({
      label: "Stored reply — dispatch held",
      badgeClass: "badge",
    });
  });

  it("degrades unknown actions to a plain badge", () => {
    expect(keywordActionMeta("future_action")).toEqual({
      label: "future_action",
      badgeClass: "badge",
    });
    expect(keywordActionMeta("")).toEqual({ label: "—", badgeClass: "badge" });
  });
});

describe("previewSmsResponse", () => {
  it("collapses whitespace into one line", () => {
    expect(previewSmsResponse("hello\n\nworld\t!")).toBe("hello world !");
  });

  it("passes short bodies through", () => {
    expect(previewSmsResponse("short reply")).toBe("short reply");
  });

  it("ellipsizes long bodies at the cap", () => {
    const long = "x".repeat(200);
    const out = previewSmsResponse(long, 80);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});
