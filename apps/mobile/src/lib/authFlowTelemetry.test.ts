import { EVENTS } from "@postwave/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { track } from "./telemetry";

import {
  magicLinkAuthErrorCode,
  signInAuthErrorCode,
  magicLinkSessionErrorCode,
  mfaAuthErrorCode,
  mfaSessionErrorCode,
  trackMagicLinkHandled,
  trackMfaCompleted,
} from "./authFlowTelemetry";

vi.mock("./telemetry", () => ({ track: vi.fn() }));

describe("auth-flow telemetry privacy contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ status: 429, message: "server text" }, "rate_limited"],
    [{ status: 401, message: "server text" }, "session_expired"],
    [{ code: "invalid_code", message: "server text" }, "invalid_code"],
    [{ code: "not_enrolled", message: "server text" }, "factor_not_enrolled"],
    [{ code: "mfa_required", message: "server text" }, "policy_changed"],
    [{ kind: "network", message: "server text" }, "network"],
    [{ kind: "timeout", message: "server text" }, "timeout"],
    [{ kind: "parse", message: "server text" }, "invalid_response"],
    [{ code: "private_backend_detail", message: "server text" }, "server"],
  ] as const)("maps an MFA API error to %s", (error, expected) => {
    expect(mfaAuthErrorCode(error)).toBe(expected);
  });

  it.each([
    ["local_session_persistence_pending", "local_persistence_pending"],
    ["session_expired", "session_expired"],
    ["session_network_error", "network"],
    ["invalid_session_profile", "invalid_response"],
    ["private_backend_detail", "server"],
  ] as const)("maps a session error to %s", (code, expected) => {
    expect(mfaSessionErrorCode({ code, message: "do not capture" })).toBe(
      expected,
    );
  });

  it("maps magic-link transport errors without exposing response details", () => {
    expect(
      magicLinkAuthErrorCode(
        { kind: "network", message: "user@example.com and secret token" },
        "consume_rejected",
      ),
    ).toBe("network");
    expect(
      magicLinkAuthErrorCode(
        { code: "private_code", message: "private server message" },
        "profile_load_failed",
      ),
    ).toBe("profile_load_failed");
    expect(
      magicLinkSessionErrorCode({
        code: "prior_session_revoked",
        message: "private local detail",
      }),
    ).toBe("session_cleanup_pending");
  });

  it("emits exactly the two approved MFA properties", () => {
    trackMfaCompleted("failure", "invalid_code");

    expect(track).toHaveBeenCalledWith(EVENTS.MOBILE_MFA_COMPLETED, {
      outcome: "failure",
      error_code: "invalid_code",
    });
    expect(Object.keys(vi.mocked(track).mock.calls[0]?.[1] ?? {})).toEqual([
      "outcome",
      "error_code",
    ]);
  });

  it("emits only structural magic-link fields", () => {
    trackMagicLinkHandled("failure", "account_mismatch");

    expect(track).toHaveBeenCalledWith(EVENTS.MOBILE_LINK_HANDLED, {
      outcome: "failure",
      source: "magic_link",
      error_code: "account_mismatch",
    });
  });
});

describe("a session that never established is not a wrong password", () => {
  // Reproduced against a live API on 2026-08-18: the server accepts the
  // password (login 200) and the NEXT request 401s because the Secure session
  // cookie could not survive a plaintext hop to a routable host. Reporting
  // that as "Email or password is incorrect." sends the user to reset a
  // credential that was never wrong.
  it.each(["missing_tenant", "no_session"])(
    "classifies %s as a profile-load failure",
    (code) => {
      expect(signInAuthErrorCode({ status: 401, code, message: "" })).toBe(
        "profile_load_failed",
      );
    },
  );

  it("still calls a genuine credential rejection what it is", () => {
    expect(signInAuthErrorCode({
      status: 401,
      code: "invalid_credentials",
      message: "",
    })).toBe(
      "invalid_credentials",
    );
    // A bare 401 carrying no code keeps the old meaning on purpose: changing
    // it would reclassify real bad-password rejections.
    expect(signInAuthErrorCode({ status: 401, message: "" })).toBe("invalid_credentials");
  });
});
