import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("account deletion scope copy", () => {
  it("keeps personal deletion distinct from workspace deletion on both web pages", () => {
    const settings = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/app/settings/privacy/page.tsx"),
      "utf8",
    );
    const legal = readFileSync(
      join(
        process.cwd(),
        "src/app/(marketing)/legal/account-deletion/page.tsx",
      ),
      "utf8",
    );

    expect(settings).toContain("Delete my account");
    expect(settings).toContain("Request workspace deletion");
    expect(settings).toContain("This does not delete the workspace");
    expect(settings).toContain("DELETE MY ACCOUNT");
    expect(legal).toContain(
      "It does <strong>not</strong> delete workspace-owned",
    );
    expect(legal).toContain("last or sole workspace owner");
  });
});
