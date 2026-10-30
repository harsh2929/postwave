import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock("./authSessions", () => ({
  approveDeviceGrant: mocks.submit,
}));

// Imported after the hoisted transport mock so this module sees the seam.
// eslint-disable-next-line import/first
import { approveDevice, inspectDevice } from "./deviceApprove";

const DISCLOSURE = {
  grant_kind: "session" as const,
  account: {
    email: "owner@example.test",
    workspace_name: "Acme",
  },
  device: {
    device_label: "Moosewave Mobile on Android",
    device_type: "mobile" as const,
    device_os: "Android",
  },
  expires_in: 540,
  remember: false,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("mobile device approval disclosure", () => {
  it("retains an opaque bounded consent proof unchanged for the decision", async () => {
    const opaqueToken = "opaque~proof with a space";
    mocks.submit.mockResolvedValueOnce({
      data: { ...DISCLOSURE, consent_token: opaqueToken },
    });

    const inspected = await inspectDevice(
      "https://api.moosewave.com",
      "ABCD-EFGH",
    );

    expect(inspected.ok).toBe(true);
    expect(inspected.consentToken).toBe(opaqueToken);
    expect(mocks.submit).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "ABCD-EFGH",
      "inspect",
      undefined,
    );
  });

  it("fails closed when a session inspect omits its consent proof", async () => {
    mocks.submit.mockResolvedValueOnce({ data: DISCLOSURE });

    const inspected = await inspectDevice(
      "https://api.moosewave.com",
      "ABCD-EFGH",
    );

    expect(inspected.ok).toBe(false);
    expect(inspected.message).toMatch(/bind this review/i);
  });

  it("requires a complete ok mutation response after echoing the same proof", async () => {
    mocks.submit.mockResolvedValueOnce({
      data: { ok: false, grant_kind: "session" },
    });

    const approved = await approveDevice(
      "https://api.moosewave.com",
      "ABCD-EFGH",
      "opaque-consent-proof",
    );

    expect(approved.ok).toBe(false);
    expect(approved.message).toMatch(/incomplete device details/i);
    expect(mocks.submit).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "ABCD-EFGH",
      "approve",
      "opaque-consent-proof",
    );
  });

  it("maps a changed consent binding to a fresh-review outcome", async () => {
    mocks.submit.mockResolvedValueOnce({
      error: {
        code: "consent_required",
        status: 400,
        kind: "http",
        message: "review again",
      },
    });

    const approved = await approveDevice(
      "https://api.moosewave.com",
      "ABCD-EFGH",
      "opaque-consent-proof",
    );

    expect(approved.ok).toBe(false);
    expect(approved.failure).toBe("review_required");
    expect(approved.message).toMatch(/review.*refreshed details/i);
  });
});
