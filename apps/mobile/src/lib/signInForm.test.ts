import { describe, expect, it } from "vitest";

import {
  autoSelectedWorkspace,
  credentialProblems,
  isLikelyEmail,
  magicLinkEmailProblem,
  signInSubmitState,
  usableWorkspaces,
} from "./signInForm";

describe("isLikelyEmail", () => {
  it("accepts ordinary and plus-addressed workspace mail", () => {
    for (const good of [
      "a@b.co",
      "person.name+tag@sub.example.com",
      "  padded@example.com  ",
    ]) {
      expect(isLikelyEmail(good)).toBe(true);
    }
  });

  it("rejects the typos it exists to catch", () => {
    for (const bad of [
      "",
      "no-at-sign",
      "@example.com",
      "two@@example.com",
      "user@example.",
      "user@ex",
      "user name@example.com",
      `${"a".repeat(330)}@example.com`,
    ]) {
      expect(isLikelyEmail(bad)).toBe(false);
    }
  });
});

describe("credentialProblems", () => {
  it("reports both empty fields in one pass", () => {
    expect(
      credentialProblems({ email: "", password: "", skipEmailShape: false }),
    ).toEqual({
      email: "Enter your email address",
      password: "Enter your password",
    });
  });

  it("omits a key entirely when the field is fine (exactOptionalPropertyTypes)", () => {
    const problems = credentialProblems({
      email: "a@b.co",
      password: "hunter2",
      skipEmailShape: false,
    });
    expect(problems).toEqual({});
    expect("email" in problems).toBe(false);
  });

  it("stops re-litigating an address the server already accepted", () => {
    // After needs_workspace the backend has accepted this address; a local
    // regex must not then strand the user on their own valid account.
    expect(
      credentialProblems({
        email: "odd..address@example.com",
        password: "hunter2",
        skipEmailShape: true,
      }),
    ).toEqual({});
    expect(
      credentialProblems({
        email: "not-an-email",
        password: "hunter2",
        skipEmailShape: false,
      }).email,
    ).toBe("That doesn't look like an email address");
  });
});

describe("magicLinkEmailProblem", () => {
  it("phrases the empty case as a destination, not a credential", () => {
    expect(magicLinkEmailProblem("  ")).toBe(
      "Enter the address to send the link to",
    );
    expect(magicLinkEmailProblem("nope")).toBe(
      "That doesn't look like an email address",
    );
    expect(magicLinkEmailProblem("a@b.co")).toBeUndefined();
  });
});

describe("workspace selection", () => {
  it("drops entries a picker could not act on", () => {
    expect(
      usableWorkspaces([
        { tenant_id: "t1" },
        null,
        undefined,
        { tenant_id: "" },
        { tenant_id: "t2" },
      ]),
    ).toEqual([{ tenant_id: "t1" }, { tenant_id: "t2" }]);
  });

  it("pre-selects a lone workspace and never guesses between two", () => {
    expect(autoSelectedWorkspace([{ tenant_id: "only" }])).toBe("only");
    expect(
      autoSelectedWorkspace([{ tenant_id: "a" }, { tenant_id: "b" }]),
    ).toBe("");
    expect(autoSelectedWorkspace([])).toBe("");
  });
});

describe("signInSubmitState", () => {
  const base = {
    busy: false,
    localCleanupPending: false,
    resendSeconds: 0,
    needsWorkspace: false,
    pickedWorkspace: "",
  };

  it("labels the password path, and switches to Continue at the picker", () => {
    expect(signInSubmitState({ ...base, method: "password" })).toEqual({
      label: "Sign in",
      accessibilityLabel: "Sign in",
      disabled: false,
    });
    expect(
      signInSubmitState({ ...base, method: "password", needsWorkspace: true }),
    ).toEqual({
      label: "Continue",
      accessibilityLabel: "Continue",
      disabled: true,
    });
    expect(
      signInSubmitState({
        ...base,
        method: "password",
        needsWorkspace: true,
        pickedWorkspace: "t1",
      }).disabled,
    ).toBe(false);
  });

  it("spells the countdown out for a screen reader", () => {
    expect(
      signInSubmitState({ ...base, method: "magic", resendSeconds: 43 }),
    ).toEqual({
      label: "Try again in 43s",
      accessibilityLabel: "Sign-in link available again in 43 seconds",
      disabled: true,
    });
  });

  it("blocks the tap while busy or while a secure cleanup is pending", () => {
    for (const method of ["password", "magic"] as const) {
      expect(signInSubmitState({ ...base, method, busy: true }).disabled).toBe(
        true,
      );
      expect(
        signInSubmitState({ ...base, method, localCleanupPending: true })
          .disabled,
      ).toBe(true);
    }
  });

  it("does not carry the workspace gate into the magic-link path", () => {
    // A picked workspace belongs to the password submit that produced it;
    // gating the link button on it would deadlock the passwordless user.
    expect(
      signInSubmitState({ ...base, method: "magic", needsWorkspace: true })
        .disabled,
    ).toBe(false);
  });
});
