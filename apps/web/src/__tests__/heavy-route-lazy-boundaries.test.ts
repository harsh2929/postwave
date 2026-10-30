// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

describe("heavy route lazy boundaries", () => {
  it("keeps closed template dialog implementations out of the list bundle", () => {
    const browser = source(
      "app/(dashboard)/app/templates/_components/browser.tsx",
    );
    const actions = source(
      "app/(dashboard)/app/templates/_components/deferred-template-actions.tsx",
    );

    expect(browser).not.toMatch(
      /^import .*from "\.\/generate-template-dialog";$/m,
    );
    expect(browser).not.toMatch(/^import .*from "\.\/template-actions";$/m);
    expect(browser).toContain('import("./generate-template-dialog")');
    expect(browser).toContain("generateActivated");
    expect(browser).toContain("canCreateTemplates && generateActivated");

    expect(actions).toContain('import dynamic from "next/dynamic"');
    expect(actions).toContain('import("./template-actions")');
    expect(actions.match(/ssr: false/g)).toHaveLength(2);
    expect(actions.match(/role="status"/g)).toHaveLength(2);
    expect(actions).toContain("activated ?");
    expect(actions).toContain('aria-haspopup="dialog"');
    expect(actions).toContain("onCloseAutoFocus");
  });

  it("imports subscriber panel implementations dynamically and mounts only the active URL tab", () => {
    const page = source("app/(dashboard)/app/subscribers/[id]/page.tsx");
    const panels = source(
      "app/(dashboard)/app/subscribers/[id]/subscriber-detail-panels.tsx",
    );
    const profilePanels = source(
      "app/(dashboard)/app/subscribers/[id]/_profile-panels.tsx",
    );
    const predictions = source(
      "app/(dashboard)/app/subscribers/[id]/_prediction-cards.tsx",
    );

    for (const modulePath of [
      "./_timeline",
      "./_identity-panel",
      "./_preferences-panel",
      "./_profile-panels",
    ]) {
      expect(page).not.toContain(`from "${modulePath}"`);
      expect(panels).toContain(`import("${modulePath}")`);
    }

    expect(page).toContain('import("./subscriber-detail-panels")');
    expect(page).not.toContain('from "./subscriber-detail-panels"');

    for (const tab of [
      "timeline",
      "profile",
      "lists",
      "engagement",
      "preferences",
      "notes",
      "consent",
      "audit",
    ]) {
      expect(panels).toContain(`tab === "${tab}"`);
    }
    expect(panels.match(/ssr: false/g)?.length).toBeGreaterThanOrEqual(8);
    expect(page).toContain('role="status"');

    // The summary stays separate from the monolithic tab module and is itself
    // a secondary async panel rather than part of the critical route graph.
    expect(page).not.toContain('from "./_prediction-cards"');
    expect(page).toContain('import("./_prediction-cards")');
    expect(profilePanels).not.toContain("export function PredictionCards");
    expect(predictions).toContain("export function PredictionCards");
  });

  it("keeps subscriber-list secondary analytics, admin tools, and closed forms off the critical graph", () => {
    const page = source("app/(dashboard)/app/subscribers/page.tsx");
    const header = source(
      "app/(dashboard)/app/subscribers/subscribers-header.tsx",
    );

    for (const modulePath of [
      "./subscribers-growth-trend",
      "./subscriber-bulk-audience-actions",
      "@/components/mailchimp-parity/audience-intelligence-panel",
    ]) {
      expect(page).not.toContain(`from "${modulePath}"`);
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page.match(/ssr: false/g)).toHaveLength(4);
    expect(page).toContain('role="status"');
    expect(page).toContain('import("./subscribers-table")');
    expect(page).not.toContain('from "./subscribers-table"');
    expect(page).toContain('from "./subscriber-list-controls"');
    expect(page.indexOf("<BulkActionBar")).toBeLessThan(
      page.indexOf("<SubscribersTable"),
    );

    expect(header).not.toMatch(
      /^import .*from "\.\/subscriber-header-dialogs";$/m,
    );
    expect(header).toContain('import("./subscriber-header-dialogs")');
    expect(header.match(/ssr: false/g)).toHaveLength(2);
    expect(header).toContain("pasteActivated ?");
    expect(header).toContain("createActivated ?");
    expect(header.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(header).toContain("onCloseAutoFocus");
  });

  it("loads segment intelligence separately from the primary saved-segment table", () => {
    const list = source(
      "app/(dashboard)/app/subscribers/segments/segments-list.tsx",
    );

    for (const modulePath of [
      "@/components/mailchimp-parity/audience-intelligence-panel",
      "@/components/segments/segment-parity-suite",
      "@/components/segments/ai-suggestions-panel",
    ]) {
      expect(list).not.toContain(`from "${modulePath}"`);
      expect(list).toContain(`import("${modulePath}")`);
    }
    expect(list.match(/ssr: false/g)).toHaveLength(3);
    expect(list).toContain("<SegmentsTable");
    expect(list).toContain('role="status"');
  });

  it("defers template personal-library, bulk, and use/adapt dialog implementations", () => {
    const browser = source(
      "app/(dashboard)/app/templates/_components/browser.tsx",
    );
    const detail = source("app/(dashboard)/app/templates/[id]/page.tsx");
    const preview = source(
      "app/(dashboard)/app/templates/[id]/preview/page.tsx",
    );

    expect(browser).not.toContain('from "./template-discovery-tools"');
    expect(browser).toContain('import("./template-discovery-tools")');
    expect(browser).toContain("selected.size > 0 ?");
    expect(browser).toContain("<LazyTemplateDiscoveryTools");
    expect(browser).toContain("<TemplatesBulkBar");
    expect(browser).toContain('import("./template-gallery")');
    expect(browser).not.toMatch(
      /^import (?!type ).*from "\.\/template-gallery";$/m,
    );
    expect(browser).toContain(
      "galleryComponent: GalleryComponent = LazyTemplateGallery",
    );
    expect(browser).toContain("<GalleryComponent");

    expect(detail).not.toContain('from "../_components/template-actions"');
    expect(detail).toContain("LazyAdaptTemplateAction");
    expect(detail).toContain("LazyUseTemplateAction");

    // The preview route is a server page, where a next/dynamic boundary stays
    // in the eager client graph; its header action therefore goes through a
    // client wrapper that owns the boundary, and the page imports neither the
    // dialog implementations nor the deferred-actions module directly.
    const headerAction = source(
      "app/(dashboard)/app/templates/_components/template-header-action-lazy.tsx",
    );
    expect(preview).not.toContain('from "../../_components/template-actions"');
    expect(preview).not.toContain(
      'from "../../_components/deferred-template-actions"',
    );
    expect(preview).toContain("<TemplateHeaderAction");
    expect(headerAction).toContain('import("./deferred-template-actions")');
    expect(headerAction).toContain("LazyAdaptTemplateAction");
    expect(headerAction).toContain("LazyUseTemplateAction");
  });

  it("does not mount the subscriber editor until its named trigger opens it", () => {
    const page = source("app/(dashboard)/app/subscribers/[id]/page.tsx");

    for (const modulePath of [
      "./_edit-dialog",
      "./_email-health-card",
      "./_prediction-cards",
    ]) {
      expect(page).not.toContain(`from "${modulePath}"`);
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page).toContain("editOpen && record && authority");
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain("editTriggerRef.current?.focus()");
  });

  it("keeps form editor canvases and inactive data panels out of the initial route graph", () => {
    const page = source("app/(dashboard)/app/forms/[id]/page.tsx");
    const panels = source("app/(dashboard)/app/forms/[id]/_editor-panels.tsx");
    const fallback = source(
      "app/(dashboard)/app/forms/[id]/_deferred-form-panel.tsx",
    );

    for (const modulePath of [
      "@/components/forms/form-builder",
      "@/components/forms/form-preview",
      "./_analytics-panel",
      "./_variants-panel",
      "./_activity-panel",
      "./_editor-panels",
      "@/components/forms/spam-protection-card",
      "./_edit-conflict-notice",
    ]) {
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(page).toContain(`import("${modulePath}")`);
    }
    // The 412 reload banner and its conflict predicate (forms-extras-api)
    // moved one level down into the deferred notice module; neither re-enters
    // the page statically.
    expect(page).not.toContain(
      "@/components/forms/edit-conflict-reload-banner",
    );
    expect(page).not.toContain("@/lib/forms-extras-api");
    const notice = source(
      "app/(dashboard)/app/forms/[id]/_edit-conflict-notice.tsx",
    );
    expect(notice).toContain(
      'from "@/components/forms/edit-conflict-reload-banner"',
    );
    expect(notice).toContain('from "@/lib/forms-extras-api"');
    // The Design/Settings tab bodies moved into their own deferred module; the
    // target-list picker and the Design tab's preview stay dynamic boundaries
    // there, one level below the page, and never re-enter the page statically.
    for (const modulePath of [
      "@/components/forms/form-preview",
      "./_list-picker",
    ]) {
      expect(panels).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(panels).toContain(`import("${modulePath}")`);
    }
    expect(page).not.toMatch(/^import .*from ["']\.\/_list-picker["'];$/m);

    expect(page.match(/ssr: false/g)).toHaveLength(9);
    expect(panels.match(/ssr: false/g)).toHaveLength(2);
    expect(page).toContain('activeTab === "analytics"');
    expect(page).toContain('activeTab === "variants"');
    expect(page).toContain('activeTab === "activity"');
    expect(fallback).toContain('role="status"');
    expect(fallback).toContain('aria-live="polite"');
  });

  it("defers landing-page preview, experiments, and audit history until their URL tab is active", () => {
    const page = source("app/(dashboard)/app/landing-pages/[id]/page.tsx");
    const listPage = source("app/(dashboard)/app/landing-pages/page.tsx");
    const history = source(
      "app/(dashboard)/app/landing-pages/[id]/history-tab.tsx",
    );
    const preview = source(
      "app/(dashboard)/app/landing-pages/[id]/preview-tab.tsx",
    );

    for (const modulePath of [
      "./preview-tab",
      "./variants-tab",
      "./history-tab",
      "./secondary-editor-tabs",
    ]) {
      expect(page).not.toMatch(
        new RegExp(`^import .*from ["']${modulePath}["'];$`, "m"),
      );
      expect(page).toContain(`import("${modulePath}")`);
    }
    expect(page).toContain('import("@/lib/voice-api")');
    expect(page).toContain('activeTab === "preview"');
    expect(page).toContain('activeTab === "variants"');
    expect(page).toContain('activeTab === "history"');
    expect(page).toContain('activeTab === "seo"');
    expect(page).toContain('activeTab === "settings"');
    expect(history).toContain("listAuditLog");
    expect(history).toContain("restoreVersion");
    expect(preview).toContain('sandbox=""');
    expect(preview).toContain('referrerPolicy="no-referrer"');

    expect(listPage).not.toContain(
      'from "@/components/mailchimp-parity/multi-channel-ops-panel"',
    );
    expect(listPage).toContain(
      'import("@/components/mailchimp-parity/multi-channel-ops-panel")',
    );
    expect(listPage).toContain("setOpsOpen(event.currentTarget.open)");
    expect(listPage).toContain("opsOpen ?");
  });
});
