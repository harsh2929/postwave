/** Transport seam for the SCIM role-mapping writes. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteScimRoleMapping, upsertScimRoleMapping } from "./scimMappings";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("upsertScimRoleMapping", () => {
  it("POSTs the snake_case body and returns the stored row", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "m-1", group_name: "Eng", role: "editor", precedence: 10 },
      error: null,
    });
    const saved = await upsertScimRoleMapping({
      groupName: " Eng ",
      role: "editor",
      precedence: 10,
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/scim/role-mappings",
      { group_name: "Eng", role: "editor", precedence: 10 },
    );
    expect(saved).toEqual({
      id: "m-1",
      groupName: "Eng",
      role: "editor",
      precedence: 10,
    });
  });

  it("surfaces the denial with status and code", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, code: "forbidden", message: "admin required" },
    });
    await expect(
      upsertScimRoleMapping({ groupName: "Eng", role: "admin", precedence: 1 }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("deleteScimRoleMapping", () => {
  it("DELETEs by id", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await deleteScimRoleMapping("m-1");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/scim/role-mappings/m-1",
      undefined,
    );
  });
  it("refuses an empty id without a round trip", async () => {
    await expect(deleteScimRoleMapping("  ")).rejects.toThrow(/mapping id/);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
