// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("Shadow-PII route boundary", () => {
  it("defers the admin data client behind an accessible client island", () => {
    const page = source("app/(dashboard)/app/pii-findings/page.tsx");
    const loader = source(
      "app/(dashboard)/app/pii-findings/pii-findings-client-loader.tsx",
    );

    expect(page).toContain('from "./pii-findings-client-loader"');
    expect(page).not.toContain('from "./pii-findings-client"');
    expect(loader).toContain('import("./pii-findings-client")');
    expect(loader).toContain("ssr: false");
    expect(loader).toContain('role="status"');
    expect(loader).toContain('aria-busy="true"');
    expect(loader).toContain('aria-live="polite"');
  });
});
