/**
 * EVERY asset write is an optimistic-concurrency write, and mobile was sending
 * the gate on NONE of them.
 *
 * Read off apps/api/internal/assets, not off a manifest:
 *
 *   POST   /api/v1/assets                 `expectedVersion == nil || != 0` → 428
 *                                         (handlers.go, "expected_version must
 *                                         be 0 for an asset create")
 *   DELETE /api/v1/assets/{id}            `?force` present at all → 400
 *                                         `unsafe_force_transport`; body
 *                                         `expected_version <= 0` → 428
 *   PATCH  /api/v1/assets/{id}/folder     positive → else 428 (folders.go)
 *   POST   /api/v1/assets/folders         must be 0 → else 428 (folders.go)
 *   PATCH  /api/v1/assets/folders/{id}    positive → else 428 (folders.go)
 *   DELETE /api/v1/assets/folders/{id}    positive, read from the BODY
 *                                         (readExpectedVersionBody)
 *   POST   /api/v1/assets/{id}/tags       positive → else 428 (tags.go)
 *   DELETE /api/v1/assets/{id}/tags/{tag} positive, from the BODY (tags.go)
 *
 * A mismatch is 412 `stale_version`. Every one of these failed 100% of the time
 * from this app: an entire feature that looked implemented and could not once
 * have worked.
 *
 * This file lives beside — not inside — src/api/assets.test.ts, which is owned
 * by another session and still pins the PRE-version bodies for the calls that
 * type `expectedVersion` optional. Nothing in the app reaches those shapes: the
 * hooks require the number and the screens withhold the affordance without one.
 *
 * WHAT WOULD MAKE THESE ASSERTIONS WORTHLESS: asserting the body the code
 * happens to build. Each expectation below is the LITERAL object the Go handler
 * decodes, written out by hand from the struct tags, so deleting
 * `expected_version` from any request body fails a named test here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      data: unknown;
      error: { message: string; status?: number; code?: string } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      const err = new Error(result.error.message) as Error & {
        status?: number | undefined;
        code?: string | undefined;
      };
      err.status = result.error.status;
      if (result.error.code) err.code = result.error.code;
      throw err;
    }
    return result;
  },
}));

import {
  addAssetTagVersioned,
  removeAssetTagVersioned,
} from "./assetTagWrites";
import {
  createAssetFolder,
  deleteAsset,
  deleteAssetFolder,
  moveAssetToFolder,
  renameAssetFolder,
  uploadAsset,
} from "./assets";

/** The bare `{ok:true,id,version}` most of these writes answer with. */
function ok(version: number) {
  return { data: { ok: true, id: "a1", version }, error: null };
}

beforeEach(() => {
  rawRequest.mockReset();
});

describe("POST /api/v1/assets — the create's version is the constant 0", () => {
  it("sends expected_version: 0 beside the file", async () => {
    rawRequest.mockResolvedValue({ data: { id: "a1", version: 1 }, error: null });
    await uploadAsset({ filename: "hero.png", mime: "image/png", contentBase64: "AAA" });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/assets", {
      filename: "hero.png",
      mime: "image/png",
      content_base64: "AAA",
      expected_version: 0,
    });
  });

  it("sends it unconditionally — a create has no caller decision to get wrong", async () => {
    // There is no prior row to have read a version from, so this must not be
    // reachable-but-omitted the way the threaded calls are: 0 or a 428.
    rawRequest.mockResolvedValue({ data: { id: "a1" }, error: null });
    await uploadAsset({ filename: "x.png", mime: "image/png", contentBase64: "" });
    const body = rawRequest.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(body["expected_version"]).toBe(0);
  });
});

describe("DELETE /api/v1/assets/{id} — version AND force, both in the body", () => {
  it("puts expected_version and force in the body and nothing in the query", async () => {
    rawRequest.mockResolvedValue(ok(6));
    await deleteAsset("a1", 5, false);
    expect(rawRequest).toHaveBeenCalledWith("DELETE", "/api/v1/assets/a1", {
      expected_version: 5,
      force: false,
    });
  });

  it("never sends ?force=true, which is a 400 in its own right", async () => {
    // `r.URL.Query().Has("force")` answers `unsafe_force_transport` whatever
    // the value, so a forced delete from this app 400'd and an ordinary one
    // 428'd. Assert the PATH, not just the body.
    rawRequest.mockResolvedValue(ok(6));
    await deleteAsset("a1", 5, true);
    const [, path, body] = rawRequest.mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/assets/a1");
    expect(String(path)).not.toContain("force");
    expect(body).toEqual({ expected_version: 5, force: true });
  });

  it("percent-encodes the id it was given rather than interpolating it raw", async () => {
    rawRequest.mockResolvedValue(ok(2));
    await deleteAsset("a 1", 1, false);
    expect(rawRequest).toHaveBeenCalledWith("DELETE", "/api/v1/assets/a%201", {
      expected_version: 1,
      force: false,
    });
  });
});

describe("PATCH /api/v1/assets/{id}/folder — gated on the ASSET's version", () => {
  it("sends folder_id with expected_version", async () => {
    rawRequest.mockResolvedValue(ok(9));
    await moveAssetToFolder("a1", "f1", 8);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/a1/folder",
      { folder_id: "f1", expected_version: 8 },
    );
  });

  it("still sends the version when filing back to Uncategorised", async () => {
    rawRequest.mockResolvedValue(ok(10));
    await moveAssetToFolder("a1", null, 9);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/a1/folder",
      { folder_id: null, expected_version: 9 },
    );
  });

  it("returns the row's NEW version, because the move bumped it", async () => {
    // `MoveAssetToFolder` bumps `assets.version`; a tag added straight after
    // with the pre-move number would be a 412 blamed on a teammate.
    rawRequest.mockResolvedValue(ok(9));
    await expect(moveAssetToFolder("a1", "f1", 8)).resolves.toBe(9);
  });

  it("reports null rather than a guess when the answer carried no version", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(moveAssetToFolder("a1", "f1", 8)).resolves.toBeNull();
  });
});

describe("the folder writes — gated on the FOLDER's version", () => {
  it("creates with expected_version: 0", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "f1", name: "Launches", assetCount: 0, version: 1 },
      error: null,
    });
    await createAssetFolder("Launches", 0);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/assets/folders", {
      name: "Launches",
      expected_version: 0,
    });
  });

  it("renames with a positive expected_version", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "f1", name: "Renamed", assetCount: 2, version: 4 },
      error: null,
    });
    const folder = await renameAssetFolder("f1", "Renamed", 3);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/folders/f1",
      { name: "Renamed", expected_version: 3 },
    );
    // The answer carries the folder's new number, which a second rename needs.
    expect(folder.version).toBe(4);
  });

  it("deletes with the version in the BODY of the DELETE", async () => {
    // `readExpectedVersionBody` is the only place the folder delete looks; a
    // bodiless DELETE is a 428.
    rawRequest.mockResolvedValue(ok(5));
    await deleteAssetFolder("f1", 4);
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/assets/folders/f1",
      { expected_version: 4 },
    );
  });
});

describe("the tag writes — gated on the ASSET's version", () => {
  it("adds with expected_version and answers the row's new number", async () => {
    rawRequest.mockResolvedValue({
      data: { tags: ["hero", "q3 launch"], version: 12 },
      error: null,
    });
    const result = await addAssetTagVersioned("a1", "q3 launch", 11);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/assets/a1/tags", {
      tag: "q3 launch",
      expected_version: 11,
    });
    // `AddTagsToAsset` bumps `assets.version` even though the tag lands in a
    // join table — so a SECOND tag must send 12, not 11.
    expect(result).toEqual({ tags: ["hero", "q3 launch"], version: 12 });
  });

  it("removes with the tag in the path and the version in the body", async () => {
    rawRequest.mockResolvedValue(ok(13));
    await expect(removeAssetTagVersioned("a1", "q3 launch", 12)).resolves.toBe(13);
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/assets/a1/tags/q3%20launch",
      { expected_version: 12 },
    );
  });
});

describe("the refusals reach the caller as codes, not as generic failures", () => {
  it("surfaces 412 stale_version from a write the row moved under", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 412,
        message: "asset changed after it was read",
        code: "stale_version",
      },
    });
    await expect(moveAssetToFolder("a1", "f1", 3)).rejects.toMatchObject({
      status: 412,
      code: "stale_version",
    });
  });

  it("surfaces 428 expected_version_required, so a client bug names itself", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 428,
        message: "expected_version must be a positive integer",
        code: "expected_version_required",
      },
    });
    await expect(deleteAsset("a1", 1, false)).rejects.toMatchObject({
      status: 428,
      code: "expected_version_required",
    });
  });
});
