import { describe, expect, it, vi } from "vitest";

import { submitTotpChallenge } from "./totpChallengeFlow";

/**
 * The retry in this module resends a credential the user has ALREADY TYPED —
 * possibly a one-shot recovery code. It is only safe because the server
 * validates the trust request before it consumes anything. These tests pin
 * exactly which failures are treated that way, because widening the set would
 * silently make the app burn recovery codes twice.
 */
function client(...responses: unknown[]) {
  const totpChallenge = vi.fn();
  for (const response of responses) {
    totpChallenge.mockResolvedValueOnce(response);
  }
  return { totpChallenge } as never as Parameters<
    typeof submitTotpChallenge
  >[0] & { totpChallenge: ReturnType<typeof vi.fn> };
}

const OK = { data: { mfa_satisfied: true, device_trusted: false } };

describe("submitTotpChallenge", () => {
  it("sends no trust fields when the user did not opt in", async () => {
    const api = client(OK);
    const out = await submitTotpChallenge(api, { code: "123456" }, {
      remember: false,
      days: 180,
    });
    expect(api.totpChallenge).toHaveBeenCalledTimes(1);
    expect(api.totpChallenge).toHaveBeenCalledWith({ code: "123456" });
    expect(out.trustRefused).toBe(false);
  });

  it("attaches the chosen duration on an opt-in", async () => {
    const api = client({ data: { mfa_satisfied: true, device_trusted: true } });
    const out = await submitTotpChallenge(api, { code: "123456" }, {
      remember: true,
      days: 90,
    });
    expect(api.totpChallenge).toHaveBeenCalledWith({
      code: "123456",
      trust_device: true,
      trust_days: 90,
    });
    expect(out.trustRefused).toBe(false);
    expect(out.result.data?.device_trusted).toBe(true);
  });

  it("retries WITHOUT trust when the workspace refuses it", async () => {
    // The server rejects before verifying the code, so the recovery code is
    // still unspent and resending it is correct rather than wasteful.
    const api = client(
      { error: { code: "device_trust_disabled", message: "no", status: 403 } },
      OK,
    );
    const out = await submitTotpChallenge(
      api,
      { recovery_code: "abcd-efgh" },
      { remember: true, days: 30 },
    );
    expect(api.totpChallenge).toHaveBeenCalledTimes(2);
    expect(api.totpChallenge).toHaveBeenNthCalledWith(2, {
      recovery_code: "abcd-efgh",
    });
    expect(out.trustRefused).toBe(true);
    expect(out.result.data?.mfa_satisfied).toBe(true);
  });

  it("retries on the other pre-verification trust rejections too", async () => {
    for (const code of [
      "invalid_trust_duration",
      "device_trust_policy_unavailable",
    ]) {
      const api = client({ error: { code, message: "no" } }, OK);
      const out = await submitTotpChallenge(api, { code: "123456" }, {
        remember: true,
        days: 180,
      });
      expect(api.totpChallenge).toHaveBeenCalledTimes(2);
      expect(out.trustRefused).toBe(true);
    }
  });

  it("NEVER retries a rejected code", async () => {
    // invalid_code means the credential really was consumed. Resending a
    // recovery code here would burn a second one for nothing.
    for (const code of ["invalid_code", "no_session", "not_enrolled"]) {
      const api = client({ error: { code, message: "no", status: 401 } });
      const out = await submitTotpChallenge(
        api,
        { recovery_code: "abcd-efgh" },
        { remember: true, days: 30 },
      );
      expect(api.totpChallenge).toHaveBeenCalledTimes(1);
      expect(out.trustRefused).toBe(false);
      expect(out.result.error?.code).toBe(code);
    }
  });

  it("does not retry a network failure with no error code", async () => {
    const api = client({ error: { message: "offline", kind: "network" } });
    const out = await submitTotpChallenge(api, { code: "123456" }, {
      remember: true,
      days: 30,
    });
    expect(api.totpChallenge).toHaveBeenCalledTimes(1);
    expect(out.trustRefused).toBe(false);
  });
});
