/**
 * The rules half of ECO-03 on mobile. Everything asserted here is a decision
 * the SERVER made (apps/api/internal/editorcheckpoint) that a client is free
 * to get wrong in a way nobody notices until someone loses a draft:
 *
 *   - `found:false` is a 200, not a 404;
 *   - a 409 carries the other device's checkpoint and must not be resolved
 *     for the person;
 *   - the two 409 codes mean different things;
 *   - a 4xx the draft caused is permanent, a 5xx/offline is not.
 *
 * Node environment on purpose: api/editorCheckpoint.ts imports no React and no
 * react-native, exactly like api/activityCursor.ts, so these run without a
 * simulator.
 */
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_MAX_CONTENT_BYTES,
  checkpointPath,
  createEditorCheckpointClient,
  isNewerThanRecord,
  type CheckpointRequester,
  type CheckpointResult,
} from "./editorCheckpoint";

const PATH = "/api/v1/editor/checkpoints/campaign/camp_1";

type Call = { method: string; path: string; body?: unknown };

/** A requester that answers each call from a queue of canned envelopes. */
function requesterFor(answers: CheckpointResult<unknown>[]) {
  const calls: Call[] = [];
  const request: CheckpointRequester = async <T,>(
    method: string,
    path: string,
    body?: unknown,
  ) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const next = answers.shift() ?? { data: null, error: null };
    return next as CheckpointResult<T>;
  };
  return { calls, request };
}

const ok = (data: unknown): CheckpointResult<unknown> => ({ data, error: null });
const fail = (
  error: NonNullable<CheckpointResult<unknown>["error"]>,
): CheckpointResult<unknown> => ({ data: null, error });

const CHECKPOINT = {
  entity_key: "campaign",
  entity_id: "camp_1",
  content: { subject: "Half a thought" },
  version: 3,
  updated_at: "2026-08-04T10:00:00Z",
};

describe("checkpointPath", () => {
  it("addresses the route the gateway mounts", () => {
    expect(checkpointPath("campaign", "camp_1")).toBe(PATH);
  });

  it("refuses a reference this build cannot address", () => {
    expect(checkpointPath("not-an-entity", "camp_1")).toBeNull();
    expect(checkpointPath("campaign", "../../admin")).toBeNull();
  });
});

describe("load", () => {
  it("reads `found:false` as an ordinary absence, not a failure", async () => {
    const { request, calls } = requesterFor([ok({ found: false })]);
    const client = createEditorCheckpointClient({ request });
    await expect(client.load("campaign", "camp_1")).resolves.toEqual({
      status: "absent",
    });
    expect(calls).toEqual([{ method: "GET", path: PATH }]);
  });

  it("returns the checkpoint the server holds", async () => {
    const { request } = requesterFor([
      ok({ found: true, checkpoint: CHECKPOINT }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.load<{ subject: string }>("campaign", "camp_1");
    expect(result).toEqual({ status: "found", checkpoint: CHECKPOINT });
  });

  it("reports a `found:true` it cannot read as unavailable, never as absent", async () => {
    const { request } = requesterFor([
      ok({ found: true, checkpoint: { entity_key: "campaign" } }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.load("campaign", "camp_1");
    expect(result.status).toBe("unavailable");
  });

  it("reports a transport failure as unavailable, not as 'you have no draft'", async () => {
    const { request } = requesterFor([
      fail({ status: 0, message: "Network request failed" }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.load("campaign", "camp_1");
    expect(result).toEqual({
      status: "unavailable",
      message: "Network request failed",
    });
  });

  it("reads a session-only refusal as an absence, so an API key sees no banner", async () => {
    // The route is per-person: a shared key has no single owner, and the
    // handler answers 403 `session_required` (editorcheckpoint.go identity()).
    const { request } = requesterFor([
      fail({ status: 403, code: "session_required", message: "…" }),
    ]);
    const client = createEditorCheckpointClient({ request });
    await expect(client.load("campaign", "camp_1")).resolves.toEqual({
      status: "absent",
    });
  });

  it("never puts an unaddressable reference on the wire", async () => {
    const { request, calls } = requesterFor([]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.load("campaign", "../../admin");
    expect(result.status).toBe("unavailable");
    expect(calls).toEqual([]);
  });
});

describe("save", () => {
  it("sends the draft with the version it was built on", async () => {
    const { request, calls } = requesterFor([ok({ ...CHECKPOINT, version: 4 })]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save(
      "campaign",
      "camp_1",
      { subject: "Half a thought" },
      3,
    );
    expect(calls).toEqual([
      {
        method: "PUT",
        path: PATH,
        body: { content: { subject: "Half a thought" }, version: 3 },
      },
    ]);
    expect(result).toEqual({
      status: "saved",
      checkpoint: { ...CHECKPOINT, version: 4 },
    });
  });

  it("surfaces a stale 409 WITH the newer draft and never retries it", async () => {
    const newer = { ...CHECKPOINT, version: 9, content: { subject: "Theirs" } };
    const { request, calls } = requesterFor([
      fail({
        status: 409,
        code: "stale_checkpoint",
        message: "a newer draft was saved from another device",
        payload: {
          error: {
            code: "stale_checkpoint",
            message: "a newer draft was saved from another device",
            current: newer,
          },
        },
      }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "Mine" }, 3);
    expect(result).toEqual({
      status: "stale",
      current: newer,
      message: "a newer draft was saved from another device",
    });
    // One request. Retrying at the server's version is the silent overwrite
    // the 409 exists to prevent.
    expect(calls).toHaveLength(1);
  });

  it("still reports the conflict when the server could not re-read the draft", async () => {
    const { request } = requesterFor([
      fail({
        status: 409,
        code: "stale_checkpoint",
        message: "a newer draft was saved from another device",
        payload: { error: { code: "stale_checkpoint" } },
      }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "Mine" }, 3);
    expect(result).toMatchObject({ status: "stale", current: null });
  });

  it("does not read the OTHER 409 as another device", async () => {
    const { request } = requesterFor([
      fail({
        status: 409,
        code: "too_many_checkpoints",
        message: "this account already holds the maximum number of open drafts",
      }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
    expect(result).toEqual({
      status: "refused",
      code: "too_many_checkpoints",
      message: "this account already holds the maximum number of open drafts",
    });
  });

  it("reports a server refusal the draft caused as permanent", async () => {
    const { request } = requesterFor([
      fail({
        status: 422,
        code: "unsupported_content",
        message: "a draft cannot contain a \\u0000 escape",
      }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
    expect(result.status).toBe("refused");
  });

  it("reports 5xx and rate limiting as transient, so autosave keeps trying", async () => {
    for (const status of [500, 429]) {
      const { request } = requesterFor([fail({ status, message: "later" })]);
      const client = createEditorCheckpointClient({ request });
      const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
      expect(result.status).toBe("unavailable");
    }
  });

  it("reports a session-only refusal as unsupported, not as a broken draft", async () => {
    const { request } = requesterFor([
      fail({ status: 403, code: "session_required", message: "…" }),
    ]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
    expect(result).toEqual({ status: "unsupported", code: "session_required" });
  });

  it("refuses an oversized draft without uploading it", async () => {
    const { request, calls } = requesterFor([]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save(
      "campaign",
      "camp_1",
      { subject: "x".repeat(CHECKPOINT_MAX_CONTENT_BYTES) },
      0,
    );
    expect(result).toMatchObject({ status: "refused", code: "content_too_large" });
    expect(calls).toEqual([]);
  });

  it("measures the draft in UTF-8 bytes, as the server does", async () => {
    // 85_000 four-byte characters is 340_000 bytes but only 170_000 UTF-16
    // code units — a length check would wave it through and the server would
    // refuse every debounce tick.
    const { request, calls } = requesterFor([]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save(
      "campaign",
      "camp_1",
      { subject: "\u{1F600}".repeat(85_000) },
      0,
    );
    expect(result).toMatchObject({ status: "refused", code: "content_too_large" });
    expect(calls).toEqual([]);
  });

  it("refuses a NUL escape locally, matching the server's jsonb rule", async () => {
    const { request, calls } = requesterFor([]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save(
      "campaign",
      "camp_1",
      { subject: "a\u0000b" },
      0,
    );
    expect(result).toMatchObject({
      status: "refused",
      code: "unsupported_content",
    });
    expect(calls).toEqual([]);
  });

  it("does not send a versioned write while offline", async () => {
    // A queued/replayed checkpoint carries a version the server has long since
    // moved past. Refusing at the door is what keeps it out of any retry the
    // runtime might perform for us.
    const { request, calls } = requesterFor([ok(CHECKPOINT)]);
    const client = createEditorCheckpointClient({
      request,
      isOnline: () => false,
    });
    const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
    expect(result.status).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("does not trust a 200 body it cannot read as a saved checkpoint", async () => {
    const { request } = requesterFor([ok({ version: 4 })]);
    const client = createEditorCheckpointClient({ request });
    const result = await client.save("campaign", "camp_1", { subject: "x" }, 0);
    expect(result.status).toBe("unavailable");
  });
});

describe("discard", () => {
  it("deletes the draft", async () => {
    const { request, calls } = requesterFor([ok({ discarded: true })]);
    const client = createEditorCheckpointClient({ request });
    await expect(client.discard("campaign", "camp_1")).resolves.toBe(true);
    expect(calls).toEqual([{ method: "DELETE", path: PATH }]);
  });

  it("reports a failure instead of throwing into an autosave loop", async () => {
    const { request } = requesterFor([fail({ status: 500, message: "no" })]);
    const client = createEditorCheckpointClient({ request });
    await expect(client.discard("campaign", "camp_1")).resolves.toBe(false);
  });
});

describe("isNewerThanRecord", () => {
  const at = (iso: string) => ({ updated_at: iso });

  it("is true only when the draft holds work the record does not", () => {
    expect(
      isNewerThanRecord(at("2026-08-04T10:00:00Z"), "2026-08-04T09:00:00Z"),
    ).toBe(true);
    expect(
      isNewerThanRecord(at("2026-08-04T08:00:00Z"), "2026-08-04T09:00:00Z"),
    ).toBe(false);
  });

  it("declines to offer on a guess", () => {
    expect(isNewerThanRecord(at("nonsense"), "2026-08-04T09:00:00Z")).toBe(false);
    expect(isNewerThanRecord(at("2026-08-04T10:00:00Z"), undefined)).toBe(false);
    expect(isNewerThanRecord(at("2026-08-04T10:00:00Z"), "nonsense")).toBe(false);
  });
});
