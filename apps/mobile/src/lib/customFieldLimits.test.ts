import { describe, expect, it } from "vitest";

import {
  CUSTOM_FIELD_WARN_FRACTION,
  customFieldGovernanceBadge,
  customFieldGovernanceState,
  customFieldLimitReadout,
  customFieldLimitsDirty,
  customFieldLimitsDraft,
  customFieldLimitsPatch,
  customFieldLimitsSaveError,
  customFieldUsageFraction,
  customFieldUsageLine,
  isCustomFieldLimits,
  normalizeCustomFieldLimits,
  parseCustomFieldCap,
  type CustomFieldLimits,
} from "./customFieldLimits";

const WIRE = {
  max_custom_fields: 1000,
  max_searchable_fields: 3,
  used_custom_fields: 12,
  used_searchable_fields: 2,
};

const LIMITS: CustomFieldLimits = {
  maxCustomFields: 1000,
  maxSearchableFields: 3,
  usedCustomFields: 12,
  usedSearchableFields: 2,
};

describe("normalizeCustomFieldLimits", () => {
  it("reads the four counters the handler returns", () => {
    expect(normalizeCustomFieldLimits(WIRE)).toEqual(LIMITS);
  });

  it("is null when ANY counter is missing — three of four is not a ratio", () => {
    for (const key of Object.keys(WIRE)) {
      const partial: Record<string, unknown> = { ...WIRE };
      delete partial[key];
      expect(normalizeCustomFieldLimits(partial)).toBeNull();
    }
  });

  it("refuses negative, fractional and stringified counters", () => {
    expect(
      normalizeCustomFieldLimits({ ...WIRE, used_custom_fields: -1 }),
    ).toBeNull();
    expect(
      normalizeCustomFieldLimits({ ...WIRE, max_custom_fields: 3.5 }),
    ).toBeNull();
    expect(
      normalizeCustomFieldLimits({ ...WIRE, max_searchable_fields: "3" }),
    ).toBeNull();
  });

  it("refuses the shapes a shared cache can hold instead of a row", () => {
    expect(normalizeCustomFieldLimits(null)).toBeNull();
    expect(normalizeCustomFieldLimits([WIRE])).toBeNull();
    expect(normalizeCustomFieldLimits({ items: [] })).toBeNull();
  });

  it("accepts a workspace with zero of everything", () => {
    expect(
      normalizeCustomFieldLimits({
        max_custom_fields: 0,
        max_searchable_fields: 0,
        used_custom_fields: 0,
        used_searchable_fields: 0,
      }),
    ).toEqual({
      maxCustomFields: 0,
      maxSearchableFields: 0,
      usedCustomFields: 0,
      usedSearchableFields: 0,
    });
  });
});

describe("isCustomFieldLimits", () => {
  it("accepts what normalize produced and rejects everything else", () => {
    expect(isCustomFieldLimits(LIMITS)).toBe(true);
    expect(isCustomFieldLimits([LIMITS])).toBe(false);
    expect(isCustomFieldLimits({ items: [] })).toBe(false);
    expect(isCustomFieldLimits(undefined)).toBe(false);
    expect(isCustomFieldLimits({ ...LIMITS, usedCustomFields: -1 })).toBe(false);
  });
});

describe("customFieldUsageFraction", () => {
  it("is used/max, clamped into [0,1]", () => {
    expect(customFieldUsageFraction(12, 1000)).toBeCloseTo(0.012);
    expect(customFieldUsageFraction(3, 3)).toBe(1);
    expect(customFieldUsageFraction(9, 3)).toBe(1);
  });

  it("does not divide by a zero cap", () => {
    expect(customFieldUsageFraction(0, 0)).toBe(0);
    expect(customFieldUsageFraction(4, 0)).toBe(1);
    expect(Number.isFinite(customFieldUsageFraction(4, 0))).toBe(true);
  });
});

describe("customFieldGovernanceState", () => {
  it("is `at` on the exact predicate checkCreateLimit refuses on (used >= max)", () => {
    expect(customFieldGovernanceState(3, 3)).toBe("at");
    // Over the cap — a workspace whose cap was lowered under it — must not
    // read as healthy.
    expect(customFieldGovernanceState(5, 3)).toBe("at");
  });

  it("warns from 90% and not before", () => {
    expect(CUSTOM_FIELD_WARN_FRACTION).toBe(0.9);
    expect(customFieldGovernanceState(90, 100)).toBe("near");
    expect(customFieldGovernanceState(89, 100)).toBe("ok");
    expect(customFieldGovernanceState(99, 100)).toBe("near");
  });

  it("is ok with room to spare", () => {
    expect(customFieldGovernanceState(12, 1000)).toBe("ok");
    expect(customFieldGovernanceState(0, 0)).toBe("at");
  });
});

describe("customFieldGovernanceBadge", () => {
  it("names only the two states worth a badge", () => {
    expect(customFieldGovernanceBadge("at")).toBe("At limit");
    expect(customFieldGovernanceBadge("near")).toBe("Near limit");
    expect(customFieldGovernanceBadge("ok")).toBeNull();
  });
});

describe("customFieldUsageLine", () => {
  it("reads a bar the way desktop does", () => {
    expect(customFieldUsageLine(12, 1000, "total fields")).toBe(
      "12 / 1000 total fields",
    );
    expect(customFieldUsageLine(2, 3, "searchable fields")).toBe(
      "2 / 3 searchable fields",
    );
  });
});

describe("customFieldLimitReadout", () => {
  it("states what the cap is refusing right now", () => {
    expect(customFieldLimitReadout(LIMITS)).toBe(
      "Existing fields are never removed by a cap — a cap only refuses the next one.",
    );
    expect(
      customFieldLimitReadout({ ...LIMITS, usedSearchableFields: 3 }),
    ).toBe("A new field can still be added, but not a searchable one.");
    expect(customFieldLimitReadout({ ...LIMITS, usedCustomFields: 1000 })).toBe(
      "New custom fields are being refused at the cap.",
    );
    expect(
      customFieldLimitReadout({
        ...LIMITS,
        usedCustomFields: 1000,
        usedSearchableFields: 3,
      }),
    ).toBe(
      "New custom fields and new searchable fields are both being refused at the cap.",
    );
  });
});

describe("parseCustomFieldCap", () => {
  it("takes whole numbers including zero", () => {
    expect(parseCustomFieldCap("0")).toBe(0);
    expect(parseCustomFieldCap("250")).toBe(250);
  });

  it("is null for anything that is not a number", () => {
    expect(parseCustomFieldCap("")).toBeNull();
    expect(parseCustomFieldCap("   ")).toBeNull();
    expect(parseCustomFieldCap("abc")).toBeNull();
  });
});

describe("customFieldLimitsPatch", () => {
  it("sends ONLY the cap that changed", () => {
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "2000",
        maxSearchableFields: "3",
      }),
    ).toEqual({ ok: true, body: { max_custom_fields: 2000 } });
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "1000",
        maxSearchableFields: "5",
      }),
    ).toEqual({ ok: true, body: { max_searchable_fields: 5 } });
  });

  it("sends both when both changed", () => {
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "1",
        maxSearchableFields: "1",
      }),
    ).toEqual({
      ok: true,
      body: { max_custom_fields: 1, max_searchable_fields: 1 },
    });
  });

  it("yields an EMPTY body for an unchanged draft — the server's own no_fields", () => {
    const result = customFieldLimitsPatch(LIMITS, customFieldLimitsDraft(LIMITS));
    expect(result).toEqual({ ok: true, body: {} });
  });

  it("refuses an unparseable cap, naming the field, before any request", () => {
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "",
        maxSearchableFields: "3",
      }),
    ).toEqual({
      ok: false,
      message: "Total fields cap must be a whole number ≥ 0.",
    });
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "1000",
        maxSearchableFields: "many",
      }),
    ).toEqual({
      ok: false,
      message: "Searchable fields cap must be a whole number ≥ 0.",
    });
  });

  it("allows zero, which the handler accepts (only negatives are refused)", () => {
    expect(
      customFieldLimitsPatch(LIMITS, {
        maxCustomFields: "0",
        maxSearchableFields: "3",
      }),
    ).toEqual({ ok: true, body: { max_custom_fields: 0 } });
  });
});

describe("customFieldLimitsDirty", () => {
  it("is false only for a draft that parses back to the saved caps", () => {
    expect(customFieldLimitsDirty(LIMITS, customFieldLimitsDraft(LIMITS))).toBe(
      false,
    );
    expect(
      customFieldLimitsDirty(LIMITS, {
        maxCustomFields: "999",
        maxSearchableFields: "3",
      }),
    ).toBe(true);
    // Unparseable is dirty, so Save stays live to report the refusal.
    expect(
      customFieldLimitsDirty(LIMITS, {
        maxCustomFields: "",
        maxSearchableFields: "3",
      }),
    ).toBe(true);
  });
});

describe("customFieldLimitsSaveError", () => {
  it("shows the handler's 400 sentences verbatim — they name the field", () => {
    expect(
      customFieldLimitsSaveError({
        status: 400,
        code: "invalid_limit",
        message: "max_custom_fields must be non-negative",
      }),
    ).toBe("max_custom_fields must be non-negative");
    expect(
      customFieldLimitsSaveError({
        status: 400,
        code: "no_fields",
        message:
          "at least one of max_custom_fields or max_searchable_fields is required",
      }),
    ).toBe(
      "at least one of max_custom_fields or max_searchable_fields is required",
    );
  });

  it("answers a 403 with who can act, not with the server's bare refusal", () => {
    expect(
      customFieldLimitsSaveError({
        status: 403,
        code: "not_authorized",
        message: "forbidden",
      }),
    ).toBe("Only workspace admins can change custom-field caps.");
  });

  it("never renders an empty sentence", () => {
    expect(customFieldLimitsSaveError({ status: 500, message: "" })).toBe(
      "Couldn't save the custom-field caps.",
    );
    expect(customFieldLimitsSaveError({ status: 400, message: "   " })).toBe(
      "Couldn't save the custom-field caps.",
    );
  });
});
