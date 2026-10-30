import { describe, expect, it } from "vitest";

import {
  canCancelMigration,
  canReplayDlqEntry,
  canRevokeScimToken,
  governanceActionErrorMessage,
  governanceErrorInput,
  scimTokenDormancy,
} from "./governanceActionPolicy";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-25T12:00:00Z");

describe("governanceErrorInput", () => {
  it("reads status, code and message off a tagged error", () => {
    const err = Object.assign(new Error("nope"), {
      status: 409,
      code: "already_replayed",
    });
    expect(governanceErrorInput(err)).toEqual({
      status: 409,
      code: "already_replayed",
      message: "nope",
    });
  });

  it("drops an empty code rather than reporting a present-but-blank one", () => {
    const err = Object.assign(new Error("x"), { status: 500, code: "  " });
    expect(governanceErrorInput(err).code).toBeUndefined();
  });

  it("survives a non-object throw", () => {
    expect(governanceErrorInput("boom")).toEqual({ message: "boom" });
    expect(governanceErrorInput(null)).toEqual({});
  });
});

describe("governanceActionErrorMessage", () => {
  it("says nothing changed when the request never reached the server", () => {
    const msg = governanceActionErrorMessage("reset_circuit", new Error("net"));
    expect(msg).toMatch(/nothing was changed/i);
  });

  it("names the action in a permission failure", () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    expect(governanceActionErrorMessage("revoke_scim_token", err)).toBe(
      "You don't have permission to revoke that token.",
    );
    expect(governanceActionErrorMessage("cancel_migration", err)).toBe(
      "You don't have permission to cancel that job.",
    );
  });

  it("distinguishes the three 409s that mean different things", () => {
    const err = Object.assign(new Error("conflict"), { status: 409 });
    expect(governanceActionErrorMessage("replay_dlq", err)).toBe(
      "That batch was already replayed.",
    );
    expect(governanceActionErrorMessage("cancel_migration", err)).toBe(
      "That job is no longer running, so there was nothing to cancel.",
    );
    expect(governanceActionErrorMessage("revoke_scim_token", err)).toBe(
      "That token was already revoked.",
    );
  });

  it("explains a 404 on cancel as an already-finished job", () => {
    const err = Object.assign(new Error("gone"), { status: 404 });
    expect(governanceActionErrorMessage("cancel_migration", err)).toMatch(
      /already finished/i,
    );
  });

  it("falls back to the server message with its code appended", () => {
    const err = Object.assign(new Error("sink is misconfigured"), {
      status: 422,
      code: "bad_sink_config",
    });
    expect(governanceActionErrorMessage("test_sink", err)).toBe(
      "sink is misconfigured (bad_sink_config)",
    );
  });

  it("never returns an empty string", () => {
    const err = Object.assign(new Error(""), { status: 418 });
    expect(governanceActionErrorMessage("test_sink", err).length).toBeGreaterThan(
      0,
    );
  });
});

describe("canRevokeScimToken", () => {
  it("offers revoke only for a live token", () => {
    expect(canRevokeScimToken({})).toBe(true);
    expect(canRevokeScimToken({ revoked_at: "2026-07-01T00:00:00Z" })).toBe(
      false,
    );
  });
});

describe("scimTokenDormancy", () => {
  it("says nothing about a revoked token", () => {
    expect(
      scimTokenDormancy({ revoked_at: "2026-07-01T00:00:00Z" }, NOW),
    ).toBeNull();
  });

  it("flags a never-used token older than a day", () => {
    const created = new Date(NOW - 3 * DAY).toISOString();
    expect(scimTokenDormancy({ created_at: created }, NOW)).toEqual({
      label: "Never used",
      tone: "warning",
    });
  });

  it("does not flag a freshly minted token as dormant", () => {
    const created = new Date(NOW - 60_000).toISOString();
    expect(scimTokenDormancy({ created_at: created }, NOW)).toEqual({
      label: "Not used yet",
      tone: "neutral",
    });
  });

  it("escalates tone as idle time grows", () => {
    const at = (days: number) =>
      scimTokenDormancy(
        { last_used_at: new Date(NOW - days * DAY).toISOString() },
        NOW,
      );
    expect(at(5)).toBeNull();
    expect(at(31)?.tone).toBe("warning");
    expect(at(120)?.tone).toBe("danger");
    expect(at(120)?.label).toBe("Idle 120d");
  });
});

describe("canReplayDlqEntry", () => {
  it("refuses an already-replayed batch", () => {
    expect(canReplayDlqEntry({})).toBe(true);
    expect(canReplayDlqEntry({ replayed_at: "2026-07-01T00:00:00Z" })).toBe(
      false,
    );
  });
});

describe("canCancelMigration", () => {
  it("offers cancel for every in-flight status", () => {
    for (const s of [
      "pending",
      "authenticating",
      "discovering",
      "dry_run",
      "awaiting_confirmation",
      "importing",
    ]) {
      expect(canCancelMigration(s)).toBe(true);
    }
  });

  it("never offers cancel where it could only 409", () => {
    for (const s of [
      "rolling_back",
      "completed",
      "failed",
      "rolled_back",
      "",
      undefined,
    ]) {
      expect(canCancelMigration(s)).toBe(false);
    }
  });
});
