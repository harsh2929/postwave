/**
 * P3 — "on-demand vendor verify (single address / synchronous batch)".
 *
 * This is the ONE mobile control that can spend a third-party credit on a
 * single tap, so this suite is written against the money rather than against
 * the pixels. The five facts it pins:
 *
 *  1. NOTHING FIRES ON RENDER. Mounting the card next to a subscriber's email
 *     must not call the vendor, and there is no text input, so nothing can
 *     fire on typing either.
 *  2. THE PRESS IS CONFIRMED, and declining spends nothing.
 *  3. A RETRY OF A FAILED ATTEMPT REUSES ITS IDEMPOTENCY KEY, so a second
 *     press REPLAYS on the server instead of buying a second check. A fresh
 *     key is minted only after a SETTLED answer.
 *  4. AN AMBIGUOUS OUTCOME (the server's 409) removes the button entirely and
 *     shows the SERVER's do-not-retry sentence — not the generic status copy,
 *     which would tell the operator to retry a possibly-charged request.
 *  5. THE SPEND IS REPORTED FROM THE SERVER'S FLAGS. A cached or locally
 *     settled answer is never described as a purchase.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

const mockVerify = { mutate: jest.fn(), isPending: false };
const mockConfirm = jest.fn<(options: unknown) => Promise<boolean>>(
  async () => true,
);
const mockToast = jest.fn();
let mockMintCount = 0;

jest.mock("@/hooks/useVendorVerify", () => ({
  useVerifyAddressWithVendor: () => mockVerify,
  // Counts up so a REUSED key is distinguishable from a re-minted one.
  mintVendorVerifyKey: () => `key-${++mockMintCount}`,
}));
jest.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => mockConfirm,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));

// eslint-disable-next-line import/first
import { VendorVerifyError } from "@/api/vendorVerify";
// eslint-disable-next-line import/first
import { VendorVerifyAction } from "@/components/subscriber/sections/VendorVerifyAction";
// eslint-disable-next-line import/first
import * as Gate from "@/hooks/useOnlineQueryGate";
// eslint-disable-next-line import/first
import { parseVendorVerifyResult } from "@/lib/vendorVerify";

const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

const EMAIL = " Person@Example.COM ";
const BUTTON = "Check this address with the verification vendor now";

type MutateOptions = {
  onSuccess: (value: unknown) => void;
  onError: (err: unknown) => void;
};

/** The `{ email, idempotencyKey }` of the nth mutate call. */
function variables(index: number) {
  return mockVerify.mutate.mock.calls[index]?.[0] as {
    email: string;
    idempotencyKey: string;
  };
}

function options(index: number): MutateOptions {
  return mockVerify.mutate.mock.calls[index]?.[1] as MutateOptions;
}

/**
 * Deliver a mutation callback the way react-query would — inside React — so
 * the attempt state the reuse rule turns on is committed before the next press.
 */
async function settleWith(index: number, value: unknown) {
  await act(async () => {
    options(index).onSuccess(value);
  });
}

async function failWith(index: number, err: unknown) {
  await act(async () => {
    options(index).onError(err);
  });
}

/** Press the button and wait for the confirm to have been answered. */
async function pressAndConfirm(screen: {
  getByLabelText: (label: string) => unknown;
}) {
  await fireEvent.press(screen.getByLabelText(BUTTON) as never);
  await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
}

afterEach(() => {
  gateHarness.__resetOnlineGateForTests();
  mockVerify.mutate.mockReset();
  mockToast.mockReset();
  mockConfirm.mockReset();
  mockConfirm.mockResolvedValue(true);
  mockMintCount = 0;
});

describe("VendorVerifyAction — the paid call is never implicit", () => {
  it("calls NOTHING on render", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    expect(screen.getByLabelText(BUTTON)).toBeTruthy();
    expect(mockVerify.mutate).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("spends nothing when the confirmation is declined", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    mockConfirm.mockResolvedValue(false);
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    expect(mockVerify.mutate).not.toHaveBeenCalled();
  });

  it("says the vendor is called and a credit charged BEFORE anything moves", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    const copy = mockConfirm.mock.calls[0]?.[0] as { consequence: string };
    expect(copy.consequence).toContain("person@example.com");
    expect(copy.consequence).toContain("probes the mailbox live");
    expect(copy.consequence).toContain("charges one provider credit");
  });

  it("sends the normalized address with an explicit idempotency key", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));
    expect(variables(0)).toEqual({
      email: "person@example.com",
      idempotencyKey: "key-1",
    });
  });
});

describe("VendorVerifyAction — the role and connectivity floors", () => {
  it("offers a viewer no button and explains why", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    expect(screen.queryByLabelText(BUTTON)).toBeNull();
    expect(
      screen.getByText(
        "A live vendor check spends a provider credit, so it needs an editor.",
      ),
    ).toBeTruthy();
  });

  it("refuses offline and says the request is never queued", async () => {
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "owner",
      enabled: false,
    });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    expect(screen.queryByLabelText(BUTTON)).toBeNull();
    expect(screen.getByText(/it is never queued/u)).toBeTruthy();
  });
});

describe("VendorVerifyAction — a second press must not buy a second check", () => {
  it("REUSES the key after a failed attempt, so the server replays", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));

    // A transport-shaped failure: the address may still have reached the vendor.
    await failWith(0, new Error("Network request failed"));

    mockConfirm.mockClear();
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(2));
    expect(variables(1).idempotencyKey).toBe("key-1");
    expect(variables(1).idempotencyKey).toBe(variables(0).idempotencyKey);
  });

  it("mints a NEW key once an answer settled, because that is a new question", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));

    await settleWith(0, 
      parseVendorVerifyResult({
        email: "person@example.com",
        status: "valid",
        provider: "zerobounce",
        billable: true,
      }),
    );
    // Press again only once the answer is on screen — which is when a person
    // would, and which is the state the reuse rule turns on.
    await waitFor(() =>
      expect(
        screen.getByText("One provider credit spent with zerobounce."),
      ).toBeTruthy(),
    );

    mockConfirm.mockClear();
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(2));
    expect(variables(1).idempotencyKey).toBe("key-2");
  });

  it("removes the button entirely on an ambiguous 409 and keeps the server's words", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));

    const AMBIGUOUS =
      "Some provider requests may have completed before the batch failed. The batch was not retried to avoid duplicate charges.";
    await failWith(0, 
      new VendorVerifyError(
        {
          status: 409,
          code: "verification_provider_outcome_ambiguous",
          message: AMBIGUOUS,
        },
        "Couldn't check that address with the vendor.",
      ),
    );

    await waitFor(() => expect(screen.queryByLabelText(BUTTON)).toBeNull());
    expect(screen.getByText(AMBIGUOUS)).toBeTruthy();
    // The generic status table maps 409 to a RETRY prompt — the one thing the
    // server refused to do on a possibly-charged request.
    expect(screen.queryByText(/Something went wrong loading this/u)).toBeNull();
    expect(
      screen.getByText(/so a credit is not spent twice/u),
    ).toBeTruthy();
    expect(mockVerify.mutate).toHaveBeenCalledTimes(1);
  });

  it("keeps the usage-accounting 409 in the server's words too", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));

    const MESSAGE =
      "Verification completed, but its usage record could not be confirmed. This request was not retried to avoid duplicate accounting or provider charges.";
    await failWith(0, 
      new VendorVerifyError(
        {
          status: 409,
          code: "verification_usage_outcome_ambiguous",
          message: MESSAGE,
        },
        "Couldn't check that address with the vendor.",
      ),
    );
    await waitFor(() => expect(screen.getByText(MESSAGE)).toBeTruthy());
  });
});

describe("VendorVerifyAction — a refusal says why", () => {
  it("a 402 no-credits refusal is not a loading failure", async () => {
    // verification/handlers.go answers ErrNoCredits with a 402 PLAN denial
    // (remedy add_provider_credits). lib/verificationErrors leaves that code
    // to errorCopy's denial branch, which only works if the error class
    // carries the denial. It did not, so a paid write read as a failed load.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));

    await failWith(0,
      new VendorVerifyError(
        {
          status: 402,
          code: "verification_no_credits",
          message: "The verification provider reported no remaining credits.",
          denial: {
            subject: "email_verification",
            reason: "plan",
            code: "verification_no_credits",
            remedy: "add_provider_credits",
          },
        },
        "Couldn't check that address with the vendor.",
      ),
    );

    expect(mockToast).toHaveBeenCalledTimes(1);
    const toast = mockToast.mock.calls[0]?.[0] as { kind: string; message: string };
    expect(toast.kind).toBe("error");
    expect(toast.message).not.toMatch(/Something went wrong loading this/u);
    expect(toast.message).toBe(
      "You've reached this workspace's limit. Upgrading won't raise it.",
    );
  });
});

describe("VendorVerifyAction — what the answer cost", () => {
  it("names the vendor that was charged", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));
    await settleWith(0, 
      parseVendorVerifyResult({
        email: "person@example.com",
        status: "invalid",
        sub_status: "mailbox_not_found",
        provider: "zerobounce",
        billable: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("One provider credit spent with zerobounce."),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText("Invalid — this address cannot receive mail. (mailbox not found)"),
    ).toBeTruthy();
  });

  it("never calls a cached or locally-settled answer a purchase", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const screen = await render(<VendorVerifyAction email={EMAIL} />);
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));
    await settleWith(0, 
      parseVendorVerifyResult({
        email: "person@example.com",
        status: "valid",
        provider: "zerobounce",
        billable: false,
        cached: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Answered from this workspace's cached result — no credit spent.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/credit spent with/u)).toBeNull();
  });

  it("re-reads the derived health once a fresh verdict lands", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    const onVerified = jest.fn();
    const screen = await render(
      <VendorVerifyAction email={EMAIL} onVerified={onVerified} />,
    );
    await pressAndConfirm(screen);
    await waitFor(() => expect(mockVerify.mutate).toHaveBeenCalledTimes(1));
    expect(onVerified).not.toHaveBeenCalled();
    await settleWith(0, 
      parseVendorVerifyResult({ status: "valid", provider: "local" }),
    );
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });
});
