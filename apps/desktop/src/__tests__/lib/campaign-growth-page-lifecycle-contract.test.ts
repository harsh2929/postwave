import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const source = (path: string): string =>
  readFileSync(resolve(ROOT, path), "utf8");

const controllerOwners = [
  "components/forms/GrowthPanel.tsx",
  "components/forms/LandingPagesSection.tsx",
  "components/forms/SocialCaptureSection.tsx",
  "components/forms/VariantsPanel.tsx",
  "components/feedsources/FeedSourceFormModal.tsx",
  "pages/Lists.tsx",
] as const;

describe("campaign, growth, and page lifecycle source contract", () => {
  it.each(controllerOwners)(
    "registers managed draft ownership in %s",
    (path) => {
      const component = source(path);
      expect(component).toContain("useDraftLifecycleController");
      expect(component).toContain("discardConfirmOpen");
    },
  );

  it("keeps tag create and edit drafts under explicit lifecycle ownership", () => {
    const create = source("pages/tags/useTagCreate.ts");
    const edit = source("pages/tags/useTagEdit.ts");
    const overlays = source("pages/tags/TagOverlays.tsx");
    expect(create).toContain("useDraftLifecycleController");
    expect(create).toContain('mode: "create"');
    expect(edit).toContain("useDraftLifecycleController");
    expect(edit).toContain('mode: "edit"');
    expect(overlays).toContain("discardConfirmOpen");
  });

  it("distinguishes discard-only creates/actions from acknowledged edits", () => {
    for (const path of [
      "components/forms/LandingPagesSection.tsx",
      "components/forms/VariantsPanel.tsx",
      "components/feedsources/FeedSourceFormModal.tsx",
      "pages/Lists.tsx",
    ]) {
      const component = source(path);
      expect(component).toContain('"create"');
      expect(component).toContain('"edit"');
    }
    const tags = `${source("pages/tags/useTagCreate.ts")}\n${source(
      "pages/tags/useTagEdit.ts",
    )}`;
    expect(tags).toContain('mode: "create"');
    expect(tags).toContain('mode: "edit"');
    expect(source("components/forms/SocialCaptureSection.tsx")).toContain(
      'mode: "create"',
    );
  });

  it("retains accepted mutations beyond unmount through single-flight owners", () => {
    for (const path of [
      "components/forms/LandingPagesSection.tsx",
      "components/forms/VariantsPanel.tsx",
      "pages/Lists.tsx",
      "pages/tags/useTagDelete.ts",
    ]) {
      expect(source(path)).toContain("useSingleFlightOperation");
    }
  });

  it("keeps growth tab drafts mounted and makes panel close explicit", () => {
    const growth = source("components/forms/GrowthPanel.tsx");
    const social = source("components/forms/SocialCaptureSection.tsx");
    expect(growth).toContain('tabs.getPanelProps("targeting")');
    expect(growth).toContain('tabs.getPanelProps("experiments")');
    expect(growth).toContain('activation: "manual"');
    expect(growth).toContain('title="Discard onsite-growth changes?"');
    expect(growth).toContain("editorOpen={draft !== null}");
    expect(growth).toContain(
      "const key = draftBaseline?.key || draft.key.trim()",
    );
    expect(growth).toContain('existingKey={draftBaseline?.key ?? ""}');
    expect(growth).toContain("disabled={Boolean(existingKey)}");
    expect(social).toContain('tabs.getPanelProps("rules")');
    expect(social).toContain('tabs.getPanelProps("taptotext")');
    expect(social).toContain('activation: "manual"');
  });

  it("blocks silent editor replacement and retries only failed bulk deletes", () => {
    const variants = source("components/forms/VariantsPanel.tsx");
    const tags = source("pages/tags/useTagDelete.ts");
    expect(variants).toContain("editorOpen={draft !== null}");
    expect(variants).toContain(
      "const actionUnavailable = editorOpen || busyId !== null",
    );
    expect(variants).toContain(
      "aria-disabled={actionUnavailable || undefined}",
    );
    expect(variants).toContain("if (actionUnavailable) return");
    expect(tags).toContain(
      "setSelected(new Set(failures.map((failure) => failure.id)))",
    );
  });

  it("keeps gift history inspection-only without reviving mutable commerce controls", () => {
    const gift = source("pages/GiftSubscriptions.tsx");
    const workspace = source("components/gifts/GiftHistoryWorkspace.tsx");
    const transport = source("lib/api/monetization.ts");

    expect(gift).toContain(
      "Creation, cancellation, editing, payment handoff, redemption",
    );
    expect(workspace).toContain("Identity-minimized");
    expect(`${gift}\n${workspace}\n${transport}`).not.toMatch(
      /useShownOnceSecretLifecycle|giftIssuance|gift-subscription-create-draft|paid-subscription-create|createGiftSubscription|cancelGiftSubscription|updateGiftSubscription|stripe_payment_url|redemption_url/u,
    );
  });
});
