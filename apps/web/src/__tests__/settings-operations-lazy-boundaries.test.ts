// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

describe("settings and operations lazy boundaries", () => {
  it("keeps secondary security cards outside the policy route's initial graph", () => {
    const page = source("app/(dashboard)/app/settings/security/page.tsx");

    for (const modulePath of [
      "./totp-enrollment-card",
      "./passkeys-card",
      "./identity-provider-card",
      "./security-activity-card",
      "./scim-admin-section",
      "./trusted-devices",
      "./active-devices",
    ]) {
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page.match(/ssr: false/g)).toHaveLength(5);
    expect(page).toContain("<SecurityPolicySettingsCard");
  });

  it("defers authenticated deliverability control planes but keeps health qualification eager", () => {
    const page = source("app/(dashboard)/app/deliverability/page.tsx");

    for (const modulePath of [
      "./blocklist-containment-panel",
      "./provider-config-panel",
      "./reply-mailbox-manager",
      "./operations-panel",
    ]) {
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page).toContain("summary?.sample_qualified === true");
    expect(page).toContain("meQuery.isSuccess ?");
    expect(page).toContain('role="status"');
    expect(page).toContain('aria-live="polite"');
  });

  it("loads private export managers outside the privacy route's destructive core", () => {
    const page = source("app/(dashboard)/app/settings/privacy/page.tsx");

    for (const modulePath of [
      "@/components/settings/export-retention-policy-card",
      "@/components/settings/workspace-exports-card",
    ]) {
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page.match(/ssr: false/g)).toHaveLength(2);
    expect(page).toContain("<PrivacyDeferredCard");
    expect(page).toContain('role="status"');
  });

  it("loads pilot operational clients only after the authenticated evidence query starts", () => {
    const page = source("app/(dashboard)/app/pilot/page.tsx");

    for (const modulePath of [
      "@/lib/migration-api",
      "@/lib/sending-controls-api",
      "@/lib/sms-api",
    ]) {
      expect(page).toContain(`import("${modulePath}")`);
      expect(page).not.toMatch(
        new RegExp(
          `^import\\s*\\{[^}]*\\}\\s*from\\s*["']${modulePath}["'];$`,
          "ms",
        ),
      );
    }
    expect(page).toContain("enabled: meQuery.isSuccess");
    expect(page).toContain("await migrationRuntime.listJobs()");
    expect(page).toContain("Promise.all([");
  });
});
