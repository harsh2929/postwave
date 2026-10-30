import { describe, expect, it } from "vitest";

import { canResendConfirmation } from "./formSubmissions";

describe("canResendConfirmation", () => {
  it("offers a resend only for a pending submission", () => {
    expect(canResendConfirmation({ status: "pending" })).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(canResendConfirmation({ status: " PENDING " })).toBe(true);
  });

  it("refuses for an already-confirmed submission", () => {
    // The server answers 409; offering it would put a guaranteed refusal
    // beside a real action.
    expect(canResendConfirmation({ status: "confirmed" })).toBe(false);
  });

  it("refuses for an unknown or missing status rather than guessing", () => {
    // A status this build does not recognise came from a newer server.
    for (const status of [undefined, null, "", "   ", "quarantined"]) {
      expect(canResendConfirmation({ status })).toBe(false);
    }
  });
});
