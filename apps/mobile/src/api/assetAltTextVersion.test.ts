/**
 * The alt-text PATCH is a VERSION-GATED write, and mobile was not sending the
 * gate.
 *
 * `Deps.Patch` reads `exactPositiveJSONInteger(in["expected_version"])`
 * (apps/api/internal/assets/handlers.go:487) and answers **428
 * expected_version_required** when the key is missing or not a positive
 * integer; `Repo.UpdateAltText` answers **412 stale_version** when it no longer
 * matches the stored row. Mobile's transport sent `{alt_text}` alone, so every
 * save from the phone was a guaranteed 428 — an item that looked implemented
 * and could never once have worked. The Go tests pin the live body
 * (`handlers_test.go:123` sends `{"alt_text":…,"expected_version":1}`) and
 * apps/web already sends it (`lib/assets-api.ts:551`).
 *
 * This file lives beside — not inside — src/api/assets.test.ts because that
 * file is owned by another session and still pins the pre-version body shape.
 * It is the reason `expectedVersion` is typed optional; nothing in the app
 * reaches that path, because the screen withholds the affordance when the row
 * carries no version.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
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

import { updateAssetAltText } from "./assets";
import { parseAsset } from "@/lib/assetLibrary";

beforeEach(() => {
  rawRequest.mockReset();
});

describe("updateAssetAltText carries the optimistic-concurrency version", () => {
  it("sends expected_version beside alt_text", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "a1", altText: "A red banner", version: 8 },
      error: null,
    });
    await updateAssetAltText("a1", "A red banner", 7);
    expect(rawRequest).toHaveBeenCalledWith("PATCH", "/api/v1/assets/a1", {
      alt_text: "A red banner",
      expected_version: 7,
    });
  });

  it("still sends alt_text when clearing the description", async () => {
    rawRequest.mockResolvedValue({ data: { id: "a1", version: 9 }, error: null });
    await updateAssetAltText("a1", "", 8);
    expect(rawRequest).toHaveBeenCalledWith("PATCH", "/api/v1/assets/a1", {
      alt_text: "",
      expected_version: 8,
    });
  });

  it("omits a version the server would reject rather than sending a 428 shape", async () => {
    // `exactPositiveJSONInteger` refuses 0, negatives and non-integers. Sending
    // one anyway would turn a client-side bug into a server-side 428 whose
    // message names a field the operator never saw.
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      rawRequest.mockResolvedValue({ data: { id: "a1" }, error: null });
      await updateAssetAltText("a1", "x", bad);
      expect(rawRequest).toHaveBeenLastCalledWith("PATCH", "/api/v1/assets/a1", {
        alt_text: "x",
      });
    }
  });

  it("surfaces the 412 with its code, so the screen can say what happened", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 412,
        message: "asset changed after it was read",
        code: "stale_version",
      },
    });
    await expect(updateAssetAltText("a1", "x", 4)).rejects.toMatchObject({
      status: 412,
      code: "stale_version",
    });
  });
});

describe("parseAsset reads the version off the row", () => {
  it("keeps a positive version", () => {
    expect(parseAsset({ id: "a1", version: 12 })?.version).toBe(12);
  });

  it("reports null — never a guess — when the payload carried none", () => {
    // A guessed version is either a 428 or, worse, a silent overwrite of a
    // teammate's edit. The screen reads null as "withhold the affordance".
    expect(parseAsset({ id: "a1" })?.version).toBeNull();
    expect(parseAsset({ id: "a1", version: "3" })?.version).toBeNull();
    expect(parseAsset({ id: "a1", version: -1 })?.version).toBeNull();
  });

  it("reports null for the two numbers the write handlers refuse", () => {
    // `exactPositiveJSONInteger` rejects 0 and any non-integer, so carrying
    // either would read as "versioned", offer the affordance, and send a
    // number the server answers 428 for.
    expect(parseAsset({ id: "a1", version: 0 })?.version).toBeNull();
    expect(parseAsset({ id: "a1", version: 1.5 })?.version).toBeNull();
  });
});
