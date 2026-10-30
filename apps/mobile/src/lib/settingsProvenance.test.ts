import { describe, expect, it } from "vitest";

import { provenanceLabel } from "@/lib/settingsProvenance";

const rel = (v: unknown) => (v === "bad" ? "—" : "2 hours ago");

describe("provenanceLabel", () => {
  it("renders nothing when the server sent no timestamp", () => {
    expect(provenanceLabel({}, rel)).toBeNull();
    expect(provenanceLabel({ updatedAt: null }, rel)).toBeNull();
    expect(provenanceLabel({ updatedAt: "   " }, rel)).toBeNull();
  });

  it("renders nothing rather than 'Updated —' for an unparseable timestamp", () => {
    expect(provenanceLabel({ updatedAt: "bad" }, rel)).toBeNull();
  });

  it("states only the time when the editor cannot be identified", () => {
    expect(
      provenanceLabel(
        { updatedAt: "2026-07-25T10:00:00Z", updatedByUserId: "u-other" },
        rel,
      ),
    ).toBe("Updated 2 hours ago");
  });

  it("attributes to the signed-in user only on an exact id match", () => {
    expect(
      provenanceLabel(
        {
          updatedAt: "2026-07-25T10:00:00Z",
          updatedByUserId: "u-1",
          currentUserId: "u-1",
        },
        rel,
      ),
    ).toBe("Updated 2 hours ago by you");
    expect(
      provenanceLabel(
        {
          updatedAt: "2026-07-25T10:00:00Z",
          updatedByUserId: "",
          currentUserId: "",
        },
        rel,
      ),
    ).toBe("Updated 2 hours ago");
  });
});
