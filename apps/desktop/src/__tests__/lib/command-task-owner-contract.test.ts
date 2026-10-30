import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), "src", path), "utf8");
}

describe("command task owner contract", () => {
  it("dispatches the five action rows through one typed registry", () => {
    const palette = source("components/CommandPalette.tsx");
    expect(palette).toContain("...DESKTOP_TASK_COMMANDS.map");
    expect(palette).toContain("desktopTaskIntentRoute(intent)");
    for (const legacyNavigation of [
      'label: "New campaign",',
      'label: "New form",',
      'label: "New list",',
      'label: "New template",',
      'label: "Import subscribers",',
    ]) {
      expect(palette).not.toContain(legacyNavigation);
    }
  });

  it("assigns activation and explicit consumption to every real owner", () => {
    const owners = {
      "new-campaign": [
        source("pages/campaigns/useCampaignsController.ts"),
        source("pages/campaigns/useCampaignCreation.ts"),
      ],
      "new-form": [source("pages/Forms.tsx")],
      "new-list": [source("pages/Lists.tsx")],
      "new-template": [source("pages/Templates.tsx")],
      "import-subscribers": [
        source("pages/subscribers/useSubscriberDeepLinks.ts"),
        source("pages/subscribers/SubscribersPageOverlays.tsx"),
      ],
    } as const;
    for (const [intent, files] of Object.entries(owners)) {
      const joined = files.join("\n");
      expect(joined).toContain(`intent: "${intent}"`);
      expect(joined).toContain(`consumeDesktopTaskIntent("${intent}")`);
    }
  });

  it("keeps exact first-focus targets inside each task body", () => {
    const targets = [
      [source("pages/campaigns/CampaignCreateOverlays.tsx"), 'title="New campaign"', 'id="cam-name"'],
      [source("pages/Forms.tsx"), 'title="New form"', 'id="form-create-name"'],
      [source("pages/Lists.tsx"), 'title="New list"', 'id="list-new-name"'],
      [source("components/templates/TemplateLibraryPrimitives.tsx"), 'title="New template"', 'id="tpl-new-name"'],
    ] as const;
    for (const [owner, title, target] of targets) {
      expect(owner.indexOf(title)).toBeGreaterThanOrEqual(0);
      expect(owner.indexOf(target)).toBeGreaterThan(owner.indexOf(title));
    }
    const importer = source("components/subscribers/ImportSubscribersWizard.tsx");
    expect(importer).toContain('<UploadStep file={file} onPick={() => void pickFile()}');
    const importSteps = source("components/subscribers/SubscriberImportSteps.tsx");
    expect(importSteps).toContain('file ? file.name : "Choose a subscriber CSV"');
    const modal = source("components/Modal.tsx");
    expect(modal).toContain('body?.querySelector<HTMLElement>(selector)');
    expect(modal).toContain("target.focus()");
  });
});
