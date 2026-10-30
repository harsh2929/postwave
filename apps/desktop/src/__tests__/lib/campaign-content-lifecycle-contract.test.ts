import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("campaign and content lifecycle source contract", () => {
  it("keeps exact request guards alive across unmount", () => {
    const operation = source("hooks/usePersistentLifecycleOperation.ts");

    expect(operation).toContain("useId()");
    expect(operation).toContain(
      "markLifecycleOperationRefRetained(promiseRef)",
    );
    expect(operation).toContain("if (promiseRef.current) return null");
    expect(operation).toContain("registerLifecycleGuard({");
    expect(operation).toContain('intent.disposition === "hide"');
    expect(operation).toMatch(
      /Do not\s*\/\/ unregister it merely because this renderer surface disappeared\./u,
    );
    expect(operation).toMatch(
      /tracked = source\.finally\(\(\) => \{[\s\S]*promiseRef\.current = null[\s\S]*unregister\(\)/u,
    );
  });

  it("owns campaign feedback, scheduling, calendar, and locale drafts without auto-submit", () => {
    const feedback = source("components/CampaignFeedback.tsx");
    const schedule = source(
      "components/campaigns/useCampaignScheduleController.ts",
    );
    const scheduleModal = source("components/CampaignDetailActionModals.tsx");
    const calendar = source("components/campaigns/CampaignCalendar.tsx");
    const translations = source(
      "components/campaigns/CampaignTranslationsPanel.tsx",
    );

    expect(feedback).toContain(
      "ownerId: `campaign-feedback-${String(campaignID)}`",
    );
    expect(feedback).toContain("usePersistentLifecycleOperation({");
    expect(feedback).toContain("useDiscardOnlyDraftLifecycle({");
    expect(feedback).toMatch(/submit[\s\S]*try \{[\s\S]*catch[\s\S]*finally/u);

    expect(schedule).toContain(
      'ownerId: `campaign-schedule-${String(id ?? "new")}`',
    );
    expect(scheduleModal).toContain('title="Discard this schedule?"');
    expect(schedule).toContain("useDiscardOnlyDraftLifecycle({");
    expect(schedule).toMatch(
      /const schedule = async[\s\S]*operation\.run[\s\S]*try \{[\s\S]*catch[\s\S]*finally/u,
    );

    expect(calendar).toContain("campaign-calendar-reschedule-${String(");
    expect(calendar).toContain('title="Discard this reschedule?"');
    expect(calendar).toContain("boolean | void | Promise<boolean | void>");
    expect(calendar).toContain("const succeeded = await runReschedule");

    expect(translations).toContain(
      "ownerId: `campaign-locale-translation-${String(campaignId)}`",
    );
    expect(translations).toContain(
      '"Discard this translation and edit another?"',
    );
    expect(translations).toMatch(
      /const save = async[\s\S]*operation\.run[\s\S]*try \{[\s\S]*catch[\s\S]*finally/u,
    );

    for (const item of [feedback, schedule, calendar, translations]) {
      expect(item).not.toContain("prepare:");
    }
    // The AI/body translation editor remains a separate existing owner.
    expect(translations).not.toContain("campaign-translations-editor");
  });

  it("owns UTM form/preview requests and intercepts local modal close", () => {
    const controller = source(
      "components/composer/useUTMTemplatesController.ts",
    );
    const panel = source("components/composer/UTMTemplatesPanel.tsx");

    expect(controller).toContain(
      "ownerId: `utm-templates-${String(campaignId)}`",
    );
    expect(controller).toContain("useDiscardOnlyDraftLifecycle({");
    expect(controller).toContain("if (operation.promiseRef.current)");
    expect(controller).toContain("setFormBaseline(form)");
    expect(controller).not.toContain("prepare:");
    expect(panel).toContain("if (controller.requestClose()) onClose()");
    expect(panel).toContain('title="Discard UTM template changes?"');
  });

  it("owns template and saved-block create drafts without duplicating detail ownership", () => {
    const templates = source("pages/Templates.tsx");

    expect(templates).toContain('ownerId: "template-create"');
    expect(templates).toContain('ownerId: "saved-block-create"');
    expect(templates).toContain('title="Discard this template?"');
    expect(templates).toContain('title="Discard this saved block?"');
    expect(templates).toContain(
      "const created = decodeCampaignTemplate(res.data)",
    );
    expect(templates).toContain("const createdId = created?.id");
    expect(templates).toContain("The template may have been created");
    expect(templates).toContain(
      "Refresh the library before trying again",
    );
    expect(templates).not.toContain("template-editor-");
  });

  it("owns sequence creation and AI drafting without duplicating canvas children", () => {
    const sequences = source("pages/Sequences.tsx");

    expect(sequences).toContain('ownerId: "sequence-create"');
    expect(sequences).toContain("useDiscardOnlyDraftLifecycle({");
    expect(sequences).toContain('title="Discard this sequence draft?"');
    expect(sequences).toMatch(
      /generateWithAi[\s\S]*operation\.run[\s\S]*try \{[\s\S]*catch[\s\S]*finally/u,
    );
    expect(sequences).not.toMatch(
      /sequence-(?:step|settings|trigger|canvas)-(?:draft|operation)/u,
    );
    expect(sequences).not.toContain("prepare:");
  });

  it("separates archive publish action ownership from deterministic issue settings", () => {
    const archive = source("pages/Archive.tsx");

    expect(archive).toContain('ownerId: "archive-publish"');
    expect(archive).toContain("useDiscardOnlyDraftLifecycle({");
    expect(archive).toContain('title="Discard this archive publish draft?"');
    expect(archive).toContain("ownerId: `archive-issue-${issue.slug}`");
    expect(archive).toContain("useExistingSettingLifecycle({");
    expect(archive).toContain('title="Discard archive issue changes?"');
    expect(archive).toContain("setBaseline(requested)");
    expect(archive).toMatch(
      /const actionReasons = archiveActionReasons\(\s*canMutate,\s*canUnpublish,\s*campaignId,\s*dirty,\s*\)/u,
    );
    expect(archive).toMatch(
      /aria-describedby=\{\s*reasons\.save\s*\?\s*"archive-save-availability"\s*:\s*undefined\s*\}/u,
    );
    expect(archive).toContain("disabled={busy}");
    expect(archive).toContain("if (!reasons.save) onSave()");
  });

  it("uses create-discard or acknowledged-baseline save for referral programs", () => {
    const program = source("pages/referrals/ProgramEditor.tsx");

    expect(program).toContain('ownerId: "referral-program-create"');
    expect(program).toContain("enabled: open && program === null");
    expect(program).toContain("useExistingSettingLifecycle({");
    expect(program).toContain("enabled: open && program !== null");
    expect(program).toContain('title="Discard referral program changes?"');
    expect(program).toContain("pickingRow >= 0");
    expect(program).toContain("setBaseline({");
    expect(program).not.toContain("prepare:");
  });
});
