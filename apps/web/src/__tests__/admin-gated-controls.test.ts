// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression for finding 5: the CRM-lifecycle, conversion-keys, and
// send-time-optimization (STO) surfaces must not present destructive/admin
// controls to read-only roles (the server enforces ScopeAdmin, but a button
// that only 403s is a UX bug).
//
// Two layers:
//   1. roleCanWrite() — the predicate the panels gate on — only admits
//      owner/admin.
//   2. A source-level guard: each surface either uses the shared presentation
//      gate or withholds the whole privileged subtree behind exact identity
//      authority and re-verifies that authority immediately before a write.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { roleCanWrite } from "@/lib/use-admin-gate";
import { effectiveAuthRole } from "@/lib/auth-api";

describe("roleCanWrite", () => {
  it("admits only owner and admin", () => {
    expect(roleCanWrite("owner")).toBe(true);
    expect(roleCanWrite("admin")).toBe(true);
  });

  it("rejects editor, viewer, and the unresolved (null) role", () => {
    expect(roleCanWrite("editor")).toBe(false);
    expect(roleCanWrite("viewer")).toBe(false);
    expect(roleCanWrite(null)).toBe(false);
    expect(roleCanWrite(undefined)).toBe(false);
  });
});

describe("effectiveAuthRole", () => {
  it("uses the session downgrade for viewer-mode UI gating", () => {
    expect(
      effectiveAuthRole({
        user_id: "user-1",
        tenant_id: "tenant-1",
        email: "owner@example.com",
        role: "owner",
        effective_role: "viewer",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Acme",
        workspace_slug: "acme",
      }),
    ).toBe("viewer");
  });
});

const WEB = (rel: string): string =>
  readFileSync(path.join(process.cwd(), "src", rel), "utf8");

describe("destructive controls are role-gated (finding 5)", () => {
  const surfaces: Array<{
    name: string;
    file: string;
    gate: "presentation" | "exact-admin";
  }> = [
    {
      name: "CRM lifecycle panel",
      file: "components/integrations/crm-lifecycle-panel.tsx",
      gate: "exact-admin",
    },
    {
      name: "conversion keys panel",
      file: "components/integrations/conversion-keys-panel.tsx",
      gate: "presentation",
    },
    {
      name: "send-time optimization page",
      file: "app/(dashboard)/app/settings/send-time/page.tsx",
      gate: "presentation",
    },
    {
      name: "saved reports",
      file: "app/(dashboard)/app/reports/_components/saved-reports.tsx",
      gate: "presentation",
    },
    {
      name: "report builder",
      file: "app/(dashboard)/app/reports/_components/report-builder.tsx",
      gate: "presentation",
    },
    {
      name: "data operations",
      file: "app/(dashboard)/app/data-operations/page.tsx",
      gate: "presentation",
    },
    {
      name: "writeback targets",
      file: "components/integrations/writeback-targets-panel.tsx",
      gate: "presentation",
    },
    {
      name: "suppressions",
      file: "app/(dashboard)/app/suppressions/page-client.tsx",
      gate: "presentation",
    },
    {
      name: "integration detail",
      file: "app/(dashboard)/app/integrations/catalog/[slug]/page.tsx",
      gate: "exact-admin",
    },
  ];

  for (const { name, file, gate } of surfaces) {
    it(`${name} wires the admin gate`, () => {
      const src = WEB(file);
      if (gate === "presentation") {
        expect(src).toContain("useAdminGate");
        expect(src).toContain("canWrite");
        expect(src).toContain("AdminGateNotice");
        return;
      }

      // These surfaces deliberately do more than hide individual controls:
      // denied identities never mount the tenant-scoped reader, and an
      // already-open action is rebound to a fresh exact admin identity before
      // its request is sent.
      expect(src).toContain("canReadAdminData");
      expect(src).toContain("verifyFreshAdminAuthority");
      expect(src).toMatch(/if \(!canAdmin\)[\s\S]{0,120}read-only/);
      expect(src).toMatch(/<Authorized(?:CrmLifecyclePanel|IntegrationDetail)/);
    });
  }

  it("CRM lifecycle buttons exist only inside the authorized subtree", () => {
    const src = WEB("components/integrations/crm-lifecycle-panel.tsx");
    const authorized = src.slice(
      src.indexOf("function AuthorizedCrmLifecyclePanel"),
    );
    expect(authorized).toContain("verifyFreshAdminAuthority");
    for (const label of ["Sync now", "Pause", "Resume", "Disconnect"]) {
      expect(authorized).toContain(label);
    }
  });

  it("conversion key revoke is behind canWrite", () => {
    const src = WEB("components/integrations/conversion-keys-panel.tsx");
    expect(src).toContain("!revoked && canWrite");
  });

  it("STO toggle is disabled for non-writers", () => {
    const src = WEB("app/(dashboard)/app/settings/send-time/page.tsx");
    expect(src).toContain("!canWrite");
  });

  it("discount history has no provider write control that needs a role gate", () => {
    const src = WEB("app/(dashboard)/app/discounts/page.tsx");
    expect(src).toContain("Historical, read-only evidence");
    expect(src).not.toMatch(
      /createDiscount|updateDiscount|deleteDiscount|redemptionsCsv/u,
    );
    expect(src).not.toContain("useAdminGate");
  });
});
