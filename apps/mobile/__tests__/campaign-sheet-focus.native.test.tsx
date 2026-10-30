/**
 * Return-focus wiring for the campaign detail sheets.
 *
 * WHAT THIS PINS, and why a unit test of the hook alone would not.
 * `KeyboardFormSheet` has accepted a `returnFocusRef` for a while, and it was
 * used by exactly one call site. The campaign detail screen — the densest
 * action surface in the app, up to eleven buttons in one wrapped row — passed
 * nothing, so every sheet dismissal dropped VoiceOver focus wherever the
 * platform chose and a blind operator re-swiped the whole screen to reach the
 * next action.
 *
 * The fix is a chain: the route owns the refs (`useSheetTriggerRefs`), the
 * action row binds one to each button that opens a sheet, and
 * `CampaignDetailModals` hands the ACTIVE one to the sheet. The failure mode
 * that chain invites is silent — someone adds a ninth button, forgets the ref,
 * and nothing breaks, renders differently, or types wrong. So the assertion
 * here is over the SET of sheet-opening buttons: a button that opens a sheet
 * without registering a trigger fails this test.
 *
 * It also asserts the refs are genuinely ATTACHED after render, because a
 * registry that hands out cells nobody binds would satisfy the first
 * assertion while restoring focus to null forever.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";

import { CampaignActionRow } from "@/components/campaigns/CampaignActionRow";
import type { CampaignSheet } from "@/components/campaigns/CampaignDetailModals";
import type { TriggerRef } from "@/hooks/useSheetTriggerRefs";

/**
 * Every sheet the action row can open. `previewAs` is deliberately absent —
 * its button lives in CampaignDetailContent's Preview header, not in this row.
 */
const ROW_SHEETS: readonly CampaignSheet[] = [
  "subject",
  "schedule",
  "test",
  "feedback",
  "saveTemplate",
  "send",
  "resend",
];

async function renderRowWithEveryActionAvailable() {
  const cells = new Map<CampaignSheet, TriggerRef>();
  const triggerRef = (sheet: CampaignSheet): TriggerRef => {
    const existing = cells.get(sheet);
    if (existing) return existing;
    const created: TriggerRef = { current: null };
    cells.set(sheet, created);
    return created;
  };
  const noop = jest.fn();
  await render(
    <CampaignActionRow
      canMutate
      canAdmin
      canEdit
      canSchedule
      canSend
      canTest
      canResend
      canDelete
      canViewAbResults
      lifecycleActions={["pause"]}
      lifecyclePending={false}
      lifecycleActionInFlight={null}
      deletePending={false}
      resendPending={false}
      clonePending={false}
      onEditSubject={noop}
      onOpenFeedback={noop}
      onSaveAsTemplate={noop}
      onSchedule={noop}
      onSendTest={noop}
      onViewAbResults={noop}
      onLifecycle={noop}
      onSend={noop}
      onResend={noop}
      onDelete={noop}
      onDuplicate={noop}
      triggerRef={triggerRef}
    />,
  );
  return cells;
}

describe("campaign action row — sheet return-focus refs", () => {
  it("registers a trigger ref for every button that opens a sheet", async () => {
    const cells = await renderRowWithEveryActionAvailable();
    expect([...cells.keys()].sort()).toEqual([...ROW_SHEETS].sort());
  });

  it("attaches each registered ref to a real mounted control", async () => {
    const cells = await renderRowWithEveryActionAvailable();
    const unattached = [...cells.entries()]
      .filter(([, ref]) => ref.current === null)
      .map(([sheet]) => sheet);
    // A registry that hands out cells nobody binds restores focus to nothing.
    expect(unattached).toEqual([]);
  });

  it("renders without a triggerRef at all — the prop is optional", async () => {
    const noop = jest.fn();
    await expect(
      render(
        <CampaignActionRow
          canMutate
          canAdmin={false}
          canEdit
          canSchedule={false}
          canSend={false}
          canTest={false}
          canResend={false}
          canDelete={false}
          canViewAbResults={false}
          lifecycleActions={[]}
          lifecyclePending={false}
          lifecycleActionInFlight={null}
          deletePending={false}
          resendPending={false}
          clonePending={false}
          onEditSubject={noop}
          onOpenFeedback={noop}
          onSaveAsTemplate={noop}
          onSchedule={noop}
          onSendTest={noop}
          onViewAbResults={noop}
          onLifecycle={noop}
          onSend={noop}
          onResend={noop}
          onDelete={noop}
          onDuplicate={noop}
        />,
      ),
    ).resolves.toBeDefined();
  });
});
