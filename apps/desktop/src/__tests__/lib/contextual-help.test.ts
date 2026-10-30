import { describe, expect, it } from "vitest";

import {
  buildContextualHelpSnapshot,
  buildContextualSupportText,
  buildContextualSupportUrl,
  contextualHelpGuide,
  contextualSelfServiceItems,
  connectivitySupportErrorCode,
  sanitizeContextualHelpRequest,
} from "../../lib/contextual-help";
import { ALL_DESKTOP_SECTIONS } from "../../lib/desktop-routes";

describe("contextual help privacy contract", () => {
  it("accepts only enumerated task and structural incident/error fields", () => {
    expect(
      sanitizeContextualHelpRequest({
        task: "edit",
        errorCode: "SAVE_FAILED",
        incidentId: "PW-20260716-A1B2C3D4E5",
        resourceId: "person@example.com",
        query: "password=private",
        detail: "customer content",
      }),
    ).toEqual({
      task: "edit",
      errorCode: "SAVE_FAILED",
      incidentId: "PW-20260716-A1B2C3D4E5",
    });

    expect(
      sanitizeContextualHelpRequest({
        task: "invented",
        errorCode: "SECRET_TOKEN",
        incidentId: "person@example.com",
      }),
    ).toEqual({});
  });

  it("builds bounded structural context for every declared desktop section", () => {
    expect(ALL_DESKTOP_SECTIONS.length).toBeGreaterThanOrEqual(58);
    for (const section of ALL_DESKTOP_SECTIONS) {
      const snapshot = buildContextualHelpSnapshot({
        section,
        connectivity: "online",
      });
      const guide = contextualHelpGuide(snapshot);
      const report = buildContextualSupportText(snapshot);

      expect(snapshot.destination).toBe(section);
      expect(snapshot.capabilityId.length).toBeGreaterThan(0);
      expect(guide.steps).toHaveLength(3);
      expect(report.length).toBeLessThan(1_024);
      expect(report).not.toContain("/app/");
      expect(report).not.toContain("resourceId");
    }
  });

  it("puts contextual self-service before availability and connection recovery", () => {
    const snapshot = buildContextualHelpSnapshot({
      section: "discounts",
      connectivity: "proxy-tls",
      request: { task: "recovery" },
    });

    expect(contextualSelfServiceItems(snapshot)).toMatchObject([
      { id: "guide" },
      {
        id: "connectivity",
        description: expect.stringContaining("network administrator"),
      },
      {
        id: "availability",
        description: expect.stringContaining("Historical"),
      },
    ]);
  });

  it("creates an HTTPS handoff with allowlisted structural fields only", () => {
    const snapshot = buildContextualHelpSnapshot({
      section: "subscribers",
      connectivity: "api-unavailable",
      request: {
        task: "sync",
        errorCode: "SYNC_FAILED",
        incidentId: "PW-20260716-A1B2C3D4E5",
      },
    });
    const value = buildContextualSupportUrl(
      "https://support.moosewave.com/contact?locale=en#private",
      snapshot,
    );
    const url = new URL(value!);

    expect(url.hash).toBe("");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      locale: "en",
      source: "desktop",
      destination: "subscribers",
      domain: "audience",
      readiness: "operational",
      connection: "api-unavailable",
      task: "sync",
      error_code: "SYNC_FAILED",
      incident_id: "PW-20260716-A1B2C3D4E5",
    });
    expect(value).not.toContain("@example.com");
    expect(value).not.toContain("resource");
  });

  it("rejects unsafe support endpoints", () => {
    const snapshot = buildContextualHelpSnapshot({
      section: "settings",
      connectivity: "online",
    });
    expect(
      buildContextualSupportUrl("http://support.moosewave.com", snapshot),
    ).toBeNull();
    expect(
      buildContextualSupportUrl(
        "https://user:password@support.moosewave.com",
        snapshot,
      ),
    ).toBeNull();
    expect(buildContextualSupportUrl("not a URL", snapshot)).toBeNull();
  });

  it("maps every connection failure to a non-sensitive structural code", () => {
    expect(connectivitySupportErrorCode("no-interface")).toBe("NO_INTERFACE");
    expect(connectivitySupportErrorCode("authentication")).toBe(
      "ACCESS_REQUIRED",
    );
    expect(connectivitySupportErrorCode("proxy-tls")).toBe("PROXY_TLS");
    expect(connectivitySupportErrorCode("online")).toBeNull();
    for (const reason of [
      "connecting",
      "no-interface",
      "internet-unavailable",
      "api-unavailable",
      "maintenance",
      "authentication",
      "captive-portal",
      "proxy-tls",
    ] as const) {
      const code = connectivitySupportErrorCode(reason);
      expect(code).toMatch(/^[A-Z][A-Z0-9_-]{0,31}$/u);
      expect(code).not.toMatch(/SECRET|TOKEN|PASSWORD|SESSION|AUTH/u);
    }
  });
});
