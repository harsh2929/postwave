// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignTemplateDesignReview } from "@/app/(dashboard)/app/templates/_components/campaign-template-design-review";
import type {
  CampaignTemplateDesignDraft,
  CampaignTemplateDesignRevision,
  CampaignTemplateDesignStatus,
} from "@/lib/campaign-templates-api";

vi.mock("@/lib/forms-api", () => ({
  listLists: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/segments-api", () => ({
  listSegments: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/app/(dashboard)/app/templates/_components/template-preview", () => ({
  TemplatePreviewFrame: ({ title }: { title: string }) => (
    <div role="img" aria-label={title} />
  ),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const REVISION: CampaignTemplateDesignRevision = {
  id: "revision-1",
  draft_id: "design-1",
  revision: 1,
  operation: "initial",
  output: {
    name: "Generated weekly signal",
    subject: "The week in product",
    preview_text: "Three useful updates",
    body_html: "<h1>The week in product</h1>",
    variables: {},
    unresolved_variables: [],
    reference_template_ids: ["reference-1"],
    warnings: [],
  },
  output_hash: "a".repeat(64),
  validation: {
    status: "pass",
    checks: [
      {
        code: "required_sections",
        status: "pass",
        message: "All required sections are present.",
      },
    ],
  },
  warnings: [],
  created_at: "2026-08-20T09:00:00Z",
};

function design(
  status: CampaignTemplateDesignStatus,
): CampaignTemplateDesignDraft {
  const reviewable = ["ready", "saved", "campaign_created"].includes(status);
  return {
    id: "design-1",
    mode: "adapt",
    status,
    source_template_id: "reference-1",
    reference_template_ids: ["reference-1"],
    current_revision: reviewable ? 1 : 0,
    ...(reviewable ? { revision: REVISION } : {}),
    attempt_count: status === "failed" ? 2 : 1,
    ...(status === "failed"
      ? {
          last_error_code: "provider_unavailable",
          last_error_message: "The design provider did not respond.",
        }
      : {}),
    capabilities: {
      can_refine: reviewable,
      can_retry: status === "failed",
      can_save: reviewable,
      can_create_campaign: reviewable,
      can_archive: true,
    },
    recommended_action: status === "failed" ? "retry" : "review",
    expires_at: "2026-08-21T09:00:00Z",
    created_at: "2026-08-20T09:00:00Z",
    updated_at: "2026-08-20T09:01:00Z",
    request: {
      mode: "adapt",
      source_template_id: "reference-1",
      instructions: "Adapt this for a weekly product newsletter.",
    },
  };
}

function renderReview(
  status: CampaignTemplateDesignStatus,
  options: { working?: boolean; sourcePreview?: ReactNode } = {},
): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const current = design(status);
  act(() => {
    root.render(
      createElement(CampaignTemplateDesignReview, {
        design: current,
        revisions: current.revision ? [REVISION] : [],
        sourcePreview: options.sourcePreview,
        sourceName: "Inspiration",
        working: options.working ?? false,
        error: null,
        recoveryPersistenceAvailable: true,
        onError: vi.fn(),
        onRefine: vi.fn().mockResolvedValue(true),
        onRetry: vi.fn().mockResolvedValue(undefined),
        onRefresh: vi.fn().mockResolvedValue(undefined),
        onSaveExact: vi.fn().mockResolvedValue({ id: "template-1" }),
        onCreateCampaignExact: vi.fn().mockResolvedValue({ id: "campaign-1" }),
        onSaved: vi.fn(),
        onCampaignCreated: vi.fn(),
        onBack: vi.fn(),
        onDiscard: vi.fn(),
      }),
    );
  });
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("campaign template design review states", () => {
  it.each(["queued", "generating"] as const)(
    "renders %s as the one live processing state",
    (status) => {
      const root = renderReview(status, { working: true });
      try {
        const liveState = document.querySelector('[role="status"]');
        expect(liveState?.getAttribute("aria-live")).toBe("polite");
        expect(liveState?.getAttribute("aria-busy")).toBe("true");
        expect(liveState?.textContent).toContain("Building your newsletter");
        expect(liveState?.textContent).toContain("Attempt 1");
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("renders a failed attempt with its truthful retry and archive actions", () => {
    const root = renderReview("failed");
    try {
      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Design attempt failed");
      expect(alert?.textContent).toContain(
        "The design provider did not respond.",
      );
      expect(document.body.textContent).toContain("Discard attempt");
      expect(document.body.textContent).toContain("Edit brief");
      expect(document.body.textContent).toContain("Retry attempt");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders the ready review with all three comparison modes and exact-revision actions", async () => {
    const root = renderReview("ready", {
      sourcePreview: <div>Original inspiration</div>,
    });
    try {
      await act(async () => {
        await Promise.resolve();
      });
      const tabs = Array.from(
        document.querySelectorAll(
          '[role="tablist"][aria-label="Compare inspiration and result"] [role="tab"]',
        ),
      );
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
        "Your result",
        "Inspiration",
        "Side by side",
      ]);
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
      expect(document.body.textContent).toContain("Validation pass");
      expect(document.body.textContent).toContain(
        "Save this version as template",
      );
      expect(document.body.textContent).toContain("Create campaign draft");
    } finally {
      act(() => root.unmount());
    }
  });
});
