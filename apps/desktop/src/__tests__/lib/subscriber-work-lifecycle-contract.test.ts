import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("subscriber-work lifecycle source contract", () => {
  it("aggregates destination, write-back, and lookalike create drafts", () => {
    const destination = source("components/AudienceDestinationModal.tsx");
    const auth = source("components/AudienceDestinationAuthFlow.tsx");
    const writeback = source("components/WritebackTargetsSection.tsx");
    const segmentLookalike = source("components/audiences/LookalikeModal.tsx");
    const subscriberLookalike = source(
      "components/subscribers/LookalikeGeneratorModal.tsx",
    );

    expect(destination).toContain("useDiscardOnlyDraftLifecycle({");
    expect(destination).toContain("useExistingSettingLifecycle({");
    expect(destination).toContain("runOperation={operation.run}");
    expect(auth).toContain("runOperation?: <T>");
    expect(auth).not.toContain("registerLifecycleGuard");
    for (const item of [writeback, segmentLookalike, subscriberLookalike]) {
      expect(item).toContain("usePersistentLifecycleOperation({");
      expect(item).toContain("useDiscardOnlyDraftLifecycle({");
      expect(item).not.toContain("prepare:");
    }
  });

  it("aggregates both segment builders and protects folder/save-current drafts", () => {
    const natural = source("components/segments/NaturalLanguageBuilder.tsx");
    const visual = source("components/segments/VisualSegmentBuilder.tsx");
    const folders = source("components/segments/useSavedSegmentsController.ts");
    const saveCurrent = source(
      "pages/subscribers/useSaveCurrentSubscriberSegment.ts",
    );
    const holdout = source("components/segments/SegmentHoldoutConfigModal.tsx");

    expect(natural).toContain("onDirtyChange={setVisualDirty}");
    expect(natural).toContain("useDiscardOnlyDraftLifecycle({");
    expect(visual).toContain("onDirtyChangeRef.current?.(visualDirty)");
    expect(visual).not.toContain("registerLifecycleGuard");
    expect(folders).toContain('ownerId: "saved-segment-folder-create"');
    expect(folders).toContain("useExistingSettingLifecycle({");
    expect(saveCurrent).toContain('ownerId: "subscriber-save-current-segment"');
    expect(saveCurrent).not.toContain("useExistingSettingLifecycle");
    expect(holdout).toContain("useDiscardOnlyDraftLifecycle({");
  });

  it("uses acknowledged settings and split create/edit semantics for list tabs", () => {
    const members = source("components/lists/tabs/MembersTab.tsx");
    const mergeFields = source("components/lists/tabs/MergeFieldsTab.tsx");
    const settings = source("components/lists/tabs/SettingsTab.tsx");
    const webhooks = source("components/lists/tabs/WebhooksTab.tsx");
    const listDetail = source("components/lists/ListDetailSlideover.tsx");

    expect(members).toContain("useDiscardOnlyDraftLifecycle({");
    expect(members).toContain('title="Discard member selection?"');
    expect(mergeFields).toContain("useDiscardOnlyDraftLifecycle({");
    expect(mergeFields).toContain("useExistingSettingLifecycle({");
    expect(settings).toContain("baselineRef.current = acknowledged");
    expect(settings).toContain("useExistingSettingLifecycle({");
    expect(settings).toContain("onDraftStateChange?.({");
    expect(listDetail).toContain("useListLocalDraftTransitions({");
    expect(listDetail).toContain('title="Discard list settings changes?"');
    expect(webhooks).toContain("useDiscardOnlyDraftLifecycle({");
    expect(webhooks).toContain('title="Discard webhook draft?"');
    for (const item of [members, mergeFields, settings, webhooks]) {
      expect(item).toContain("usePersistentLifecycleOperation({");
    }
  });
});
