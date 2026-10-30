/**
 * The tag-maintenance transport: the PATCH is conditional on the row's
 * strong revision and refuses without it, the module exports NO delete
 * function (both delete routes are unconditional server-side holds), and
 * envelope errors THROW.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import * as tagsManage from "./tagsManage";

beforeEach(() => rawRequest.mockReset());

describe("tag maintenance transport", () => {
  it("PATCHes with the tag's own If-Match token", async () => {
    rawRequest.mockResolvedValue({ data: { id: "t1" }, error: null });
    await tagsManage.updateTag("t1", '"tag:t1:v4"', { color: "teal" });
    expect(rawRequest.mock.calls[0]).toEqual([
      "PATCH",
      "/api/v1/tags/t1",
      { color: "teal" },
      { headers: { "If-Match": '"tag:t1:v4"' } },
    ]);
  });

  it("refuses the PATCH without the token, on-device", async () => {
    await expect(
      tagsManage.updateTag("t1", "", { color: "teal" }),
    ).rejects.toThrow(/missing its revision token/);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("reads the history feed with its limit", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await tagsManage.fetchTagHistory("t1");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/tags/t1/history?limit=50",
    );
  });

  it("group CRUD hits the three tag-group routes", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await tagsManage.createTagGroup({ name: "Lifecycle", color: "", sort_order: 0 });
    await tagsManage.updateTagGroup("g1", { name: "Cohorts" });
    await tagsManage.deleteTagGroup("g1");
    expect(rawRequest.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["POST", "/api/v1/tag-groups"],
      ["PATCH", "/api/v1/tag-groups/g1"],
      ["DELETE", "/api/v1/tag-groups/g1"],
    ]);
  });

  it("exports NO tag-delete call — the server holds both delete routes", () => {
    expect(
      Object.keys(tagsManage).filter((k) => /delete/i.test(k)),
    ).toEqual(["deleteTagGroup"]);
  });

  it("throws envelope errors", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "precondition", status: 412 },
    });
    await expect(
      tagsManage.updateTag("t1", '"tag:t1:v4"', { color: "teal" }),
    ).rejects.toMatchObject({ status: 412 });
  });
});
