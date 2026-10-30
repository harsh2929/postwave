import { describe, expect, it } from "vitest";

import {
  CONNECTION_COPY,
  challengeErrorMessage,
  consumeErrorMessage,
  deviceApproveErrorMessage,
  deviceApproveFailureKind,
  enrollmentErrorMessage,
  formatCountdown,
  linkRequestErrorMessage,
  magicLinkStateErrorMessage,
  passwordResetStateErrorMessage,
  signInErrorMessage,
  signUpErrorMessage,
} from "./authErrorCopy";

describe("signInErrorMessage", () => {
  it("never renders the HTTP placeholder a 401 with an empty body produces", () => {
    // handlers.go writeErr(w, 401, "invalid_credentials", "") leaves
    // authRequest's `HTTP 401` placeholder in message.
    const copy = signInErrorMessage({
      message: "HTTP 401",
      status: 401,
      code: "invalid_credentials",
      kind: "http",
    });
    expect(copy).toBe("Email or password is incorrect.");
    expect(copy).not.toMatch(/HTTP/);
  });

  it("maps a bare 401 with no code at all", () => {
    expect(signInErrorMessage({ message: "HTTP 401", status: 401 })).toBe(
      "Email or password is incorrect.",
    );
  });

  it("renders a countdown when Retry-After came back with the 429", () => {
    expect(
      signInErrorMessage({
        message: "HTTP 429",
        status: 429,
        code: "too_many_auth_attempts",
        retryAfterSeconds: 300,
      }),
    ).toBe("Too many attempts. Try again in 5m.");
  });

  it("falls back to generic rate-limit copy without a Retry-After", () => {
    expect(signInErrorMessage({ message: "HTTP 429", status: 429 })).toBe(
      "Too many attempts. Wait a few minutes, then try again.",
    );
  });

  it("replaces React Native's raw network error", () => {
    expect(
      signInErrorMessage({
        message: "Network request failed",
        kind: "network",
      }),
    ).toBe(CONNECTION_COPY);
  });

  it("treats 5xx and unparsable bodies as a server outage", () => {
    expect(signInErrorMessage({ message: "HTTP 503", status: 503 })).toMatch(
      /temporarily unavailable/,
    );
    expect(signInErrorMessage({ message: "boom", kind: "parse" })).toMatch(
      /temporarily unavailable/,
    );
  });

  it("passes through a genuinely specific server message", () => {
    expect(
      signInErrorMessage({
        message: "This workspace is suspended.",
        status: 400,
        code: "tenant_suspended",
      }),
    ).toBe("This workspace is suspended.");
  });

  it("redacts Postgres prose rather than showing it", () => {
    expect(
      signInErrorMessage({
        message: "pq: duplicate key value violates unique constraint",
        status: 400,
      }),
    ).toBe("Server error. Please try again.");
  });
});

describe("signUpErrorMessage", () => {
  it("names the taken-email case with a route out", () => {
    expect(
      signUpErrorMessage({ message: "", status: 409, code: "email_taken" }),
    ).toMatch(/already exists/);
  });

  it("keeps the server's weak-password guidance when it has any", () => {
    expect(
      signUpErrorMessage({
        message: "password must be at least 12 characters",
        status: 400,
        code: "weak_password",
      }),
    ).toBe("password must be at least 12 characters");
  });

  it("substitutes copy when weak_password arrives with an empty message", () => {
    expect(
      signUpErrorMessage({
        message: "HTTP 400",
        status: 400,
        code: "weak_password",
      }),
    ).toBe("Use a password of at least 12 characters.");
  });
});

describe("linkRequestErrorMessage", () => {
  it("prefers the countdown over the placeholder", () => {
    expect(
      linkRequestErrorMessage({
        message: "HTTP 429",
        status: 429,
        retryAfterSeconds: 90,
      }),
    ).toBe("Too many attempts. Try again in 1m 30s.");
  });
});

describe("formatCountdown", () => {
  it.each([
    [0, "0s"],
    [-5, "0s"],
    [1, "1s"],
    [59, "59s"],
    [60, "1m"],
    [61, "1m 1s"],
    [300, "5m"],
    [3599, "59m 59s"],
    [3600, "60m"],
  ])("formats %s seconds as %s", (input, expected) => {
    expect(formatCountdown(input)).toBe(expected);
  });

  it("clamps an absurd value to a day", () => {
    expect(formatCountdown(99_999_999)).toBe("1440m");
  });

  it("survives NaN", () => {
    expect(formatCountdown(Number.NaN)).toBe("0s");
  });
});

describe("challengeErrorMessage", () => {
  it("distinguishes a burnt recovery code from a stale TOTP code", () => {
    expect(
      challengeErrorMessage({ message: "", code: "invalid_code" }, true),
    ).toMatch(/only once/);
    expect(
      challengeErrorMessage({ message: "", code: "invalid_code" }, false),
    ).toMatch(/rotate every 30 seconds/);
  });

  it("maps an expired cookie", () => {
    expect(
      challengeErrorMessage({ message: "", code: "no_session" }, false),
    ).toMatch(/session expired/);
  });
});

describe("enrollmentErrorMessage", () => {
  it("routes an expired session toward switching accounts", () => {
    expect(
      enrollmentErrorMessage({ message: "HTTP 401", status: 401 }),
    ).toMatch(/Switch accounts/);
  });
});

describe("consumeErrorMessage", () => {
  it("does not leak the HTTP placeholder", () => {
    expect(consumeErrorMessage({ message: "HTTP 400", status: 400 })).toBe(
      "That sign-in link could not be used.",
    );
  });
});

describe("deviceApproveFailureKind", () => {
  it.each([
    [{ code: "mfa_required", status: 403 }, "mfa_required"],
    [{ code: "insufficient_role", status: 403 }, "insufficient_role"],
    [{ code: "no_session", status: 401 }, "session_expired"],
    [{ status: 401 }, "session_expired"],
    [{ code: "bad_user_code", status: 400 }, "bad_code"],
    [{ code: "invalid_or_expired", status: 400 }, "expired_code"],
    [{ code: "consent_required", status: 400 }, "review_required"],
    [{ kind: "network" }, "offline"],
    [{ kind: "timeout" }, "offline"],
    [{ status: 403 }, "insufficient_role"],
    [{ status: 500 }, "unknown"],
  ] as const)("classifies %o", (error, expected) => {
    expect(deviceApproveFailureKind(error)).toBe(expected);
  });

  it("gives every kind a distinct, actionable message", () => {
    const kinds = [
      "session_expired",
      "mfa_required",
      "insufficient_role",
      "bad_code",
      "expired_code",
      "review_required",
      "offline",
      "unknown",
    ] as const;
    const messages = kinds.map((kind) => deviceApproveErrorMessage(kind));
    expect(new Set(messages).size).toBe(kinds.length);
    for (const message of messages) expect(message).not.toMatch(/HTTP/);
  });
});

describe("link-state copy", () => {
  it("explains a state mismatch for both flows without echoing the reason token", () => {
    expect(magicLinkStateErrorMessage("state_mismatch")).toMatch(
      /doesn't match the request from this device/,
    );
    expect(passwordResetStateErrorMessage("state_mismatch")).toMatch(
      /does not match the request from this device/,
    );
    expect(magicLinkStateErrorMessage("something_new")).toMatch(
      /Request a new sign-in link/,
    );
  });
});
