import { describe, expect, it } from "vitest";

import {
  authLinkRecoveryCopy,
  authStateFailureToRecovery,
  classifyAuthLinkApiError,
} from "../../lib/auth-link-recovery";

describe("auth-link recovery classification", () => {
  it("keeps local request failures distinct", () => {
    expect(authStateFailureToRecovery("expired")).toBe("request_expired");
    expect(authStateFailureToRecovery("mismatch")).toBe("state_mismatch");
    expect(authStateFailureToRecovery("missing_pending")).toBe("not_requested");
    expect(authStateFailureToRecovery("missing_state")).toBe("invalid_link");
    expect(authStateFailureToRecovery("invalid_pending")).toBe("invalid_link");
  });

  it("maps typed server failures without exposing raw server messages", () => {
    expect(
      classifyAuthLinkApiError({ message: "secret", code: "token_expired" }),
    ).toBe("expired");
    expect(
      classifyAuthLinkApiError({ message: "secret", code: "token_used" }),
    ).toBe("already_used");
    expect(
      classifyAuthLinkApiError({ message: "secret", code: "invalid_token" }),
    ).toBe("expired_or_used");
    expect(
      classifyAuthLinkApiError({
        message: "secret",
        code: "wrong_workspace",
        status: 403,
      }),
    ).toBe("wrong_workspace");
    expect(
      classifyAuthLinkApiError({ message: "secret", kind: "network" }),
    ).toBe("temporary_failure");
    expect(classifyAuthLinkApiError({ message: "secret", status: 429 })).toBe(
      "rate_limited",
    );
  });

  it("provides specific, non-secret recovery copy", () => {
    expect(authLinkRecoveryCopy("unsupported_version", "magic").title).toMatch(
      /newer version/i,
    );
    expect(authLinkRecoveryCopy("wrong_device", "reset").title).toMatch(
      /another device/i,
    );
    expect(authLinkRecoveryCopy("already_used", "magic").title).toMatch(
      /already been used/i,
    );
    expect(authLinkRecoveryCopy("wrong_workspace", "magic").title).toMatch(
      /workspace/i,
    );
    expect(authLinkRecoveryCopy("temporary_failure", "reset").title).toMatch(
      /could not finish/i,
    );
  });
});
