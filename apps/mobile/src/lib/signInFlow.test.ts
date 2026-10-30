/**
 * The ORDER of sign-in's refusals, pinned.
 *
 * Every case here is a pair of simultaneous problems where only one verdict
 * may win. Those are the ones a refactor silently reorders, and each wrong
 * winner is a real user harm: a wasted rate-limit attempt, a "you're offline"
 * shown to someone with an empty form, or a self-hosted URL typo reported as
 * a connection failure.
 */
import { describe, expect, it } from "vitest";

import {
  magicLinkPreflight,
  passwordPreflight,
  PENDING_CLEANUP_SUFFIX,
  PICK_WORKSPACE_MESSAGE,
  SIGN_IN_FIELD_ORDER,
  UNUSABLE_WORKSPACES_MESSAGE,
  withCleanupSuffix,
  workspaceStep,
} from "./signInFlow";

const GOOD = {
  email: "owner@example.test",
  password: "CorrectHorseBattery1!",
  online: true,
  baseUrl: "https://api.moosewave.com",
  needsWorkspace: false,
  pickedWorkspace: "",
};

describe("passwordPreflight", () => {
  it("clears a well-formed submit to the network with a normalised base URL", () => {
    expect(passwordPreflight({ ...GOOD, baseUrl: "https://api.moosewave.com/" }))
      .toEqual({ kind: "ready", baseUrl: "https://api.moosewave.com" });
  });

  it("reports BOTH empty credential fields at once, not one per round trip", () => {
    const verdict = passwordPreflight({ ...GOOD, email: "", password: "" });
    expect(verdict).toEqual({
      kind: "fields",
      problems: {
        email: "Enter your email address",
        password: "Enter your password",
      },
    });
  });

  it("refuses locally before spending a rate-limited attempt, even offline", () => {
    // Both are true. The field problem has to win: telling a user with an
    // empty form to reconnect blames them for the wrong thing, and the
    // offline branch is the one that emits failure telemetry.
    const verdict = passwordPreflight({ ...GOOD, password: "", online: false });
    expect(verdict.kind).toBe("fields");
  });

  it("refuses locally before complaining about the server address", () => {
    // The base-URL field is COLLAPSED by default. Reporting it while a
    // visible field is also wrong sends the user hunting for a control that
    // is not on screen.
    const verdict = passwordPreflight({
      ...GOOD,
      email: "nope",
      baseUrl: "ftp://example.com",
    });
    expect(verdict).toEqual({
      kind: "fields",
      problems: { email: "That doesn't look like an email address" },
    });
  });

  it("names the workspace step ahead of connectivity once the server has accepted the password", () => {
    // needs_workspace means the credentials already passed. A user who
    // dropped offline between the two submits should be told which step they
    // are on, not sent back to the start.
    const verdict = passwordPreflight({
      ...GOOD,
      needsWorkspace: true,
      pickedWorkspace: "",
      online: false,
    });
    expect(verdict).toEqual({ kind: "form", message: PICK_WORKSPACE_MESSAGE });
  });

  it("stops re-checking the address shape once the server has accepted it", () => {
    // A valid account whose address our regex dislikes must not be stranded
    // on the second half of its own sign-in.
    const verdict = passwordPreflight({
      ...GOOD,
      email: "operator@localhost",
      needsWorkspace: true,
      pickedWorkspace: "11111111-1111-4111-8111-111111111111",
    });
    expect(verdict.kind).toBe("ready");
  });

  it("guards connectivity before opening a connection it cannot make", () => {
    expect(passwordPreflight({ ...GOOD, online: false })).toEqual({
      kind: "offline",
    });
  });

  it("reports an unusable server address as its own kind so the field can be revealed", () => {
    const verdict = passwordPreflight({ ...GOOD, baseUrl: "not a url" });
    expect(verdict.kind).toBe("baseUrl");
    expect(verdict.kind === "baseUrl" && verdict.message).toMatch(/API URL/);
  });

  it("refuses a base URL carrying credentials rather than sending a password to it", () => {
    const verdict = passwordPreflight({
      ...GOOD,
      baseUrl: "https://user:pass@api.example.com",
    });
    expect(verdict).toEqual({
      kind: "baseUrl",
      message: "API URL must not include credentials.",
    });
  });
});

describe("magicLinkPreflight", () => {
  it("phrases the empty field as a destination, not as a credential", () => {
    expect(magicLinkPreflight({ email: "  ", online: true, baseUrl: GOOD.baseUrl }))
      .toEqual({
        kind: "fields",
        problems: { email: "Enter the address to send the link to" },
      });
  });

  it("never asks the password field for anything", () => {
    const verdict = magicLinkPreflight({
      email: "nope",
      online: true,
      baseUrl: GOOD.baseUrl,
    });
    expect(verdict.kind).toBe("fields");
    expect(verdict.kind === "fields" && "password" in verdict.problems).toBe(
      false,
    );
  });

  it("checks the address before the connection", () => {
    const verdict = magicLinkPreflight({
      email: "",
      online: false,
      baseUrl: GOOD.baseUrl,
    });
    expect(verdict.kind).toBe("fields");
  });

  it("clears a good address to the link request", () => {
    expect(
      magicLinkPreflight({
        email: " owner@example.test ",
        online: true,
        baseUrl: "https://api.moosewave.com",
      }),
    ).toEqual({ kind: "ready", baseUrl: "https://api.moosewave.com" });
  });
});

describe("workspaceStep", () => {
  it("pre-selects the only workspace, because one choice is not a choice", () => {
    expect(workspaceStep([{ tenant_id: "t1" }])).toEqual({
      kind: "pick",
      workspaces: [{ tenant_id: "t1" }],
      selected: "t1",
    });
  });

  it("selects nothing when there is a real decision to make", () => {
    const step = workspaceStep([{ tenant_id: "t1" }, { tenant_id: "t2" }]);
    expect(step).toEqual({
      kind: "pick",
      workspaces: [{ tenant_id: "t1" }, { tenant_id: "t2" }],
      selected: "",
    });
  });

  it("drops entries a picker could not act on", () => {
    const step = workspaceStep([null, { tenant_id: "" }, { tenant_id: "t2" }]);
    expect(step).toEqual({
      kind: "pick",
      workspaces: [{ tenant_id: "t2" }],
      selected: "t2",
    });
  });

  it("turns an all-unusable payload into a message instead of a dead end", () => {
    // The alternative is an empty radio list behind a permanently disabled
    // Continue button, with nothing on screen saying why.
    expect(workspaceStep([null, undefined, { tenant_id: undefined }])).toEqual({
      kind: "form",
      message: UNUSABLE_WORKSPACES_MESSAGE,
    });
  });
});

describe("withCleanupSuffix", () => {
  it("leaves the message alone when the pending nonce was cleared", () => {
    expect(withCleanupSuffix("Couldn't send the link.", true)).toBe(
      "Couldn't send the link.",
    );
  });

  it("tells the user to unlock the device when SecureStore refused", () => {
    expect(withCleanupSuffix("Couldn't send the link.", false)).toBe(
      `Couldn't send the link.${PENDING_CLEANUP_SUFFIX}`,
    );
  });
});

describe("SIGN_IN_FIELD_ORDER", () => {
  it("matches the visual order the screen renders", () => {
    // firstInvalidField walks this array; a mismatch focuses the wrong
    // control and speaks the wrong message.
    expect(SIGN_IN_FIELD_ORDER).toEqual(["email", "password"]);
  });
});
