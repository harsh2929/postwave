import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConnectStep } from "@/app/(dashboard)/app/migrations/new/[source]/connect-step";
import type { MeResponse } from "@/lib/auth-api";
import { mockCapabilities } from "@/lib/migration-mocks";
import { MIGRATION_SOURCE_PLATFORMS, SOURCE_LABELS } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const ADMIN_IDENTITY: MeResponse = {
  user_id: "usr_admin",
  tenant_id: "tnt_1",
  email: "admin@example.com",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

describe("migration connection branches", () => {
  it("keeps the capability catalogue and every connect branch in lockstep", () => {
    const capabilities = mockCapabilities();

    expect(capabilities.map(({ source }) => source)).toEqual([
      ...MIGRATION_SOURCE_PLATFORMS,
    ]);

    for (const capability of capabilities) {
      const html = renderToStaticMarkup(
        <ConnectStep
          source={capability.source}
          authMethod={capability.auth_method}
          onConnected={vi.fn()}
          identity={ADMIN_IDENTITY}
          authorityKey="tnt_1:usr_admin:admin:member"
          beforeWrite={async () => undefined}
        />,
      );

      expect(html).toContain(SOURCE_LABELS[capability.source]);
      if (capability.auth_method === "oauth2") {
        expect(html).toContain(
          `Continue with ${SOURCE_LABELS[capability.source]}`,
        );
        expect(html).not.toContain('type="password"');
      } else if (capability.auth_method === "api_key") {
        expect(html).toContain('type="password"');
        expect(html).toContain("Connect");
      } else {
        expect(html).toContain('role="button"');
        expect(html).toContain("up to 200 MB");
      }
    }
  });

  it("shows the provider-binding fields that prevent ambiguous API-key imports", () => {
    const cases = [
      ["activecampaign", "Account API URL"],
      ["hubspot", "Hub ID (optional)"],
      ["beehiiv", "Publication ID"],
      ["klaviyo", "Account ID (optional)"],
      ["customerio", "Workspace ID"],
    ] as const;

    for (const [source, expected] of cases) {
      const capability = mockCapabilities().find(
        (candidate) => candidate.source === source,
      );
      expect(capability).toBeDefined();
      const html = renderToStaticMarkup(
        <ConnectStep
          source={source}
          authMethod="api_key"
          onConnected={vi.fn()}
          identity={ADMIN_IDENTITY}
          authorityKey="tnt_1:usr_admin:admin:member"
          beforeWrite={async () => undefined}
        />,
      );
      expect(html).toContain(expected);
    }
  });
});
