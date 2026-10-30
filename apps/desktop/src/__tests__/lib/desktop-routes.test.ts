import { describe, expect, it } from "vitest";

import {
  capabilityForSection,
  DESKTOP_NAV_DOMAINS,
} from "../../lib/desktop-capabilities";
import {
  ALL_DESKTOP_SECTIONS,
  COMMAND_PALETTE_NAV_TARGETS,
  DESKTOP_ROUTE_META,
  PERSISTENT_DESKTOP_SECTIONS,
  routeCommandLabel,
  routeMetaForSection,
} from "../../lib/desktop-routes";

describe("desktop route manifest", () => {
  it("has unique section ids and command palette targets", () => {
    expect(new Set(ALL_DESKTOP_SECTIONS).size).toBe(
      ALL_DESKTOP_SECTIONS.length,
    );
    const commandSections = COMMAND_PALETTE_NAV_TARGETS.map(
      (target) => target.section,
    );
    expect(new Set(commandSections).size).toBe(commandSections.length);
  });

  it("keeps legacy duplicate destinations out of the command palette", () => {
    const commandSections = new Set<string>(
      COMMAND_PALETTE_NAV_TARGETS.map((target) => target.section),
    );
    expect(commandSections.has("webhooks")).toBe(true);
    expect(commandSections.has("outboundWebhooks")).toBe(false);
    expect(commandSections.has("compliance")).toBe(true);
    expect(commandSections.has("hipaa")).toBe(false);
    expect(routeCommandLabel("consent")).toBe("Consent");
    expect(routeMetaForSection("consent").title).toBe("Consent receipts");
    expect(routeMetaForSection("pushSuppressions")).toMatchObject({
      title: "Push suppressions",
      crumb: "Audience",
    });
  });

  it("covers representative sidebar, topbar, and routed sections", () => {
    for (const section of [
      "dashboard",
      "subscribers",
      "campaigns",
      "templates",
      "webhooks",
      "aiChangelog",
      "auditAlerts",
      "auditInvestigation",
      "settings",
    ] as const) {
      expect(DESKTOP_ROUTE_META[section]).toBeTruthy();
    }
  });

  it("uses the same exhaustive capability metadata for all persistent routes", () => {
    const domains = new Set(DESKTOP_NAV_DOMAINS.map((domain) => domain.id));
    const capabilityIds = new Set<string>();
    for (const section of PERSISTENT_DESKTOP_SECTIONS) {
      const capability = capabilityForSection(section);
      expect(domains.has(capability.domain)).toBe(true);
      expect(capabilityIds.has(capability.id)).toBe(false);
      capabilityIds.add(capability.id);
      if (capability.readiness !== "operational") {
        expect(capability.limitation).toBeTruthy();
      }
    }
    expect(capabilityIds.size).toBe(54);
  });
});
