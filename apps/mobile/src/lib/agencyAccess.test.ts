import { describe, expect, it } from "vitest";

import { agencyChildrenEmptyCopy, agencyForbiddenKind } from "./agencyAccess";

describe("agencyForbiddenKind", () => {
  it("recognises the no-sub-accounts answer", () => {
    expect(agencyForbiddenKind("not_agency")).toBe("not_agency");
  });

  it("recognises both lost-access codes", () => {
    expect(agencyForbiddenKind("not_authorized")).toBe("restricted");
    expect(agencyForbiddenKind("not_your_child")).toBe("restricted");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(agencyForbiddenKind("  NOT_AGENCY ")).toBe("not_agency");
  });

  it("returns null for an absent or unrecognised code so it stays a real error", () => {
    expect(agencyForbiddenKind(undefined)).toBeNull();
    expect(agencyForbiddenKind("")).toBeNull();
    expect(agencyForbiddenKind("   ")).toBeNull();
    expect(agencyForbiddenKind("some_new_code")).toBeNull();
  });

  it("never confuses the two kinds", () => {
    expect(agencyForbiddenKind("not_agency")).not.toBe(
      agencyForbiddenKind("not_authorized"),
    );
  });
});

describe("agency empty-state copy", () => {
  it("never tells a permission-denied user their agency does not exist", () => {
    const children = agencyChildrenEmptyCopy(true, false);
    expect(children.title).toBe("Access restricted");
    expect(children.description).toMatch(/role or credential/);
  });

  it("keeps the genuine no-sub-accounts copy for a non-agency tenant", () => {
    expect(agencyChildrenEmptyCopy(false, true).title).toBe(
      "Not an agency workspace",
    );
    expect(agencyChildrenEmptyCopy(false, false).title).toBe(
      "No child workspaces",
    );
  });
});
