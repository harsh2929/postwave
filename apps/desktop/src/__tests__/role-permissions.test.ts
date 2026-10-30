// Tests for the role → capability gate. Pure functions over a tiny
// permission matrix; if these change accidentally the entire admin
// surface (settings page, custom domain controls, billing) becomes
// readable but unwritable for anybody but the owner.

import { describe, expect, it } from "vitest";

import { canAdmin, canWrite } from "../lib/store";

describe("canWrite", () => {
  it("admin and editor can write", () => {
    expect(canWrite("admin")).toBe(true);
    expect(canWrite("editor")).toBe(true);
  });

  it("viewer cannot write", () => {
    expect(canWrite("viewer")).toBe(false);
  });

  it("missing role defaults to false while identity is unresolved", () => {
    // Pass null explicitly so we don't fall back to the global me.role.
    expect(canWrite(null)).toBe(false);
  });
});

describe("canAdmin", () => {
  it("only admin can admin", () => {
    expect(canAdmin("admin")).toBe(true);
    expect(canAdmin("editor")).toBe(false);
    expect(canAdmin("viewer")).toBe(false);
  });

  it("missing role defaults to false while identity is unresolved", () => {
    expect(canAdmin(null)).toBe(false);
  });
});
