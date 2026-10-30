// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), "src", path), "utf8");

function expectDynamicOnly(source: string, modulePath: string): void {
  expect(source).toContain(`import("${modulePath}")`);
  expect(source).not.toMatch(
    new RegExp(
      `^import (?!type )[^;]+from "${modulePath.replaceAll("/", "\\/")}";`,
      "m",
    ),
  );
}

describe("small outlier initial-route boundaries", () => {
  it("keeps audience operational managers behind verified identity renders", () => {
    const destinations = read(
      "app/(dashboard)/app/audience-destinations/page.tsx",
    );
    const syncs = read("app/(dashboard)/app/audience-syncs/page.tsx");
    expectDynamicOnly(destinations, "./audience-destinations-manager");
    expectDynamicOnly(syncs, "./audience-syncs-manager");
    expect(destinations).toContain("meQuery.data");
    expect(syncs).toContain("meQuery.data");
    expect(destinations).toContain('role="status"');
    expect(syncs).toContain('role="status"');
  });

  it("splits analytics, commerce, compliance, approval, and verification clients", () => {
    const cases = [
      ["app/(dashboard)/app/analytics/page.tsx", "./_overview"],
      [
        "app/(dashboard)/app/integrations/page.tsx",
        "./commerce-integrations-panel",
      ],
      [
        "app/(dashboard)/app/compliance/page.tsx",
        "./compliance-program-control-plane",
      ],
      [
        "app/(dashboard)/app/compliance-requests/page.tsx",
        "./scheduled-reports-panel",
      ],
      ["app/(dashboard)/app/approvals/page.tsx", "./approval-decision-dialog"],
      [
        "app/(dashboard)/app/approvals/page.tsx",
        "./approvals-governance-panel",
      ],
      [
        "app/(dashboard)/app/verification/page.tsx",
        "./verification-admin-panel",
      ],
      [
        "app/(dashboard)/app/verification/page.tsx",
        "./verification-jobs-panel",
      ],
      ["app/(dashboard)/app/verification/page.tsx", "./verify-address-panel"],
    ] as const;
    for (const [file, modulePath] of cases) {
      expectDynamicOnly(read(file), modulePath);
    }
    expect(read("app/(dashboard)/app/approvals/page.tsx")).toContain(
      "{decision?.authorityKey === authorityKey ? (",
    );
  });

  it("uses accessible lazy route islands for the largest route-local clients", () => {
    const cases = [
      [
        "app/(dashboard)/app/custom-objects/page.tsx",
        "./custom-objects-client",
      ],
      ["app/(dashboard)/app/referrals/page.tsx", "./page-client"],
      ["app/(dashboard)/app/suppressions/page.tsx", "./page-client"],
      [
        "app/(dashboard)/app/routing/inbound-routes/page.tsx",
        "./inbound-routes-client",
      ],
    ] as const;
    for (const [file, modulePath] of cases) {
      const source = read(file);
      expectDynamicOnly(source, modulePath);
      expect(source).toContain("ssr: false");
      expect(source).toContain('role="status"');
      expect(source).toContain('aria-busy="true"');
    }
  });
});
