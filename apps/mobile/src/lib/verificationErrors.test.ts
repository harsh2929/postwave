import { describe, expect, it } from "vitest";

import {
  verificationFailureMessage,
  verificationProviderProbeHint,
} from "./verificationErrors";

/** The exact sentence apps/api writes for an uncertain billable outcome. */
const AMBIGUOUS =
  "Some provider requests may have completed before the batch failed. The batch was not retried to avoid duplicate charges.";
/** What lib/errorCopy produces for a 409, which matches no arm of its table. */
const GENERIC = "Something went wrong loading this. Please try again.";

describe("verificationFailureMessage", () => {
  it("keeps the server's do-not-retry sentence instead of inviting a retry", () => {
    const shown = verificationFailureMessage({
      code: "verification_provider_outcome_ambiguous",
      serverMessage: AMBIGUOUS,
      fallback: GENERIC,
    });
    expect(shown).toBe(AMBIGUOUS);
    expect(shown).not.toContain("try again");
  });

  it("keeps the usage-accounting 409 for the same reason", () => {
    expect(
      verificationFailureMessage({
        code: "verification_usage_outcome_ambiguous",
        serverMessage: "Verification completed, but its usage record could not be confirmed.",
        fallback: GENERIC,
      }),
    ).toContain("usage record could not be confirmed");
  });

  it("names the customer-fixable configuration states", () => {
    for (const code of [
      "verification_not_configured",
      "verification_provider_unauthorized",
      "verification_provider_account_rejected",
      "verification_provider_unavailable",
    ]) {
      expect(
        verificationFailureMessage({
          code,
          serverMessage: `server sentence for ${code}`,
          fallback: GENERIC,
        }),
      ).toBe(`server sentence for ${code}`);
    }
  });

  it("leaves an unclassified failure to the status table", () => {
    expect(
      verificationFailureMessage({
        code: "",
        serverMessage: "internal error: pq: deadlock detected",
        fallback: GENERIC,
      }),
    ).toBe(GENERIC);
    expect(
      verificationFailureMessage({
        code: "some_future_code",
        serverMessage: "raw",
        fallback: GENERIC,
      }),
    ).toBe(GENERIC);
  });

  it("leaves the credit denial to the entitlement branch of errorCopy", () => {
    // verification_no_credits arrives as a Denial envelope with a remedy, and
    // lib/errorCopy renders that better than the bare sentence would.
    expect(
      verificationFailureMessage({
        code: "verification_no_credits",
        serverMessage: "The verification provider reported no remaining credits.",
        fallback: "Add provider credits to keep verifying addresses.",
      }),
    ).toBe("Add provider credits to keep verifying addresses.");
  });

  it("never surfaces an empty server message in place of the fallback", () => {
    expect(
      verificationFailureMessage({
        code: "verification_provider_outcome_ambiguous",
        serverMessage: "   ",
        fallback: GENERIC,
      }),
    ).toBe(GENERIC);
  });
});

describe("verificationProviderProbeHint", () => {
  it("names the escape hatch when the credential probe blocked the write", () => {
    const hint = verificationProviderProbeHint(
      "verification_provider_unauthorized",
    );
    expect(hint).toContain("re-checks its credential");
    expect(hint).toContain("Removing the vendor does not contact the provider");
  });

  it("stays silent for failures the probe did not cause", () => {
    expect(verificationProviderProbeHint("verification_provider_unavailable")).toBe("");
    expect(verificationProviderProbeHint("")).toBe("");
    expect(verificationProviderProbeHint("verification_no_credits")).toBe("");
  });
});
