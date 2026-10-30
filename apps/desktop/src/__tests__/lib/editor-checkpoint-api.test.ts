// Tests for the desktop half of the per-user durable draft checkpoint
// (GET/PUT/DELETE /api/v1/editor/checkpoints/{entity_key}/{entity_id},
// apps/api/internal/editorcheckpoint).
//
// ECO-03's completion clause is explicitly cross-device: "close one client
// during a supported task, open another, see the exact authoritative
// checkpoint". apps/web shipped a client; desktop had none, so the SECOND
// device — the one the clause is entirely about — always arrived empty.
//
// The behaviours pinned here are the ones the server contract makes
// load-bearing, and each of them is a way a naive client destroys work:
//
//   * `found:false` is a 200, not a 404, and must not read as a failure;
//   * a stale save is a 409 CARRYING the current checkpoint, so both drafts
//     can be shown and neither is silently chosen;
//   * the two 409s are told apart by CODE, because `too_many_checkpoints` is
//     not "another device saved newer work";
//   * a 4xx the draft caused is permanent and a 5xx/offline is transient, and
//     an autosave loop must treat them differently.
//
// Plus one thing web cannot express: these routes are session-only and desktop
// also runs on API-key auth.

import { describe, expect, it, vi } from "vitest";

import {
  CHECKPOINT_MAX_CONTENT_BYTES,
  type CheckpointRequester,
  checkpointPath,
  createEditorCheckpointClient,
  isNewerThanRecord,
} from "../../lib/editor-checkpoint-api";

const CHECKPOINT = {
  entity_key: "campaign",
  entity_id: "cam_1",
  content: { subject: "Half a thought" },
  version: 3,
  updated_at: "2026-08-04T10:00:00Z",
};

/** Minimal stand-in for the desktop `apiRequest` result union. */
function ok<T>(data: T) {
  return vi.fn().mockResolvedValue({ data });
}
function fail(error: {
  status?: number;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}) {
  return vi.fn().mockResolvedValue({ error });
}
function client(request: ReturnType<typeof vi.fn>) {
  // The requester is generic in its response type; a vi.fn() stub cannot be,
  // so the seam is narrowed here rather than loosened in the production type.
  return createEditorCheckpointClient({
    request: request as unknown as CheckpointRequester,
  });
}

describe("checkpointPath", () => {
  it("addresses the route with the route-map entity vocabulary", () => {
    expect(checkpointPath("campaign", "cam_1")).toBe(
      "/api/v1/editor/checkpoints/campaign/cam_1",
    );
  });

  it("refuses a reference route-map would reject", () => {
    // Same predicate that mints links (lib/activity-cursor), so a bad id is
    // dropped here instead of round-tripping to the server's 400.
    expect(checkpointPath("sombrero", "cam_1")).toBeNull();
    expect(checkpointPath("campaign", "has/slash")).toBeNull();
    expect(checkpointPath("campaign", "")).toBeNull();
  });
});

describe("load", () => {
  it("reads a stored checkpoint", async () => {
    const request = ok({ found: true, checkpoint: CHECKPOINT });
    await expect(client(request).load("campaign", "cam_1")).resolves.toEqual({
      status: "found",
      checkpoint: CHECKPOINT,
    });
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/v1/editor/checkpoints/campaign/cam_1");
    expect(init.method).toBe("GET");
  });

  it("treats `found:false` as ABSENCE, never as an error", async () => {
    // The ordinary answer on every clean open. A client that renders this as a
    // failure puts an error on the happy path, which is how real errors stop
    // being noticed.
    await expect(
      client(ok({ found: false })).load("campaign", "cam_1"),
    ).resolves.toEqual({ status: "absent" });
  });

  it("does not confuse 'no draft' with 'could not tell'", async () => {
    // A 5xx must NOT collapse into `absent`: rendering "you have no draft"
    // when the truth is "we could not read it" is how a person overwrites work
    // they still had.
    const result = await client(fail({ status: 503, message: "down" })).load(
      "campaign",
      "cam_1",
    );
    expect(result.status).toBe("unavailable");
  });

  it("refuses to half-read a malformed checkpoint", async () => {
    // Half a checkpoint restored into an editor is worse than none, because
    // the person cannot tell which half is theirs.
    for (const broken of [
      { ...CHECKPOINT, version: "3" },
      { ...CHECKPOINT, updated_at: "" },
      { ...CHECKPOINT, entity_id: "" },
      { entity_key: "campaign", entity_id: "cam_1", version: 1, updated_at: "x" },
    ]) {
      const result = await client(
        ok({ found: true, checkpoint: broken }),
      ).load("campaign", "cam_1");
      expect(result.status).toBe("unavailable");
    }
  });

  it("reports a session-only route reached without a session as UNSUPPORTED", async () => {
    // routeauth manifest: auth_methods ["session"]. Desktop also runs on API
    // keys, where every checkpoint call is 403. Calling that a `refused` draft
    // would tell the person their work broke a rule; nothing about the draft
    // is wrong and no edit to it will help.
    for (const error of [
      { status: 403, code: "session_required" },
      { status: 403, code: "insufficient_auth_method" },
      { status: 401, code: "unauthorized" },
      { status: 0, code: "identity_transition" },
    ]) {
      const result = await client(fail(error)).load("campaign", "cam_1");
      expect(result.status).toBe("unsupported");
    }
  });

  it("survives a transport that throws instead of resolving", async () => {
    const request = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await client(request).load("campaign", "cam_1");
    expect(result.status).toBe("unavailable");
  });
});

describe("save", () => {
  it("PUTs the draft with the version it was built on", async () => {
    const request = ok({ ...CHECKPOINT, version: 4 });
    const result = await client(request).save(
      "campaign",
      "cam_1",
      { subject: "Newer" },
      3,
    );
    expect(result).toEqual({
      status: "saved",
      checkpoint: { ...CHECKPOINT, version: 4 },
    });
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/v1/editor/checkpoints/campaign/cam_1");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      content: { subject: "Newer" },
      version: 3,
    });
  });

  it("surfaces a stale 409 WITH the other device's checkpoint", async () => {
    // The entire point of the refusal is that the client can show BOTH drafts.
    // `current` arrives in `details` because @postwave/errors lifts every
    // non-framing key of the nested `error` object there.
    const request = fail({
      status: 409,
      code: "stale_checkpoint",
      message: "a newer draft was saved from another device",
      details: { current: { ...CHECKPOINT, version: 9 } },
    });
    const result = await client(request).save("campaign", "cam_1", {}, 3);
    expect(result).toEqual({
      status: "stale",
      current: { ...CHECKPOINT, version: 9 },
      message: "a newer draft was saved from another device",
    });
  });

  it("still reports the conflict when the server could not re-read its row", async () => {
    // The 409 body omits `current` when the follow-up Load failed. The
    // conflict is real and must be shown; neither resolution is offerable,
    // because both need the other version and we do not have it.
    const result = await client(
      fail({ status: 409, code: "stale_checkpoint", message: "conflict" }),
    ).save("campaign", "cam_1", {}, 3);
    expect(result).toEqual({
      status: "stale",
      current: null,
      message: "conflict",
    });
  });

  it("does not call the row cap a stale checkpoint", async () => {
    // Both are 409. Keying on the STATUS would tell someone holding 200 open
    // drafts that another device saved newer work, which is simply false.
    const result = await client(
      fail({
        status: 409,
        code: "too_many_checkpoints",
        message: "this account already holds the maximum number of open drafts",
      }),
    ).save("campaign", "cam_1", {}, 3);
    expect(result).toEqual({
      status: "refused",
      code: "too_many_checkpoints",
      message: "this account already holds the maximum number of open drafts",
    });
  });

  it("separates a permanent draft refusal from a transient outage", async () => {
    // An autosave LOOP must react differently: retrying a 422 every two
    // seconds is pure noise, and giving up on a 503 loses the next chance.
    const permanent = await client(
      fail({ status: 422, code: "unsupported_content", message: "nope" }),
    ).save("campaign", "cam_1", {}, 0);
    expect(permanent.status).toBe("refused");

    for (const status of [429, 408, 500, 503]) {
      const transient = await client(fail({ status, message: "later" })).save(
        "campaign",
        "cam_1",
        {},
        0,
      );
      expect(transient.status).toBe("unavailable");
    }
  });

  it("refuses an over-large draft without spending a request", async () => {
    // Autosave is a loop: without this a 300 KiB draft re-uploads on every
    // debounce tick to be refused every time.
    const request = ok(CHECKPOINT);
    const huge = { body: "x".repeat(CHECKPOINT_MAX_CONTENT_BYTES + 1) };
    const result = await client(request).save("campaign", "cam_1", huge, 0);
    expect(result).toEqual({
      status: "refused",
      code: "content_too_large",
      message: "A draft checkpoint is limited to 256 KiB.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a NUL escape locally, mirroring the server's jsonb rule", async () => {
    const request = ok(CHECKPOINT);
    const result = await client(request).save(
      "campaign",
      "cam_1",
      // A NUL is valid JSON and is NOT valid in a Postgres jsonb string, so
      // the server answers 422 rather than silently stripping it (which would
      // hand back a draft that differs from what was typed).
      { body: `a${String.fromCharCode(0)}b` },
      0,
    );
    expect(result).toEqual({
      status: "refused",
      code: "unsupported_content",
      message: "A draft cannot contain a \\u0000 escape.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("never sends a reference route-map would reject", async () => {
    const request = ok(CHECKPOINT);
    const result = await client(request).save("flavour", "cam_1", {}, 0);
    expect(result).toEqual({
      status: "refused",
      code: "invalid_entity",
      message: "This item cannot hold a draft checkpoint.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a session-only refusal as UNSUPPORTED, not as a bad draft", async () => {
    const result = await client(
      fail({ status: 403, code: "session_required", message: "session" }),
    ).save("campaign", "cam_1", {}, 0);
    expect(result.status).toBe("unsupported");
  });
});

describe("discard", () => {
  it("DELETEs and reports the server's confirmation", async () => {
    const request = ok({ discarded: true });
    await expect(client(request).discard("campaign", "cam_1")).resolves.toBe(
      true,
    );
    expect(request.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("reports a failed delete as unconfirmed rather than resolving true", async () => {
    // Desktop's transport RESOLVES with `{error}`. Reading only the absence of
    // a throw — the shape web's client can rely on — would call every failed
    // delete a success and leave the next open offering a dead draft.
    await expect(
      client(fail({ status: 500 })).discard("campaign", "cam_1"),
    ).resolves.toBe(false);
  });
});

describe("isNewerThanRecord", () => {
  it("only offers a draft that postdates the saved record", () => {
    expect(
      isNewerThanRecord({ updated_at: "2026-08-04T10:00:00Z" }, "2026-08-04T09:00:00Z"),
    ).toBe(true);
    expect(
      isNewerThanRecord({ updated_at: "2026-08-04T08:00:00Z" }, "2026-08-04T09:00:00Z"),
    ).toBe(false);
  });

  it("declines to guess when either timestamp is unreadable", () => {
    // A resume prompt shown on a guess is worse than none: it invites someone
    // to overwrite the saved version with a draft that may predate it.
    expect(isNewerThanRecord({ updated_at: "nonsense" }, "2026-08-04T09:00:00Z")).toBe(
      false,
    );
    expect(isNewerThanRecord({ updated_at: "2026-08-04T10:00:00Z" }, undefined)).toBe(
      false,
    );
    expect(
      isNewerThanRecord({ updated_at: "2026-08-04T10:00:00Z" }, "nonsense"),
    ).toBe(false);
  });
});
