import { describe, expect, it } from "vitest";

import {
  campaignAccess,
  isAdminRole,
  isExactTenantAdminRole,
  isViewerRole,
} from "./campaignAccess";

const ONLINE_EDITOR = {
  online: true,
  sessionUsable: true,
  effectiveRole: "editor",
};

describe("role predicates", () => {
  it("recognises viewer aliases case-insensitively", () => {
    expect(isViewerRole("viewer")).toBe(true);
    expect(isViewerRole("READ_ONLY")).toBe(true);
    expect(isViewerRole(" guest ")).toBe(true);
    expect(isViewerRole("editor")).toBe(false);
    expect(isViewerRole(null)).toBe(false);
  });

  it("recognises admin aliases", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("Owner")).toBe(true);
    expect(isAdminRole("editor")).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });

  it("keeps exact-admin routes narrower than broad admin UI aliases", () => {
    expect(isExactTenantAdminRole("admin")).toBe(true);
    expect(isExactTenantAdminRole("Owner")).toBe(true);
    expect(isExactTenantAdminRole("superadmin")).toBe(false);
    expect(isExactTenantAdminRole("custom-admin")).toBe(false);
    expect(isExactTenantAdminRole("viewer")).toBe(false);
  });
});

describe("campaignAccess", () => {
  it("lets an online editor mutate but not run admin-only actions", () => {
    const a = campaignAccess(ONLINE_EDITOR);
    expect(a.canMutate).toBe(true);
    expect(a.canAdmin).toBe(false);
    expect(a.notice).toBeNull();
  });

  it("grants admin actions to an admin", () => {
    const a = campaignAccess({ ...ONLINE_EDITOR, effectiveRole: "admin" });
    expect(a.canAdmin).toBe(true);
  });

  it("denies a viewer even when online with a usable session", () => {
    const a = campaignAccess({ ...ONLINE_EDITOR, effectiveRole: "viewer" });
    expect(a.canMutate).toBe(false);
    expect(a.reason).toBe("viewer");
    expect(a.notice).toContain("read-only");
  });

  it("tells an offline VIEWER about their role, not about connectivity", () => {
    const a = campaignAccess({
      online: false,
      sessionUsable: true,
      effectiveRole: "viewer",
    });
    expect(a.reason).toBe("viewer");
  });

  it("blocks on an unusable (cached) session before connectivity", () => {
    const a = campaignAccess({
      online: true,
      sessionUsable: false,
      effectiveRole: "admin",
    });
    expect(a.canMutate).toBe(false);
    expect(a.reason).toBe("session");
  });

  it("blocks an offline editor with a connectivity explanation", () => {
    const a = campaignAccess({ ...ONLINE_EDITOR, online: false });
    expect(a.canMutate).toBe(false);
    expect(a.reason).toBe("offline");
    expect(a.notice).toContain("offline");
  });

  it("treats an unknown role as an editor rather than locking the app out", () => {
    const a = campaignAccess({ ...ONLINE_EDITOR, effectiveRole: "analyst" });
    expect(a.canMutate).toBe(true);
    expect(a.canAdmin).toBe(false);
  });

  it("treats a null role as an editor (role not yet resolved)", () => {
    const a = campaignAccess({ ...ONLINE_EDITOR, effectiveRole: null });
    expect(a.canMutate).toBe(true);
  });
});
