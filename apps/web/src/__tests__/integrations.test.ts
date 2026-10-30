import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";
import { INTEGRATIONS, INTEGRATION_CATEGORIES } from "@/lib/integrations";
import { normalizeCrmOAuthAvailability } from "@/lib/crm-api";
import { managedOAuthAvailable } from "@/lib/integrations-surface-api";

describe("integration catalog", () => {
  it("every entry is well-formed and categorized", () => {
    for (const i of INTEGRATIONS) {
      expect(i.summary.length, i.slug).toBeLessThanOrEqual(140);
      expect(i.setupSteps).toHaveLength(3);
      expect(i.example.code.length, i.slug).toBeGreaterThan(0);
      for (const c of i.capabilities)
        expect(c.length, `${i.slug}:${c}`).toBeLessThanOrEqual(90);
      expect(INTEGRATION_CATEGORIES, i.slug).toContain(i.category);
    }
    expect(INTEGRATIONS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(INTEGRATIONS.map((x) => x.slug)).size).toBe(
      INTEGRATIONS.length,
    );
  });

  it("links only to setup guides that are actually published", () => {
    const publishedGuides = new Set([
      "/docs/integrations/slack",
      "/docs/integrations/stripe",
    ]);

    for (const integration of INTEGRATIONS) {
      if (integration.docsLink) {
        expect(
          publishedGuides.has(integration.docsLink),
          integration.slug,
        ).toBe(true);
      }
    }
    expect(
      INTEGRATIONS.filter((integration) => integration.docsLink).map(
        (integration) => integration.docsLink,
      ),
    ).toEqual([...publishedGuides]);
  });

  it("documents only the Slack commands and Stripe lifecycle that ship", () => {
    const embeddedGuides = readFileSync(
      path.join(
        process.cwd(),
        "src/app/(docs)/docs/integrations/[integration]/page.tsx",
      ),
      "utf8",
    );
    const publishedCopy = `${embeddedGuides}\n${JSON.stringify(INTEGRATIONS)}`;

    expect(publishedCopy).toContain("/postwave campaigns");
    expect(publishedCopy).toContain("/postwave send <campaign_id>");
    expect(publishedCopy).toContain("/api/public/commerce/stripe/webhooks");
    expect(publishedCopy).not.toContain("/postwave status");
    expect(publishedCopy).not.toContain("/postwave subscriber");
    expect(publishedCopy).not.toContain("/postwave pause");
    expect(publishedCopy).not.toContain("Connect Stripe via OAuth");
    expect(publishedCopy).not.toContain("/api/v1/integrations/stripe/webhook");
    expect(publishedCopy).not.toContain("Customer Portal embed");
  });

  it("treats CRM OAuth configured responses as managed OAuth availability", () => {
    const oldShape = normalizeCrmOAuthAvailability({
      configured: true,
      requires_session: true,
      start_url: "/api/v1/crm/salesforce/oauth/start",
    });

    expect(oldShape.available).toBe(true);
    expect(managedOAuthAvailable(oldShape)).toBe(true);
    expect(managedOAuthAvailable({ configured: false })).toBe(false);
    expect(managedOAuthAvailable({ available: false, configured: true })).toBe(
      false,
    );
  });

  it("separates HubSpot CRM sync from migration and does not promise token-managed webhooks", () => {
    const hubspot = INTEGRATIONS.find(
      (integration) => integration.slug === "hubspot",
    );
    expect(hubspot).toBeDefined();
    const copy = JSON.stringify(hubspot);

    expect(copy).toContain("separate from the one-time HubSpot migration");
    expect(copy).toContain("managed OAuth");
    expect(copy).toContain(
      "private-app-only setups rely on scheduled backfill",
    );
    expect(copy).toContain("Configured list-membership mappings");
    expect(copy).toContain("integration-scoped binding");
    expect(copy).toContain(
      "does not overwrite an unrelated subscriber external ID",
    );
    expect(copy).toContain(
      "only connector-owned list memberships are detached",
    );
    expect(copy).toContain("consent/status is not changed");
    expect(copy).not.toContain("Choose which HubSpot contact properties map");
    expect(copy).not.toContain("registers managed webhooks");
    expect(copy).not.toContain('"tags":["hubspot:contact"]');
    expect(copy).not.toContain('"custom_fields"');
  });
});
