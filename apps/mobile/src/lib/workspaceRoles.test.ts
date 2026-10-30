import { describe, expect, it } from "vitest";

import {
  normalizeWorkspaceRoles,
  roleScopeSummary,
} from "@/lib/workspaceRoles";

// The exact body apps/api writes: audit_rbac.go:107 ListRoles →
// {"roles": [RoleWithScopes], "availableScopes": [...]} — camelCase keys.
const SERVER = {
  roles: [
    {
      id: "r-admin",
      name: "admin",
      description: "Full workspace control",
      assignedScopes: ["audit:read", "audit:configure_sinks"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "r-viewer",
      name: "viewer",
      description: "",
      assignedScopes: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
  availableScopes: ["audit:read", "audit:configure_sinks"],
};

describe("normalizeWorkspaceRoles", () => {
  it("reads the camelCase wire shape", () => {
    const rows = normalizeWorkspaceRoles(SERVER);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "r-admin",
      name: "admin",
      description: "Full workspace control",
      scopes: ["audit:read", "audit:configure_sinks"],
    });
    expect(rows[1]?.scopes).toEqual([]);
  });

  it("drops junk rows and survives junk payloads", () => {
    expect(normalizeWorkspaceRoles(null)).toEqual([]);
    expect(normalizeWorkspaceRoles({ roles: "nope" })).toEqual([]);
    expect(
      normalizeWorkspaceRoles({
        roles: [{ id: "", name: "ghost" }, { id: "x" }, null, 42],
      }),
    ).toEqual([]);
  });

  it("de-duplicates and trims scope strings", () => {
    const rows = normalizeWorkspaceRoles({
      roles: [
        {
          id: "r",
          name: "n",
          assignedScopes: [" a ", "a", "", 7, "b"],
        },
      ],
    });
    expect(rows[0]?.scopes).toEqual(["a", "b"]);
  });
});

describe("roleScopeSummary", () => {
  const role = (scopes: string[]) => ({
    id: "r",
    name: "n",
    description: "",
    scopes,
  });

  it("says so when a role has no scopes", () => {
    expect(roleScopeSummary(role([]))).toBe("No scopes assigned");
  });

  it("joins a short list verbatim", () => {
    expect(roleScopeSummary(role(["a", "b"]))).toBe("a, b");
  });

  it("bounds a long list with a +N tail", () => {
    const scopes = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    expect(roleScopeSummary(role(scopes))).toBe(
      "s1, s2, s3, s4, s5, s6 +2 more",
    );
  });
});
