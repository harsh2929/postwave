// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(...parts: string[]): string {
  return readFileSync(path.join(ROOT, ...parts), "utf8");
}

const MIGRATION_COPY_FILES = [
  ["src", "app", "(marketing)", "page.tsx"],
  ["src", "app", "(marketing)", "features", "page.tsx"],
  ["src", "app", "(marketing)", "migrate-anywhere", "page.tsx"],
  ["src", "app", "(marketing)", "migrations", "page.tsx"],
  ["src", "app", "(marketing)", "migrations", "[from]", "page.tsx"],
  ["src", "app", "(marketing)", "about", "page.tsx"],
  ["src", "app", "(marketing)", "opengraph-image.tsx"],
  ["src", "app", "(marketing)", "roadmap", "page.tsx"],
  ["src", "app", "(marketing)", "vs", "page.tsx"],
  ["src", "components", "marketing", "comparison-page.tsx"],
  ["src", "components", "marketing", "product-menu.tsx"],
  ["src", "components", "tour", "tours", "marketing.ts"],
  ["locales", "en.json"],
  ["locales", "es.json"],
  ["locales", "fr.json"],
  ["locales", "de.json"],
  ["locales", "ja.json"],
  ["locales", "pt.json"],
] as const;

const STALE_MIGRATION_CLAIMS = [
  "Move in 20 minutes",
  "Migrate in 20 minutes",
  "Import everything in 20 minutes",
  "Even your automations get translated",
];

describe("marketing migration copy claims", () => {
  it("does not promise timed migration or unconditional automation translation", () => {
    const copy = MIGRATION_COPY_FILES.map((file) => read(...file)).join("\n");

    for (const staleClaim of STALE_MIGRATION_CLAIMS) {
      expect(copy).not.toContain(staleClaim);
    }
    expect(copy).toContain("Move with proof");
    expect(copy).toContain("dry-run report");
    expect(copy).toContain("Automations translate only where safe");
    expect(copy).toContain("preserves rebuild evidence");
    expect(copy).toContain("HubSpot");
    expect(copy).toContain("CRM bridge");
    expect(copy).toContain("private app token");
  });
});
