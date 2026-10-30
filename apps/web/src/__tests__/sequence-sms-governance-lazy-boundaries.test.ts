// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(resolve(process.cwd(), "src", relative), "utf8");

describe("sequence and governance route lazy boundaries", () => {
  it("keeps sequence row mutations behind the first menu interaction", () => {
    const source = read(
      "app/(dashboard)/app/sequences/_components/row-actions.tsx",
    );
    expect(source).toContain('import("./row-actions-menu")');
    expect(source).toContain("if (activated)");
    expect(source).toContain("initialOpen");
    expect(source).not.toContain("archiveSequence");
  });

  it("splits the editor, performance, test-send, and closed A/B dialog from the sequence detail entry", () => {
    const source = read("app/(dashboard)/app/sequences/[id]/page.tsx");
    // The email step section (controls + body editor) is itself deferred from
    // the entry; the editor's own boundary now lives inside it.
    const emailStep = read(
      "app/(dashboard)/app/sequences/[id]/email-step-section.tsx",
    );
    expect(source).toContain('import("./email-step-section")');
    for (const modulePath of [
      "@/components/editor/editor-shell",
      "@/components/content-test-send-dialog",
      "./sequence-performance-panel",
      "./sequence-ab-variants-dialog",
      "./sequence-fidelity",
    ]) {
      expect(
        [source, emailStep].some((text) =>
          text.includes(`import("${modulePath}")`),
        ),
      ).toBe(true);
      for (const text of [source, emailStep]) {
        expect(text).not.toMatch(
          new RegExp(
            `^import [^;]+from "${modulePath.replaceAll("/", "\\/")}";`,
            "m",
          ),
        );
      }
    }
    expect(source).toContain("{abOpen ? (");
    expect(source).toContain("Loading fidelity details…");
    expect(source).toContain('role="status"');
  });

  it("loads protected Helpdesk queues only from the selected tab", () => {
    const source = read("app/(dashboard)/app/service-suite/page.tsx");
    expect(source).toContain('import("./service-suite-operations")');
    expect(source).toContain('section === "helpdesk"');
    expect(source).not.toContain(
      'import { ServiceSuiteOperations } from "./service-suite-operations"',
    );
  });

  it("defers Track raw-event and conversion clients until verified identity renders them", () => {
    const source = read("app/(dashboard)/app/track/page.tsx");
    for (const modulePath of [
      "./track-event-composer",
      "./track-event-browser",
      "./track-conversions-panel",
    ]) {
      expect(source).toContain(`import("${modulePath}")`);
      expect(source).not.toMatch(
        new RegExp(
          `^import [^;]+from "${modulePath.replaceAll("/", "\\/")}";`,
          "m",
        ),
      );
    }
    expect(source).toContain("TrackPanelFallback");
  });

  it("keeps audit governance clients and dialogs outside the audit entry graph", () => {
    const source = read("app/(dashboard)/app/settings/audit/page.tsx");
    expect(source).toContain(
      'import("@/components/settings/audit-views-access-panels")',
    );
    expect(source).toContain(
      'import("@/components/settings/audit-forensics-panel")',
    );
    expect(source).toContain(
      'import("@/components/settings/audit-chain-dialog")',
    );
    expect(source).toContain('import("./audit-detail-dialog")');
    expect(source).toContain("{detail ? (");
    expect(source).toContain("{chainRequestId ? (");
  });
});

describe("SMS route authority and interaction islands", () => {
  it("keeps the exact access gate eager and imports the workspace only after access succeeds", () => {
    const route = read("app/(dashboard)/app/sms/page.tsx");
    expect(route).toContain('import("./sms-workspace")');
    expect(route).toContain("canAccessSmsAdminSurface(me, role)");
    expect(route).toContain("if (!canAccess)");
    expect(route).toContain("<SmsAdminPage");
    expect(route).not.toContain("loadSmsPageData");
  });

  it("mounts the custom-template dialog only while its controlled editor is open", () => {
    const workspace = read("app/(dashboard)/app/sms/sms-workspace.tsx");
    expect(workspace).toContain('import("./sms-quick-reply-dialog")');
    expect(workspace).toContain("{quickReplyEditor ? (");
    expect(workspace).not.toContain('from "@/components/ui/dialog"');
  });
});
