// SPDX-License-Identifier: AGPL-3.0-only
//
// The durable-draft checkpoint client (lib/editor-checkpoint-api).
//
// apps/api/internal/editorcheckpoint has been mounted and DB-tested with no
// caller anywhere, so every one of its careful answers had never been read by
// anything. These pin the three that a naive client gets wrong, each of which
// costs a person work:
//
//   * "no draft" is 200 `{found:false}`, not 404 — read it as an error and the
//     ordinary clean open reports a failure;
//   * a stale save is 409 CARRYING the newer draft — swallow it, or retry at
//     the server's version, and the other device's work is gone with no trace;
//   * 409 means TWO things. `too_many_checkpoints` is the account's draft cap,
//     not another device, and telling someone at the cap that a second device
//     saved newer work is simply false.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { get, put, del, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly code: string;
    constructor(
      message: string,
      public readonly status: number,
      public readonly body?: unknown,
      code?: string,
    ) {
      super(message);
      this.name = "ApiError";
      this.code = code ?? `http_${status}`;
    }
  }
  return {
    get: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    MockApiError,
  };
});

vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    delete: (...args: unknown[]) => del(...args),
  },
  ApiError: MockApiError,
  isApiError: (err: unknown) => err instanceof MockApiError,
}));

import {
  CHECKPOINT_MAX_CONTENT_BYTES,
  discardCheckpoint,
  isNewerThanRecord,
  loadCheckpoint,
  saveCheckpoint,
} from "@/lib/editor-checkpoint-api";

const PATH = "/api/v1/editor/checkpoints/campaign/cmp_123";

function serverCheckpoint(over: Record<string, unknown> = {}) {
  return {
    entity_key: "campaign",
    entity_id: "cmp_123",
    content: { subject: "half written" },
    version: 3,
    updated_at: "2026-08-04T10:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  del.mockReset();
});

describe("loadCheckpoint", () => {
  it("reads `found:false` as an ordinary absence, not a failure", async () => {
    get.mockResolvedValue({ found: false });
    const result = await loadCheckpoint("campaign", "cmp_123");
    expect(get).toHaveBeenCalledWith(PATH);
    expect(result).toEqual({ status: "absent" });
  });

  it("returns the checkpoint the server holds", async () => {
    get.mockResolvedValue({ found: true, checkpoint: serverCheckpoint() });
    const result = await loadCheckpoint<{ subject: string }>(
      "campaign",
      "cmp_123",
    );
    expect(result).toEqual({
      status: "found",
      checkpoint: {
        entity_key: "campaign",
        entity_id: "cmp_123",
        content: { subject: "half written" },
        version: 3,
        updated_at: "2026-08-04T10:00:00Z",
      },
    });
  });

  it("reports a `found:true` it cannot read as unavailable, never as absent", async () => {
    // "You have no draft" and "we could not tell" are different facts, and only
    // one of them is safe to act on.
    get.mockResolvedValue({ found: true, checkpoint: { entity_key: "campaign" } });
    const result = await loadCheckpoint("campaign", "cmp_123");
    expect(result.status).toBe("unavailable");
  });

  it("reports a transport failure as unavailable", async () => {
    get.mockRejectedValue(new MockApiError("You appear to be offline", 0));
    const result = await loadCheckpoint("campaign", "cmp_123");
    expect(result.status).toBe("unavailable");
  });

  it("never puts an unaddressable reference on the wire", async () => {
    expect((await loadCheckpoint("not-an-entity", "cmp_123")).status).toBe(
      "unavailable",
    );
    expect((await loadCheckpoint("campaign", "../escape")).status).toBe(
      "unavailable",
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("saveCheckpoint", () => {
  it("sends the draft with the version it was built on", async () => {
    put.mockResolvedValue(serverCheckpoint({ version: 4 }));
    const result = await saveCheckpoint(
      "campaign",
      "cmp_123",
      { subject: "half written" },
      3,
    );
    expect(put).toHaveBeenCalledWith(
      PATH,
      { content: { subject: "half written" }, version: 3 },
      { requireOnline: true },
    );
    expect(result).toEqual({
      status: "saved",
      checkpoint: serverCheckpoint({ version: 4 }),
    });
  });

  it("surfaces a stale 409 WITH the newer draft and never retries it", async () => {
    // The whole point of the refusal: the client can show both. A client that
    // re-sent at `current.version` here would destroy the other device's work.
    put.mockRejectedValue(
      new MockApiError(
        "a newer draft was saved from another device",
        409,
        {
          error: {
            code: "stale_checkpoint",
            message: "a newer draft was saved from another device",
            current: serverCheckpoint({
              version: 7,
              content: { subject: "from the phone" },
            }),
          },
        },
        "stale_checkpoint",
      ),
    );

    const result = await saveCheckpoint(
      "campaign",
      "cmp_123",
      { subject: "stale laptop buffer" },
      3,
    );

    expect(result.status).toBe("stale");
    if (result.status !== "stale") throw new Error("unreachable");
    expect(result.current?.version).toBe(7);
    expect(result.current?.content).toEqual({ subject: "from the phone" });
    expect(result.message).toBe("a newer draft was saved from another device");
    expect(put, "the client retried a refused save").toHaveBeenCalledTimes(1);
  });

  it("still reports the conflict when the server could not re-read the draft", async () => {
    put.mockRejectedValue(
      new MockApiError(
        "a newer draft was saved from another device",
        409,
        { error: { code: "stale_checkpoint" } },
        "stale_checkpoint",
      ),
    );
    const result = await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 3);
    expect(result).toMatchObject({ status: "stale", current: null });
  });

  it("does not read the OTHER 409 as another device", async () => {
    // `too_many_checkpoints` is this account at the 200-draft cap. Reporting it
    // as a second device would send someone hunting for a device that is not
    // there, and would offer them a merge with nothing to merge.
    put.mockRejectedValue(
      new MockApiError(
        "this account already holds the maximum number of open drafts; discard one before starting another",
        409,
        { error: { code: "too_many_checkpoints" } },
        "too_many_checkpoints",
      ),
    );
    const result = await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 3);
    expect(result).toMatchObject({
      status: "refused",
      code: "too_many_checkpoints",
    });
  });

  it("reports a server refusal the draft caused as permanent", async () => {
    put.mockRejectedValue(
      new MockApiError(
        "a draft checkpoint is limited to 256 KiB",
        413,
        { error: { code: "content_too_large" } },
        "content_too_large",
      ),
    );
    const result = await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 3);
    expect(result).toMatchObject({ status: "refused", code: "content_too_large" });
  });

  it("reports 5xx and rate limiting as transient, so autosave keeps trying", async () => {
    put.mockRejectedValueOnce(new MockApiError("an internal error occurred", 500));
    expect((await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 3)).status).toBe(
      "unavailable",
    );
    put.mockRejectedValueOnce(new MockApiError("Too many requests", 429));
    expect((await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 3)).status).toBe(
      "unavailable",
    );
  });

  it("refuses an oversized draft without uploading it", async () => {
    // Autosave is a LOOP. Without this, a draft past the cap re-uploads every
    // debounce tick to be refused every time.
    const huge = { body_html: "x".repeat(CHECKPOINT_MAX_CONTENT_BYTES + 1) };
    const result = await saveCheckpoint("campaign", "cmp_123", huge, 0);
    expect(result).toMatchObject({ status: "refused", code: "content_too_large" });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a NUL escape locally, matching the server's jsonb rule", async () => {
    const result = await saveCheckpoint(
      "campaign",
      "cmp_123",
      { subject: `a${String.fromCharCode(0)}b` },
      0,
    );
    expect(result).toMatchObject({
      status: "refused",
      code: "unsupported_content",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a reference this build cannot address", async () => {
    const result = await saveCheckpoint("not-an-entity", "cmp_123", { a: 1 }, 0);
    expect(result).toMatchObject({ status: "refused", code: "invalid_entity" });
    expect(put).not.toHaveBeenCalled();
  });

  it("does not trust a 200 body it cannot read as a saved checkpoint", async () => {
    put.mockResolvedValue({ ok: true });
    const result = await saveCheckpoint("campaign", "cmp_123", { a: 1 }, 0);
    expect(result.status).toBe("unavailable");
  });
});

describe("discardCheckpoint", () => {
  it("deletes the draft", async () => {
    del.mockResolvedValue({ discarded: true });
    expect(await discardCheckpoint("campaign", "cmp_123")).toBe(true);
    expect(del).toHaveBeenCalledWith(PATH);
  });

  it("reports a failure instead of throwing into an autosave loop", async () => {
    del.mockRejectedValue(new MockApiError("boom", 500));
    expect(await discardCheckpoint("campaign", "cmp_123")).toBe(false);
  });
});

describe("isNewerThanRecord", () => {
  const draft = { updated_at: "2026-08-04T10:00:00Z" };

  it("is true only when the draft holds work the record does not", () => {
    expect(isNewerThanRecord(draft, "2026-08-04T09:59:00Z")).toBe(true);
    expect(isNewerThanRecord(draft, "2026-08-04T10:00:00Z")).toBe(false);
    expect(isNewerThanRecord(draft, "2026-08-04T10:01:00Z")).toBe(false);
  });

  it("declines to offer on a guess", () => {
    expect(isNewerThanRecord(draft, undefined)).toBe(false);
    expect(isNewerThanRecord(draft, "not a date")).toBe(false);
    expect(isNewerThanRecord({ updated_at: "" }, "2026-08-04T09:00:00Z")).toBe(
      false,
    );
  });
});
