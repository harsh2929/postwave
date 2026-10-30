import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = process.cwd();
const source = (relativePath: string) =>
  readFileSync(join(webRoot, relativePath), "utf8");

describe("confirmed web accessibility boundaries", () => {
  it("opens subscriber details through a named native button, not a mouse-only row", () => {
    const table = source(
      "src/app/(dashboard)/app/subscribers/subscribers-table.tsx",
    );
    const rowStart = table.indexOf('data-testid="subscriber-row"');
    const row = table.slice(rowStart, table.indexOf("</tr>", rowStart));
    expect(rowStart).toBeGreaterThan(0);
    expect(row).not.toContain("onClick={(e)");
    expect(row).toContain("<button");
    expect(row).toContain("aria-label={`Open subscriber ${sub.email}`}");
  });

  it("selects form fields through a focusable native button", () => {
    const field = source("src/components/forms/field-block.tsx");
    expect(field).not.toContain("<div\n      onClick={onClick}");
    expect(field).toContain("<button");
    expect(field).toContain("aria-pressed={Boolean(selected)}");
    expect(field).toContain("onClick={onClick}");
    expect(field).toContain("focus-visible:ring-2");
  });
});
