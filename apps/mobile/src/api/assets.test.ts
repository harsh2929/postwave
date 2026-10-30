/**
 * The transport seam for the asset ORGANISING writes (folders CRUD, per-asset
 * move, tag add/remove). `rawRequest` resolves to the `{data, error}`
 * ENVELOPE; handing that envelope to a parser would yield null/[] on every
 * real response while body-driven tests stayed green — the exact failure
 * src/api/audienceDestinations.test.ts documents. So the seam is tested with
 * `rawRequest` mocked, asserting verbs, paths, bodies and unwrapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
// The module is stubbed whole: importActual would pull request.ts → sdkClient
// → react-native, unparseable in the node environment. checkedApiResult is
// reproduced faithfully — reject on envelope error, tagging status AND code
// (assetOrganizeErrorMessage keys off `code`); pass through otherwise.
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      error: {
        message: string;
        status?: number | undefined;
        code?: string | undefined;
      } | null;
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

const {
  addAssetTag,
  createAssetFolder,
  deleteAssetFolder,
  fetchAssetTagList,
  moveAssetToFolder,
  removeAssetTag,
  renameAssetFolder,
} = await import("./assets");

beforeEach(() => {
  rawRequest.mockReset();
});

describe("createAssetFolder", () => {
  it("POSTs {name} to /assets/folders and unwraps the envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "f1", name: "Launches", assetCount: 0 },
      error: null,
    });
    const folder = await createAssetFolder("Launches");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/assets/folders",
      { name: "Launches" },
    );
    expect(folder.id).toBe("f1");
    expect(folder.name).toBe("Launches");
  });

  it("surfaces the 409 name_conflict as a throw carrying the code", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        message: "a folder with that name already exists",
        status: 409,
        code: "name_conflict",
      },
    });
    const attempt = createAssetFolder("Launches");
    await expect(attempt).rejects.toMatchObject({
      status: 409,
      code: "name_conflict",
    });
  });

  it("refuses a 201 whose body carries no usable folder", async () => {
    // No id → nothing to file the image into; silently half-succeeding would
    // leave the follow-up move pointed at nothing.
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(createAssetFolder("Launches")).rejects.toThrow(
      /couldn't be read/i,
    );
  });
});

describe("renameAssetFolder / deleteAssetFolder", () => {
  it("PATCHes the encoded folder id with {name}", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "f 1", name: "Renamed", assetCount: 2 },
      error: null,
    });
    const folder = await renameAssetFolder("f 1", "Renamed");
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/folders/f%201",
      { name: "Renamed" },
    );
    expect(folder.name).toBe("Renamed");
  });

  it("DELETEs the folder and resolves void", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await deleteAssetFolder("f1");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/assets/folders/f1",
    );
  });
});

describe("moveAssetToFolder", () => {
  it("PATCHes /{id}/folder with the folder id", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await moveAssetToFolder("a1", "f1");
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/a1/folder",
      { folder_id: "f1" },
    );
  });

  it("sends folder_id null for a move back to Uncategorised", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await moveAssetToFolder("a1", null);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/assets/a1/folder",
      { folder_id: null },
    );
  });
});

describe("asset tags", () => {
  it("GET unwraps the {tags} envelope body, never the envelope itself", async () => {
    rawRequest.mockResolvedValue({
      data: { tags: ["hero", "summer"] },
      error: null,
    });
    await expect(fetchAssetTagList("a1")).resolves.toEqual(["hero", "summer"]);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/assets/a1/tags");
  });

  it("POSTs {tag} and answers the asset's full tag list", async () => {
    rawRequest.mockResolvedValue({
      data: { tags: ["hero", "q3 launch"] },
      error: null,
    });
    await expect(addAssetTag("a1", "q3 launch")).resolves.toEqual([
      "hero",
      "q3 launch",
    ]);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/assets/a1/tags", {
      tag: "q3 launch",
    });
  });

  it("DELETEs the tag percent-encoded in the path", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await removeAssetTag("a1", "q3 launch");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/assets/a1/tags/q3%20launch",
    );
  });

  it("surfaces an envelope error as a throw, not an empty list", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "tag must be 1-64 chars", status: 400, code: "invalid_tag" },
    });
    await expect(addAssetTag("a1", "")).rejects.toThrow(/1-64/);
  });
});

describe("assetListPath sort", () => {
  it("threads a non-default sort through as ?sort=", async () => {
    const { assetListPath } = await import("./assets");
    expect(assetListPath({ sort: "largest" })).toContain("sort=largest");
    expect(assetListPath({ sort: "most-used" })).toContain("sort=most-used");
  });

  it("omits the server-default newest, so chip and bare request agree", async () => {
    const { assetListPath } = await import("./assets");
    expect(assetListPath({ sort: "newest" })).not.toContain("sort=");
    expect(assetListPath({})).not.toContain("sort=");
  });
});

describe("updateAssetAltText", () => {
  it("PATCHes exactly {alt_text} — any other key is an unknown_field 400", async () => {
    const { updateAssetAltText } = await import("./assets");
    rawRequest.mockResolvedValue({
      data: { ...{ id: "a1", filename: "hero.png", mime: "image/png" }, alt_text: "A red banner" },
      error: null,
    });
    await updateAssetAltText("a1", "A red banner");
    expect(rawRequest).toHaveBeenCalledWith("PATCH", "/api/v1/assets/a1", {
      alt_text: "A red banner",
    });
  });

  it("unwraps the ENVELOPE and hands only the body to the parser", async () => {
    const { updateAssetAltText } = await import("./assets");
    rawRequest.mockResolvedValue({
      data: {
        id: "a1",
        filename: "hero.png",
        mime: "image/png",
        // the RESPONSE row uses the camelCase render tag (repo.go json:"altText")
        altText: "A red banner",
      },
      error: null,
    });
    const row = await updateAssetAltText("a1", "A red banner");
    // parseAsset(envelope) would yield null (no id at the top level);
    // a non-null row proves the seam unwrapped before parsing.
    expect(row?.id).toBe("a1");
    expect(row?.altText).toBe("A red banner");
  });

  it("surfaces an envelope error as a throw, never a silent null", async () => {
    const { updateAssetAltText } = await import("./assets");
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "alt_text must be <= 1024 characters", status: 400, code: "alt_too_long" },
    });
    await expect(updateAssetAltText("a1", "x")).rejects.toThrow(/1024/);
  });
});
