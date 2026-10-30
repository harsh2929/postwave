// SPDX-License-Identifier: AGPL-3.0-only
//
// The paid vendor check, driven through the REAL rawRequest with only the SDK
// client mocked, so the error envelope is the one the app actually builds.
//
// The server answers ErrNoCredits with a 402 plan denial whose remedy is
// `add_provider_credits` (verification/handlers.go writeNoCreditsDenial).
// lib/verificationErrors leaves that code to errorCopy's denial branch on
// purpose. VendorVerifyError kept only status and code, so the denial never
// arrived, and the operator of a paid write was told "Something went wrong
// loading this. Please try again."
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorPresentation } from "@/lib/errorCopy";

import { getClient } from "./sdkClient";
import {
  VendorVerifyError,
  vendorVerifyErrorCode,
  vendorVerifyOutcomeAmbiguous,
  verifyAddressWithVendor,
} from "./vendorVerify";

vi.mock("./sdkClient", () => ({ getClient: vi.fn() }));

const NO_CREDITS = "The verification provider reported no remaining credits.";

function serverThrows(extra: Record<string, unknown>, message = NO_CREDITS) {
  const request = vi.fn(async () => {
    throw Object.assign(new Error(message), extra);
  });
  vi.mocked(getClient).mockReturnValue({ client: { request } } as never);
  return request;
}

beforeEach(() => vi.clearAllMocks());

describe("verifyAddressWithVendor keeps the server's refusal", () => {
  it("carries the 402 no-credits plan denial and renders it as one", async () => {
    const request = serverThrows({
      status: 402,
      code: "verification_no_credits",
      payload: {
        error: {
          subject: "email_verification",
          reason: "plan",
          code: "verification_no_credits",
          message: NO_CREDITS,
          remedy: "add_provider_credits",
        },
      },
    });

    const err = await verifyAddressWithVendor({
      email: "person@example.com",
      idempotencyKey: "k1",
    }).catch((e: unknown) => e);

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/verification/verify",
      { body: { email: "person@example.com" }, idempotencyKey: "k1" },
    );
    expect(err).toBeInstanceOf(VendorVerifyError);
    expect(err).toMatchObject({
      name: "VendorVerifyError",
      status: 402,
      message: NO_CREDITS,
      denial: { reason: "plan", remedy: "add_provider_credits" },
    });
    expect(vendorVerifyErrorCode(err)).toBe("verification_no_credits");
    expect(errorPresentation(err)).toEqual({
      message:
        "You've reached this workspace's limit. Upgrading won't raise it.",
      retryable: false,
    });
  });

  it("still names the ambiguous 409 by its code, with no denial invented", async () => {
    serverThrows(
      { status: 409, code: "verification_provider_outcome_ambiguous" },
      "The batch was not retried to avoid duplicate charges.",
    );
    const err = await verifyAddressWithVendor({
      email: "person@example.com",
      idempotencyKey: "k2",
    }).catch((e: unknown) => e);
    expect(vendorVerifyOutcomeAmbiguous(err)).toBe(true);
    expect(vendorVerifyErrorCode(err)).toBe(
      "verification_provider_outcome_ambiguous",
    );
    expect(err).not.toHaveProperty("denial");
  });

  it("reports an empty code for a failure that carried none", async () => {
    serverThrows({ status: 0 }, "Network request failed");
    const err = await verifyAddressWithVendor({
      email: "person@example.com",
      idempotencyKey: "k3",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VendorVerifyError);
    expect(vendorVerifyErrorCode(err)).toBe("");
  });
});
