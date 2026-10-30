import { describe, expect, it } from "vitest";

import {
  deviceTimezone,
  dstWarning,
  firstSendingError,
  isKnownTimezone,
  isThrottleConfigured,
  MAX_SENDS_PER_HOUR,
  savedAtValue,
  sendingSettingsExpectedRevision,
  sendingSettingsMatchesTenant,
  sendingFormDirty,
  sendingStatusReason,
  sendingFormFromRow,
  validateSendingForm,
  type SendingFormState,
} from "./sendingForm";

function form(overrides: Partial<SendingFormState> = {}): SendingFormState {
  return {
    maxSendsPerHour: "",
    quietStart: "",
    quietEnd: "",
    quietTz: "",
    perRecipient: true,
    ...overrides,
  };
}

describe("isKnownTimezone", () => {
  it("accepts a real IANA zone", () => {
    expect(isKnownTimezone("America/New_York")).toBe(true);
    expect(isKnownTimezone(" Europe/London ")).toBe(true);
  });

  it("rejects the things a phone keyboard actually produces", () => {
    expect(isKnownTimezone("America/new york")).toBe(false);
    expect(isKnownTimezone("Pacific Time")).toBe(false);
    expect(isKnownTimezone("")).toBe(false);
  });
});

describe("validateSendingForm", () => {
  it("flags an unrecognised timezone instead of letting it 400 server-side", () => {
    const errs = validateSendingForm(
      form({ quietStart: "22:00", quietEnd: "07:00", quietTz: "EST5EDT?" }),
    );
    expect(errs.quietTz).toContain("timezone");
  });

  it("accepts a complete, valid quiet-hours config", () => {
    const errs = validateSendingForm(
      form({
        maxSendsPerHour: "5000",
        quietStart: "22:00",
        quietEnd: "07:00",
        quietTz: "America/New_York",
      }),
    );
    expect(errs).toEqual({});
  });

  it("enforces all-or-nothing quiet hours", () => {
    const errs = validateSendingForm(form({ quietStart: "22:00" }));
    expect(errs.quietEnd).toBe("Required when quiet hours are set.");
    expect(errs.quietTz).toBe("Required when quiet hours are set.");
    expect(errs.quietStart).toBeUndefined();
  });

  it("rejects a 24-hour clock that is not 24-hour", () => {
    const errs = validateSendingForm(
      form({ quietStart: "10pm", quietEnd: "24:00", quietTz: "UTC" }),
    );
    expect(errs.quietStart).toContain("HH:MM");
    expect(errs.quietEnd).toContain("HH:MM");
  });

  it("refuses a window that starts and ends at the same minute", () => {
    // The server 400s it (equal_quiet_hours) and both wire schemas reject it;
    // before CQ-3 the form alone let it through, so Save sent a PUT and the
    // operator got a raw toast with no field highlighted.
    const equal = form({
      quietStart: "22:00",
      quietEnd: "22:00",
      quietTz: "UTC",
    });
    const errs = validateSendingForm(equal);
    expect(errs).toEqual({
      quietEnd: "End time must differ from the start time.",
    });
    expect(firstSendingError(errs)).toBe(
      "End time must differ from the start time.",
    );
    // Leading/trailing space is what the save trims away, so it is still equal.
    expect(
      validateSendingForm(form({ ...equal, quietEnd: " 22:00 " })).quietEnd,
    ).toBe("End time must differ from the start time.");
  });

  it("keeps a malformed end's own message rather than the equality one", () => {
    const errs = validateSendingForm(
      form({ quietStart: "24:00", quietEnd: "24:00", quietTz: "UTC" }),
    );
    expect(errs.quietStart).toContain("HH:MM");
    expect(errs.quietEnd).toBe("Use 24-hour HH:MM (e.g. 07:00).");
  });

  it("rejects a non-integer or absurd cap but allows blank", () => {
    expect(
      validateSendingForm(form({ maxSendsPerHour: "0" })).maxSendsPerHour,
    ).toBeDefined();
    expect(
      validateSendingForm(form({ maxSendsPerHour: "12.5" })).maxSendsPerHour,
    ).toBeDefined();
    expect(
      validateSendingForm(form({ maxSendsPerHour: "9000000" })).maxSendsPerHour,
    ).toBeDefined();
    expect(validateSendingForm(form()).maxSendsPerHour).toBeUndefined();
  });

  it("holds the cap ceiling at exactly MAX_SENDS_PER_HOUR", () => {
    expect(MAX_SENDS_PER_HOUR).toBe(1_000_000);
    expect(
      validateSendingForm(
        form({ maxSendsPerHour: String(MAX_SENDS_PER_HOUR) }),
      ),
    ).toEqual({});
    expect(
      validateSendingForm(
        form({ maxSendsPerHour: String(MAX_SENDS_PER_HOUR + 1) }),
      ).maxSendsPerHour,
    ).toBe("Above 1,000,000/hour is almost certainly wrong.");
  });
});

describe("firstSendingError", () => {
  it("reports the topmost field so the message matches the highlighted input", () => {
    expect(
      firstSendingError({ quietEnd: "second", maxSendsPerHour: "first" }),
    ).toBe("first");
    expect(firstSendingError({})).toBeNull();
  });
});

describe("sendingFormFromRow / dirty", () => {
  it("treats a null cap as blank, not as the string 'null'", () => {
    expect(
      sendingFormFromRow({ max_sends_per_hour: null }).maxSendsPerHour,
    ).toBe("");
    expect(
      sendingFormFromRow({ max_sends_per_hour: 500 }).maxSendsPerHour,
    ).toBe("500");
  });

  it("defaults per-recipient quiet hours to on when the row omits it", () => {
    expect(sendingFormFromRow(undefined).perRecipient).toBe(true);
  });

  it("detects a change in any field, including the switch", () => {
    const base = form();
    expect(sendingFormDirty(base, form())).toBe(false);
    expect(sendingFormDirty(base, form({ perRecipient: false }))).toBe(true);
    expect(sendingFormDirty(base, form({ quietTz: "UTC" }))).toBe(true);
  });
});

describe("isThrottleConfigured", () => {
  it("is false for an unset row and for a zero cap", () => {
    expect(isThrottleConfigured(undefined)).toBe(false);
    expect(isThrottleConfigured({ max_sends_per_hour: 0 })).toBe(false);
  });

  it("is true when either a cap or any quiet-hours field is set", () => {
    expect(isThrottleConfigured({ max_sends_per_hour: 10 })).toBe(true);
    expect(isThrottleConfigured({ quiet_hours_tz: "UTC" })).toBe(true);
  });
});

describe("savedAtValue", () => {
  it("suppresses the Go zero time rather than rendering year 1", () => {
    expect(savedAtValue("0001-01-01T00:00:00Z")).toBeNull();
    expect(savedAtValue(undefined)).toBeNull();
  });

  it("passes a real timestamp through", () => {
    expect(savedAtValue("2026-07-25T10:00:00Z")).toBe("2026-07-25T10:00:00Z");
  });
});

describe("sendingSettingsExpectedRevision", () => {
  it("maps the Go zero timestamp to the first-write assertion", () => {
    expect(sendingSettingsExpectedRevision("0001-01-01T00:00:00Z")).toBe("");
  });

  it("preserves an exact valid revision and rejects absent or malformed values", () => {
    expect(sendingSettingsExpectedRevision("2026-08-30T08:00:00.123Z")).toBe(
      "2026-08-30T08:00:00.123Z",
    );
    expect(sendingSettingsExpectedRevision(undefined)).toBeNull();
    expect(sendingSettingsExpectedRevision("not-a-time")).toBeNull();
  });

  it.each([
    "2026-02-30T08:00:00Z",
    "2025-02-29T08:00:00Z",
    "2026-13-01T08:00:00Z",
    "2026-08-30T08:00:00+14:01",
    "2026-08-30T08:00:00+15:00",
    "2026-08-30 08:00:00Z",
    "2026-08-30T08:00:00.1234567890Z",
  ])("rejects non-RFC3339 or impossible revision %s", (revision) => {
    expect(sendingSettingsExpectedRevision(revision)).toBeNull();
  });

  it("accepts leap day and the maximum legal RFC3339 offset", () => {
    expect(sendingSettingsExpectedRevision("2024-02-29T08:00:00+14:00")).toBe(
      "2024-02-29T08:00:00+14:00",
    );
  });
});

describe("sendingSettingsMatchesTenant", () => {
  it("accepts only an exact non-empty active-workspace match", () => {
    expect(
      sendingSettingsMatchesTenant({ tenant_id: "tenant-a" }, "tenant-a"),
    ).toBe(true);
    expect(
      sendingSettingsMatchesTenant({ tenant_id: "tenant-b" }, "tenant-a"),
    ).toBe(false);
    expect(sendingSettingsMatchesTenant({}, "tenant-a")).toBe(false);
    expect(sendingSettingsMatchesTenant({ tenant_id: "" }, "")).toBe(false);
  });
});

describe("dstWarning", () => {
  it("warns when a spring-forward falls inside the window", () => {
    // US DST 2026 starts Sun 8 March. Look from 1 March.
    const now = Date.parse("2026-03-01T12:00:00Z");
    const msg = dstWarning("America/New_York", { now, days: 14 });
    expect(msg).toContain("forward");
  });

  it("warns when a fall-back falls inside the window", () => {
    // US DST 2026 ends Sun 1 November.
    const now = Date.parse("2026-10-26T12:00:00Z");
    const msg = dstWarning("America/New_York", { now, days: 14 });
    expect(msg).toContain("back");
  });

  it("says nothing in a quiet fortnight or for a zone with no DST", () => {
    const now = Date.parse("2026-06-01T12:00:00Z");
    expect(dstWarning("America/New_York", { now, days: 14 })).toBeNull();
    expect(dstWarning("UTC", { now, days: 14 })).toBeNull();
    expect(dstWarning("not/a/zone", { now })).toBeNull();
  });
});

describe("deviceTimezone", () => {
  it("returns a zone the validator agrees with", () => {
    const tz = deviceTimezone();
    expect(typeof tz).toBe("string");
    if (tz) expect(isKnownTimezone(tz)).toBe(true);
  });
});

describe("sendingStatusReason", () => {
  it("names OFFLINE as the reason, not a generic failure", () => {
    // Offline is a state the user can act on; "couldn't load" is not.
    expect(sendingStatusReason({ online: false, failed: false })).toContain(
      "offline",
    );
    // Offline wins even when the query also reports an error, because the
    // error is a consequence of being offline, not an independent fault.
    expect(sendingStatusReason({ online: false, failed: true })).toContain(
      "offline",
    );
  });

  it("distinguishes a failed read from a pending one", () => {
    expect(sendingStatusReason({ online: true, failed: true })).toContain(
      "couldn't be loaded",
    );
    expect(sendingStatusReason({ online: true, failed: false })).toContain(
      "Loading",
    );
  });

  it("never lets a missing counter cast doubt on the saved settings", () => {
    // The regression this guards: an operator reading "can't load" as "your
    // throttle may not be applied" and lifting a cap that is still holding.
    for (const input of [
      { online: false, failed: false },
      { online: true, failed: true },
    ]) {
      expect(sendingStatusReason(input)).toContain(
        "saved configuration below is still accurate",
      );
    }
  });
});
