/** Transport seam for the feature-flag override writes. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteFeatureFlagOverride,
  upsertFeatureFlag,
} from "./featureFlagOverrides";
import { PlatformConfigError } from "./platformConfig";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("upsertFeatureFlag", () => {
  it("POSTs the trimmed body and reads {id, key, value} off the answer", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "f1", key: "new_composer", value: "on" },
      error: null,
    });
    const res = await upsertFeatureFlag({
      key: "new_composer",
      value: "on",
      note: "beta",
    });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/feature-flags", {
      key: "new_composer",
      value: "on",
      note: "beta",
    });
    expect(res).toEqual({ id: "f1", key: "new_composer", value: "on" });
  });

  it("falls back to the key it sent when the answer omits one", async () => {
    rawRequest.mockResolvedValue({ data: { id: "f1" }, error: null });
    const res = await upsertFeatureFlag({ key: "k", value: "v", note: "" });
    expect(res.key).toBe("k");
  });

  it("throws a status-typed error on the server's 400 bad_key", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 400, code: "bad_key", message: "1..200 chars required" },
    });
    await expect(
      upsertFeatureFlag({ key: "", value: "on", note: "" }),
    ).rejects.toMatchObject({
      name: "PlatformConfigError",
      status: 400,
      message: "1..200 chars required",
    });
  });
});

describe("deleteFeatureFlagOverride", () => {
  it("DELETEs the encoded key and resolves on 204", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await expect(deleteFeatureFlagOverride("a/b")).resolves.toBeUndefined();
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/feature-flags/a%2Fb",
    );
  });

  it("surfaces a 404 (no override to remove) as a status-typed error", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 404, code: "not_found", message: "" },
    });
    const failure = await deleteFeatureFlagOverride("gone").catch((e) => e);
    expect(failure).toBeInstanceOf(PlatformConfigError);
    expect(failure.status).toBe(404);
    expect(failure.message).toBe("Couldn't remove the override.");
  });
});
