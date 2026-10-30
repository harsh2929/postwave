// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("warehouse route boundary", () => {
  it("defers the provider control plane while preserving truthful route chrome", () => {
    const page = source("app/(dashboard)/app/warehouse/page.tsx");
    const loader = source(
      "app/(dashboard)/app/warehouse/warehouse-manager-loader.tsx",
    );

    expect(page).toContain('from "./warehouse-manager-loader"');
    expect(page).not.toContain('from "./warehouse-manager"');
    expect(loader).toContain('import("./warehouse-manager")');
    expect(loader).toContain("ssr: false");
    expect(loader).toContain("Data warehouse");
    expect(loader).toContain('role="status"');
    expect(loader).toContain('aria-live="polite"');
    expect(loader).toContain('aria-busy="true"');
  });
});
