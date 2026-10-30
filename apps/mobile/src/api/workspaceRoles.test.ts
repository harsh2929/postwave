/**
 * The transport seam, tested with exactly what rawRequest resolves to —
 * the {data, error} envelope — per the idiom in audienceDestinations.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listWorkspaceRoles, WorkspaceRolesError } from "./workspaceRoles";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("listWorkspaceRoles", () => {
  it("unwraps the envelope and asks the right route", async () => {
    rawRequest.mockResolvedValue({
      data: {
        roles: [
          { id: "r1", name: "admin", assignedScopes: ["audit:read"] },
        ],
      },
      error: null,
    });
    const rows = await listWorkspaceRoles();
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/roles");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("admin");
  });

  it("surfaces a failure with its status instead of an empty list", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(listWorkspaceRoles()).rejects.toMatchObject({
      message: "forbidden",
      status: 403,
    });
    await expect(
      listWorkspaceRoles().catch((e) => e instanceof WorkspaceRolesError),
    ).resolves.toBe(true);
  });
});
