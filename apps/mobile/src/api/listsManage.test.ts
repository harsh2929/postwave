/**
 * The list-manage writes, tested at the transport seam (rawRequest mocked —
 * the audienceDestinations idiom): the right verb hits the right path with
 * ONLY the changed fields, and a failed write reaches the error state
 * instead of resolving like a success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteList, updateList } from "./listsManage";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("updateList", () => {
  it("PATCHes the subset body to the list's path", async () => {
    rawRequest.mockResolvedValue({ data: { id: 7 }, error: null });
    await updateList("7", { name: "Weekly digest", optin: "double" });
    expect(rawRequest).toHaveBeenCalledWith("PATCH", "/api/v1/lists/7", {
      name: "Weekly digest",
      optin: "double",
    });
  });

  it("surfaces a failed PATCH as a throw carrying the envelope fields", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "field not allowed: tags", status: 400 },
    });
    await expect(updateList("7", { name: "x" })).rejects.toMatchObject({
      message: "field not allowed: tags",
      status: 400,
    });
  });
});

describe("deleteList", () => {
  it("DELETEs the list's path", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await deleteList("42");
    expect(rawRequest).toHaveBeenCalledWith("DELETE", "/api/v1/lists/42");
  });

  it("surfaces a failed DELETE instead of resolving", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(deleteList("42")).rejects.toMatchObject({ status: 403 });
  });
});
