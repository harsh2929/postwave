import { describe, expect, it } from "vitest";

import {
  resolveCapabilityAccess,
  type CapabilityAccessEnvironment,
} from "../../lib/capability-access";
import {
  capabilityForSection,
  DESKTOP_NAV_DOMAINS,
} from "../../lib/desktop-capabilities";
import { PERSISTENT_DESKTOP_SECTIONS } from "../../lib/desktop-routes";

const BASE: CapabilityAccessEnvironment = {
  role: "admin",
  roleStatus: "resolved",
  online: "online",
  audit: {
    loading: false,
    isAdmin: true,
    scopes: new Set(["admin"]),
    error: null,
  },
};

describe("desktop capability registry", () => {
  it("accounts for every persistent destination with one typed domain and policy", () => {
    expect(PERSISTENT_DESKTOP_SECTIONS).toHaveLength(54);
    const ids = new Set<string>();
    const domainCounts = new Map<string, number>();

    for (const section of PERSISTENT_DESKTOP_SECTIONS) {
      const capability = capabilityForSection(section);
      expect(capability.id).not.toBe("");
      expect(ids.has(capability.id)).toBe(false);
      ids.add(capability.id);
      expect(["cached", "retained-session", "online-required"]).toContain(
        capability.offline,
      );
      domainCounts.set(
        capability.domain,
        (domainCounts.get(capability.domain) ?? 0) + 1,
      );
      if (capability.readiness !== "operational") {
        expect(capability.limitation?.length).toBeGreaterThan(20);
      }
    }

    expect([...domainCounts.keys()].sort()).toEqual(
      DESKTOP_NAV_DOMAINS.map((domain) => domain.id).sort(),
    );
  });

  it("fails closed while role or audit access is unresolved, then explains denial", () => {
    expect(
      resolveCapabilityAccess("affiliates", {
        ...BASE,
        role: null,
        roleStatus: "loading",
      }),
    ).toMatchObject({ state: "loading", canEnter: false });
    const affiliateDenial = resolveCapabilityAccess("affiliates", {
      ...BASE,
      role: "editor",
    });
    expect(affiliateDenial).toMatchObject({
      state: "denied",
      canEnter: false,
    });
    expect(affiliateDenial).not.toHaveProperty("recoverySection");
    expect(
      resolveCapabilityAccess("audit", {
        ...BASE,
        audit: {
          loading: false,
          isAdmin: false,
          scopes: new Set(),
          error: null,
        },
      }),
    ).toMatchObject({ state: "denied", canEnter: false });
    expect(
      resolveCapabilityAccess("audit", {
        ...BASE,
        audit: {
          loading: false,
          isAdmin: true,
          scopes: new Set(),
          error: null,
        },
      }),
    ).toMatchObject({ state: "denied", canEnter: false });
    expect(
      resolveCapabilityAccess("audit", {
        ...BASE,
        audit: {
          loading: false,
          isAdmin: false,
          scopes: new Set(["audit:read"]),
          error: "Scope refresh failed",
        },
      }),
    ).toMatchObject({
      state: "denied",
      canEnter: false,
      label: "Access check unavailable",
    });
    expect(
      resolveCapabilityAccess("auditInvestigation", {
        ...BASE,
        audit: {
          loading: false,
          isAdmin: false,
          scopes: new Set(["audit:read"]),
          error: null,
        },
      }),
    ).toMatchObject({
      state: "denied",
      canEnter: false,
      recoverySection: "audit",
      reason: expect.stringContaining("audit:read_pii"),
    });
    expect(
      resolveCapabilityAccess("auditInvestigation", {
        ...BASE,
        audit: {
          loading: false,
          isAdmin: false,
          scopes: new Set(["audit:read", "audit:read_pii"]),
          error: null,
        },
      }),
    ).toMatchObject({ state: "available", canEnter: true });
  });

  it("keeps both webhook route aliases behind the same admin gate", () => {
    for (const section of ["webhooks", "outboundWebhooks"] as const) {
      expect(
        resolveCapabilityAccess(section, { ...BASE, role: "editor" }),
      ).toMatchObject({
        state: "denied",
        canEnter: false,
        recoverySection: "settings",
      });
      expect(resolveCapabilityAccess(section, BASE)).toMatchObject({
        state: "available",
        canEnter: true,
      });
    }
  });

  it("keeps the private SMS authority at an exact-admin mixed-readiness boundary", () => {
    for (const role of ["viewer", "editor"] as const) {
      expect(
        resolveCapabilityAccess("smsSuppressions", { ...BASE, role }),
      ).toMatchObject({ state: "denied", canEnter: false });
    }
    expect(resolveCapabilityAccess("smsSuppressions", BASE)).toMatchObject({
      state: "mixed",
      canEnter: true,
      reason: expect.stringContaining("Hosted carrier callbacks"),
    });
  });

  it("aligns Retention history with the server's admin-only read boundary", () => {
    for (const role of ["viewer", "editor"] as const) {
      const decision = resolveCapabilityAccess("retentionOffers", {
        ...BASE,
        role,
      });
      expect(decision).toMatchObject({
        state: "denied",
        canEnter: false,
      });
      expect(decision).not.toHaveProperty("recoverySection");
    }
    expect(resolveCapabilityAccess("retentionOffers", BASE)).toMatchObject({
      state: "read-only",
      canEnter: true,
      label: "Read only",
      reason: expect.stringContaining("Current stored offer rows"),
    });
  });

  it("admits viewers to Helpdesk's static catalog boundary", () => {
    expect(
      resolveCapabilityAccess("helpdesk", { ...BASE, role: "viewer" }),
    ).toMatchObject({ state: "mixed", canEnter: true });
  });

  it("distinguishes reviewed cached-offline paths from online-only routes", () => {
    expect(
      resolveCapabilityAccess("dashboard", { ...BASE, online: "offline" }),
    ).toMatchObject({ state: "limited-offline", canEnter: true });
    expect(
      resolveCapabilityAccess("campaigns", { ...BASE, online: "offline" }),
    ).toMatchObject({ state: "offline", canEnter: false });
    expect(
      resolveCapabilityAccess("audit", { ...BASE, online: "offline" }),
    ).toMatchObject({ state: "offline", canEnter: false });
  });

  it("keeps the built-in push registry exact-admin and independent of provider setup", () => {
    expect(
      resolveCapabilityAccess("pushSuppressions", BASE),
    ).toMatchObject({
      state: "mixed",
      canEnter: true,
      reason: expect.stringContaining("Customer dispatch is not enabled"),
    });
    expect(resolveCapabilityAccess("pushSuppressions", { ...BASE, role: "editor" }))
      .toMatchObject({ state: "denied", canEnter: false });
    expect(capabilityForSection("pushSuppressions")).toMatchObject({
      readiness: "mixed",
      entryRole: "admin",
    });
    expect(capabilityForSection("pushSuppressions")).not.toHaveProperty(
      "recoverySection",
    );
  });

  it("keeps server-observed plan and setup absence distinct from product readiness", () => {
    expect(
      resolveCapabilityAccess("commerce", {
        ...BASE,
        observation: {
          state: "plan-required",
          reason: "Upgrade required.",
          observedAt: 1,
        },
      }),
    ).toMatchObject({ state: "plan-required", canEnter: false });
    expect(resolveCapabilityAccess("discounts", BASE)).toMatchObject({
      state: "read-only",
      canEnter: true,
    });
    expect(resolveCapabilityAccess("integrations", BASE)).toMatchObject({
      state: "mixed",
      canEnter: true,
    });
    expect(resolveCapabilityAccess("automations", BASE)).toMatchObject({
      state: "mixed",
      canEnter: true,
      label: "Mixed readiness",
      reason: expect.stringContaining("live warehouse-trigger"),
      recoverySection: "integrations",
    });
    expect(resolveCapabilityAccess("templates", BASE)).toMatchObject({
      state: "mixed",
      canEnter: true,
      label: "Mixed readiness",
      reason: expect.stringContaining("review/promotion workflow"),
    });
    expect(
      resolveCapabilityAccess("agency", {
        ...BASE,
        observation: {
          state: "partial-plan-required",
          reason: "Sub-accounts require agency eligibility.",
          observedAt: 1,
        },
      }),
    ).toMatchObject({
      state: "partial-plan-required",
      canEnter: true,
      recoverySection: "settings",
    });
    expect(
      resolveCapabilityAccess("audienceSyncs", {
        ...BASE,
        observation: {
          state: "partial-not-configured",
          reason: "Webhook sync is not configured.",
          observedAt: 1,
        },
      }),
    ).toMatchObject({
      state: "partial-not-configured",
      canEnter: true,
      recoverySection: "integrations",
    });
  });
});
