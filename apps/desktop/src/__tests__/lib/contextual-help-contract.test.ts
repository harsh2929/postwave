import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("DUX-042 contextual help source contract", () => {
  it("constructs support context from allowlisted structural fields only", () => {
    const context = source("lib/contextual-help.ts");
    const launcher = source("lib/help-launcher.ts");

    expect(context).toContain("export interface ContextualHelpRequest");
    expect(context).toContain("errorCode?: string;");
    expect(context).toContain("incidentId?: string;");
    expect(context).not.toContain("resourceId?:");
    expect(context).not.toContain("query?:");
    expect(context).not.toContain("message?:");
    expect(context).toContain("SENSITIVE_CODE_RE");
    expect(context).toContain(
      "no identity, resource ID, content, or credentials",
    );
    expect(launcher).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(launcher).toContain("destination: Section | null");
  });

  it("places contextual self-service before the explicit support handoff", () => {
    const panel = source("components/tour/ContextualHelpPanel.tsx");
    const selfService = panel.indexOf("Try these first");
    const support = panel.indexOf("Still need help?");

    expect(selfService).toBeGreaterThan(0);
    expect(support).toBeGreaterThan(selfService);
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('aria-modal="false"');
    expect(panel).toContain('Move {side === "right" ? "left" : "right"}');
    expect(panel).toContain("Copy support context");
    expect(panel).toContain("Contact support");
    expect(panel).not.toContain('role="menu"');
  });

  it("routes crash and recovery support through the same contextual handoff", () => {
    const recovery = source("lib/desktop-recovery.ts");
    const errorScreen = source("components/ErrorScreen.tsx");
    const diagnostics = source("components/DesktopDiagnosticsService.tsx");
    const offline = source("components/OfflineBanner.tsx");

    expect(recovery).toContain("buildContextualSupportUrl");
    expect(recovery).toContain("getDesktopRoute().section");
    expect(recovery).toContain("getConnectivitySnapshot().reason");
    expect(errorScreen).toContain(
      'errorCode: incident?.errorCode ?? "RENDERER_FAILURE"',
    );
    expect(diagnostics).toContain(
      'errorCode: state.safeMode ? "SAFE_MODE" : "NATIVE_CRASH"',
    );
    expect(offline).toContain("requestContextualHelpOpen({");
    expect(offline).toContain("connectivitySupportErrorCode(");
  });
});
