import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { capabilityForSection } from "../../lib/desktop-capabilities";
import {
  COMMAND_PALETTE_NAV_TARGETS,
  PERSISTENT_DESKTOP_SECTIONS,
} from "../../lib/desktop-routes";

function componentSource(name: string): string {
  return readFileSync(
    new URL(`../../components/${name}`, import.meta.url),
    "utf8",
  );
}

describe("desktop user-facing capability contract", () => {
  it("shows only compiler-supported segment predicates", () => {
    const builder = componentSource("segments/VisualSegmentBuilder.tsx");
    const catalog = componentSource("segments/PredicateRegistryCatalog.tsx");

    expect(builder).toContain("predicates.filter(isSupportedPredicate)");
    expect(builder.toLowerCase()).not.toContain("coming soon");
    expect(catalog).toContain("isSupported(p.compiler_status)");
    expect(catalog.toLowerCase()).not.toContain("coming soon");
  });

  it("offers only providers with wired suppression mirrors", () => {
    const mirror = componentSource("suppressions/MirrorFromEspModal.tsx");

    expect(mirror).toContain('value: "mailchimp"');
    expect(mirror).toContain('value: "sendgrid"');
    expect(mirror).not.toContain('value: "ses"');
    expect(mirror).not.toContain('value: "mailgun"');
    expect(mirror).not.toContain('value: "postmark"');
    expect(mirror.toLowerCase()).not.toContain("not yet supported");
  });

  it("does not expose the engine-driver AEO scaffold", () => {
    const app = componentSource("../App.tsx");
    const sidebar = componentSource("Sidebar.tsx");

    expect(app).not.toContain('case "aeoSensor"');
    expect(sidebar).not.toContain('navItem("aeoSensor"');
    expect(PERSISTENT_DESKTOP_SECTIONS).not.toContain("aeoSensor");
    expect(
      COMMAND_PALETTE_NAV_TARGETS.some(
        (target) => target.section === "aeoSensor",
      ),
    ).toBe(false);
    expect(capabilityForSection("aeoSensor").readiness).toBe("preview");
  });

  it("keeps the unmounted affiliate program qualification-only", () => {
    const page = componentSource("../pages/Affiliates.tsx");
    const workspace = componentSource(
      "affiliates/AffiliatesQualificationWorkspace.tsx",
    );
    const availability = componentSource(
      "../lib/affiliate-operational-availability.ts",
    );
    const combined = `${page}\n${workspace}\n${availability}`;

    expect(capabilityForSection("affiliates").readiness).toBe("read-only");
    expect(page).not.toContain("affiliatesAdminApi");
    expect(workspace).toContain("Release held");
    expect(availability.match(/AVAILABLE = false/g)).toHaveLength(5);
    expect(combined).not.toContain("/api/v1/admin/affiliates");
    expect(combined).not.toContain("/api/public/affiliates/");
    expect(combined).not.toContain("createPayout");
  });

  it("does not present reference collections as a live messaging runtime", () => {
    const collections = componentSource("Collections.tsx");
    const profile = componentSource("subscribers/SubscriberProfilePanel.tsx");
    const capability = capabilityForSection("collections");

    expect(capability.readiness).toBe("mixed");
    expect(capability.limitation).toContain("not connected");
    expect(collections).not.toContain(
      "personalization and automations read by key",
    );
    expect(profile).not.toContain("CollectionsLookupPanel");
  });
});
