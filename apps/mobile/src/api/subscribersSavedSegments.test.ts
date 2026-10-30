/**
 * The saved-segment writes, driven through the transport seam with
 * `rawRequest` mocked (the audienceDestinations idiom): the wire bodies the
 * Go handler decodes are pinned here, and a failed write must throw rather
 * than resolve.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSavedSegment,
  deleteSavedSegment,
  previewSavedSegment,
} from "./subscribersSavedSegments";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("createSavedSegment", () => {
  it("POSTs the SavedSegmentInput shape the handler decodes", async () => {
    rawRequest.mockResolvedValue({ data: { id: "seg-1" }, error: null });
    const id = await createSavedSegment({
      name: "  Engaged EU  ",
      description: " People to call ",
      predicate: { filters: { status: "enabled", q: "eu" } },
      visibilityScope: "workspace",
    });
    expect(id).toBe("seg-1");
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/segments/saved", {
      name: "Engaged EU",
      description: "People to call",
      predicate_json: { filters: { status: "enabled", q: "eu" } },
      visibility_scope: "workspace",
    });
  });

  it("surfaces a refused create instead of resolving", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "name_taken", status: 409 },
    });
    await expect(
      createSavedSegment({
        name: "x",
        description: "",
        predicate: {},
        visibilityScope: "personal",
      }),
    ).rejects.toMatchObject({ message: "name_taken", status: 409 });
  });
});

describe("deleteSavedSegment / previewSavedSegment", () => {
  it("addresses the row it was given, id-encoded", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteSavedSegment("seg/1");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/segments/saved/seg%2F1",
    );
    await previewSavedSegment("seg 2");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/segments/saved/seg%202/preview",
    );
  });

  it("surfaces a failed delete", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "not_found", status: 404 },
    });
    await expect(deleteSavedSegment("gone")).rejects.toMatchObject({
      status: 404,
    });
  });
});
