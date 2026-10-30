/**
 * subscriberValidateEmails — verdict vocabulary and receipt honesty.
 *
 * The label map must mirror desktop's verdictLabel VERBATIM (two clients
 * describing the same verdict differently is how support calls start), an
 * unknown verdict must pass through unmangled, and the receipt must name the
 * skipped rows rather than folding them into the checked count.
 */
import { describe, expect, it } from "vitest";

import {
  invalidValidationRows,
  parseValidationBatch,
  validationReceipt,
  verdictLabel,
} from "./subscriberValidateEmails";

describe("verdictLabel — desktop's map, verbatim", () => {
  it("labels the five known verdicts", () => {
    expect(verdictLabel("ok")).toBe("Deliverable");
    expect(verdictLabel("syntax_invalid")).toBe("Invalid syntax");
    expect(verdictLabel("no_mx")).toBe("No mail server (MX)");
    expect(verdictLabel("disposable")).toBe("Disposable domain");
    expect(verdictLabel("role_account")).toBe("Role account");
  });

  it("passes an unknown verdict through verbatim — never mislabeled", () => {
    expect(verdictLabel("greylisted")).toBe("greylisted");
  });
});

describe("parseValidationBatch", () => {
  const payload = {
    results: [
      { email: "a@x.com", valid: true, verdict: "ok" },
      { email: "bad@", valid: false, verdict: "syntax_invalid" },
      { email: "b@nope.invalid", valid: false, verdict: "no_mx" },
      { email: "c@mailinator.com", valid: false, verdict: "disposable" },
      { email: "d@nope2.invalid", valid: false, verdict: "no_mx" },
    ],
    summary: { total: 5, valid: 1, invalid: 4 },
  };

  it("keeps the server summary and computes the invalid-verdict breakdown", () => {
    const view = parseValidationBatch(payload);
    expect(view.total).toBe(5);
    expect(view.valid).toBe(1);
    expect(view.byVerdict).toEqual([
      ["syntax_invalid", 1],
      ["no_mx", 2],
      ["disposable", 1],
    ]);
    expect(invalidValidationRows(view).map((r) => r.email)).toEqual([
      "bad@",
      "b@nope.invalid",
      "c@mailinator.com",
      "d@nope2.invalid",
    ]);
  });

  it("falls back to counting rows when the summary is absent, and survives junk", () => {
    const view = parseValidationBatch({ results: payload.results });
    expect(view.total).toBe(5);
    expect(view.invalid).toBe(4);
    expect(parseValidationBatch(null).rows).toEqual([]);
  });
});

describe("validationReceipt", () => {
  it("says LOOK deliverable and names flagged + skipped counts", () => {
    const view = parseValidationBatch({
      results: [
        { email: "a@x.com", valid: true, verdict: "ok" },
        { email: "bad@", valid: false, verdict: "syntax_invalid" },
      ],
      summary: { total: 2, valid: 1, invalid: 1 },
    });
    expect(validationReceipt(view, 3)).toBe(
      "1 of 2 look deliverable, 1 flagged. · 3 selected without an address",
    );
    expect(validationReceipt(parseValidationBatch({
      results: [{ email: "a@x.com", valid: true, verdict: "ok" }],
      summary: { total: 1, valid: 1, invalid: 0 },
    }), 0)).toBe("1 of 1 look deliverable.");
  });
});
