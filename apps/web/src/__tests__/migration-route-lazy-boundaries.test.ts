// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

describe("migration route lazy boundaries", () => {
  it("keeps terminal detail panels behind localized suspense boundaries", () => {
    const page = source("app/(dashboard)/app/migrations/[jobId]/page.tsx");

    for (const modulePath of [
      "./audit-card",
      "./rollback-section",
      "./verification-report-card",
      "../_progress-view",
      "../_cross-links",
    ]) {
      expect(page).toContain(`import("${modulePath}")`);
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
    }
    expect(page).toContain("<Suspense");
    expect(page).toContain("<DeferredPanelFallback");
    expect(page).toContain('role="status"');
  });

  it("loads only the active wizard step and keeps the wizard chrome visible", () => {
    const page = source("app/(dashboard)/app/migrations/new/[source]/page.tsx");

    for (const modulePath of [
      "./connect-step",
      "./review-step",
      "./import-step",
    ]) {
      expect(page).toContain(`import("${modulePath}")`);
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
    }
    expect(page).toMatch(
      /<Suspense[\s\S]*?<StepLoading[\s\S]*?state\.step === 0[\s\S]*?state\.step === 4[\s\S]*?<\/Suspense>/,
    );
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-busy="true"');
  });
});
