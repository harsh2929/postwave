// @vitest-environment happy-dom

import axe from "axe-core";
import { act, Fragment, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error -- the production inventory is an ESM audit script.
import { inventorySummary } from "../../../scripts/interactive-title-inventory.mjs";
import { ReviewCard } from "../../components/reviews/ReviewCard";
import { MarkdownNoteEditor } from "../../components/subscriber/MarkdownNoteEditor";
import { PreferencesPanel } from "../../components/subscribers/PreferencesPanel";
import { type Review, api } from "../../lib/api-client";
import { ReferralProgramOverview } from "../../pages/referrals/ReferralProgramOverview";
import type { ReferralProgramState } from "../../pages/referrals/useReferralProgramController";

const SCOPED_FILES = [
  "components/affiliates/AffiliatesQualificationWorkspace.tsx",
  "components/archive/PodcastTokensCard.tsx",
  "components/audiences/LookalikeModal.tsx",
  "components/referrals/PayoutChecklist.tsx",
  "components/reviews/ReviewCard.tsx",
  "components/subscriber/MarkdownNoteEditor.tsx",
  "components/subscriber/PIIFindingsPanel.tsx",
  "components/subscribers/AccountSection.tsx",
  "components/subscribers/ChannelConsentsPanel.tsx",
  "components/subscribers/DSARModal.tsx",
  "components/subscribers/DuplicatesModal.tsx",
  "components/subscribers/FrequencyPreferencePanel.tsx",
  "components/subscribers/LookalikeGeneratorModal.tsx",
  "components/subscribers/PreferencesPanel.tsx",
  "components/subscribers/SubscriberEmailsSection.tsx",
  "components/suppressions/BulkActionsMenu.tsx",
  "components/tags/TagGroupManageModal.tsx",
  "pages/referrals/ReferralProgramOverview.tsx",
] as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function referralState(): ReferralProgramState {
  return {
    empty: false,
    error: null,
    loading: false,
    program: {
      id: "program-1",
      active: true,
      updatedAt: "2026-07-16T09:00:00.000Z",
      milestones: [
        {
          count: 5,
          reward_label: "[swag] Hoodie",
          reward_kind: "swag",
        },
      ],
    },
  };
}

function approvedReview(): Review {
  return {
    id: "review-1",
    rating: 5,
    title: "Excellent",
    body: "Thoughtful review body",
    status: "approved",
    verified_buyer: true,
    incentivized: false,
    featured: false,
    reviewer_name: "Ari",
  };
}

describe("title maturity wave B", () => {
  it("keeps the assigned production inventory free of intrinsic interactive titles", () => {
    const summary = inventorySummary() as {
      findings: Array<{ file: string }>;
    };
    const findings = summary.findings.filter((finding) =>
      SCOPED_FILES.includes(finding.file as (typeof SCOPED_FILES)[number]),
    );
    expect(findings).toEqual([]);
  });

  it("keeps persistent blocks focusable, described, guarded, and axe-clean", async () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const unsubscribe = vi
      .spyOn(api, "unsubscribeFromTopic")
      .mockResolvedValue({ data: { ok: true } });
    const state = referralState();

    render(
      <Fragment>
        <MarkdownNoteEditor
          value=""
          onChange={vi.fn()}
          mentionCandidates={[]}
          ariaLabel="Operator note"
        />
        <PreferencesPanel
          email="subscriber@example.com"
          topics={[
            {
              topic_id: "topic-1",
              name: "Product news",
              slug: "product-news",
              description: "Major product updates",
              opted_in: true,
              default_opt_in: false,
              display_order: 1,
            },
          ]}
          canMutate={false}
        />
        <ReviewCard review={approvedReview()} canAdmin onOpen={vi.fn()} />
        <ReferralProgramOverview
          canMutate={false}
          milestones={state.program?.milestones ?? []}
          onCreate={vi.fn()}
          onEdit={onEdit}
          onRemove={onRemove}
          state={state}
        />
      </Fragment>,
    );

    const blocked = [
      button("Preview"),
      button("Opt out of Product news"),
      button("Edit milestone at 5 referrals"),
      button("Remove milestone at 5 referrals"),
    ];
    for (const control of blocked) {
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      const descriptionId = control.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      expect(
        document.getElementById(descriptionId ?? "")?.textContent,
      ).toBeTruthy();
      act(() => control.focus());
      expect(document.activeElement).toBe(control);
      act(() => control.click());
    }

    expect(unsubscribe).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
