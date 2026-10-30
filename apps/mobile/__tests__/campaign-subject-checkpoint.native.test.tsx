/**
 * The seam that makes ECO-03 fire on this app: CampaignSubjectModal is the only
 * place a phone holds an in-progress campaign draft, and it has to hand that
 * draft up to the route (which owns the checkpoint) and take one back when the
 * person resumes.
 *
 * Untested, a regression here is silent in the worst way: every unit below the
 * seam still passes, the banner still renders, and nothing is ever
 * checkpointed — which is indistinguishable from the feature not existing.
 *
 * MOVED FROM VITEST (was
 * src/components/campaigns/CampaignSubjectModal.checkpoint.test.tsx, which
 * never executed under any runner). The sheet reaches useCampaignIdentitySave
 * → store/auth → expo-secure-store → expo-modules-core, which throws
 * `__DEV__ is not defined` at import time under node vitest, so the file
 * failed to load and its seven assertions had never once run.
 *
 * Every one of them is preserved, and driven harder. The old file replaced
 * CampaignFieldInput with a host stub and called the `onChangeText` prop it
 * found; here the real field renders and typing goes through
 * fireEvent.changeText on the actual TextInput, so the label→field→state
 * chain is under test rather than assumed. The sheet's remaining heavy leaves
 * (the AI strip, the A/B axis, the inbox-row preview) stay stubbed by the
 * shared campaignSheetLeaves factory — what is under test is the state →
 * report wiring, not their rendering.
 *
 * The sheet is imported RELATIVELY, like campaign-subject-ab-axis: the config
 * maps `@/components/campaigns/*` to a null stub to keep route composition
 * cheap, and a stubbed sheet would make every assertion vacuous.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import type { CampaignFieldsDraft } from "@/lib/campaignFields";

/** The strip's transport. Stubbed so no test reaches the voice service. */
jest.mock("@/api/aiGenerate", () => ({
  streamAIGenerate: jest.fn(() => ({ abort: jest.fn() })),
}));

// One factory for the whole null-stubbed `@/components/campaigns/*` family —
// see the file for why two jest.mock() calls here would cancel each other out.
jest.mock("@/components/campaigns/CampaignFieldInput", () =>
  require("./mocks/campaignSheetLeaves.cjs"),
);

const { CampaignSubjectModal } =
  require("../src/components/campaigns/CampaignSubjectModal") as typeof import("../src/components/campaigns/CampaignSubjectModal");

const CAMPAIGN = {
  id: "cmp_1",
  name: "August newsletter",
  status: "draft",
  subject: "Saved subject",
  preview_text: "Saved preview",
  from_name: "Ada",
  reply_to: "ada@example.com",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-04T10:00:00Z",
} as Parameters<typeof CampaignSubjectModal>[0]["campaign"];

/** Everything the sheet has reported up, oldest first. */
let reported: (CampaignFieldsDraft | null)[];

function sheet(props: {
  visible: boolean;
  seed?: CampaignFieldsDraft | undefined;
}) {
  return (
    <CampaignSubjectModal
      visible={props.visible}
      onClose={() => undefined}
      campaign={CAMPAIGN}
      seed={props.seed}
      onDraftChange={(draft) => reported.push(draft)}
    />
  );
}

/** Type into the field labelled `label`, for real. */
async function type(label: string, value: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText(label), value);
}

function valueOf(label: string): string {
  return String(screen.getByLabelText(label).props.value);
}

/** Save is live exactly when there is unsaved work — the same bit, rendered. */
function saveIsOffered(): boolean {
  return screen.getByLabelText("Save").props.accessibilityState.disabled !==
    true;
}

beforeEach(() => {
  reported = [];
});

describe("reporting the in-progress draft up", () => {
  it("reports nothing while the sheet matches the saved record", async () => {
    await render(sheet({ visible: true }));
    expect(reported).toEqual([null]);
    // …and the button agrees there is nothing to save.
    expect(saveIsOffered()).toBe(false);
  });

  it("reports the draft once it holds unsaved work", async () => {
    await render(sheet({ visible: true }));
    await type("Subject line", "Half a thought");
    expect(reported.at(-1)).toEqual({
      subject: "Half a thought",
      previewText: "Saved preview",
      fromName: "Ada",
      replyTo: "ada@example.com",
    });
    expect(saveIsOffered()).toBe(true);
  });

  it("reports every editable field, not just the subject", async () => {
    await render(sheet({ visible: true }));
    await type("Reply-to", "someone-else@example.com");
    expect(reported.at(-1)).toMatchObject({
      replyTo: "someone-else@example.com",
    });
  });

  it("reports null again when the edit is typed back to the saved value", async () => {
    await render(sheet({ visible: true }));
    await type("Subject line", "Half a thought");
    expect(reported.at(-1)).not.toBeNull();
    await type("Subject line", "Saved subject");
    expect(reported.at(-1)).toBeNull();
    expect(saveIsOffered()).toBe(false);
  });

  it("reports null when the sheet closes, so a closed sheet holds nothing", async () => {
    const view = await render(sheet({ visible: true }));
    await type("Subject line", "Half a thought");
    expect(reported.at(-1)).not.toBeNull();
    await view.rerender(sheet({ visible: false }));
    expect(reported.at(-1)).toBeNull();
  });
});

describe("resuming a draft from another device", () => {
  it("opens with the resumed draft rather than the saved record", async () => {
    const view = await render(sheet({ visible: false, seed: undefined }));
    await view.rerender(
      sheet({
        visible: true,
        seed: {
          subject: "Half a thought",
          previewText: "…and the rest",
          fromName: "Ada",
          replyTo: "ada@example.com",
        },
      }),
    );
    expect(valueOf("Subject line")).toBe("Half a thought");
    expect(valueOf("Preview text")).toBe("…and the rest");
    // And it opens DIRTY: a resumed draft is unsaved work, so Save is live and
    // the checkpoint keeps being kept.
    expect(reported.at(-1)).toMatchObject({ subject: "Half a thought" });
    expect(saveIsOffered()).toBe(true);
  });

  it("starts from the saved record when nothing was resumed", async () => {
    const view = await render(sheet({ visible: false }));
    await view.rerender(sheet({ visible: true }));
    expect(valueOf("Subject line")).toBe("Saved subject");
    expect(valueOf("Reply-to")).toBe("ada@example.com");
    expect(reported.at(-1)).toBeNull();
  });
});
