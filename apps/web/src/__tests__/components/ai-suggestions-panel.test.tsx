// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// AiSuggestionsPanel (SEG-037) had NEITHER a test of its own NOR a mounted
// page: the lazy `enabled: open && me.isFetched` gate, the four-way
// loading/error/empty/list chain, and the apply→navigate path were all
// unexercised.
//
// The panel takes no props, so "realistic data" means realistic API shapes:
// getAiSuggestions is stubbed with the recorded response shape
// (items/generated/notice), including one suggestion with no rationale so the
// optional branch renders too.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiSuggestionsPanel } from "@/components/segments/ai-suggestions-panel";
import { SegmentsList } from "@/app/(dashboard)/app/subscribers/segments/segments-list";

import { renderPage, stubFixtureTransport, unmount } from "../pages/_harness";

// Inlined rather than imported from the harness: vi.mock factories are hoisted
// above every import, and the auth-api factory below runs while the component
// module is being evaluated — before the harness module has initialised.
const mocks = vi.hoisted(() => ({
  whoami: vi.fn().mockResolvedValue({
    user_id: "u_test",
    tenant_id: "t_test",
    email: "qa@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  }),
  push: vi.fn(),
  getAiSuggestions: vi.fn(),
  createSegment: vi.fn(),
  listSegmentFolders: vi.fn(),
  listSegments: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/segments",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/segments-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/segments-api")>()),
  getAiSuggestions: mocks.getAiSuggestions,
  createSegment: mocks.createSegment,
  listSegmentFolders: mocks.listSegmentFolders,
  listSegments: mocks.listSegments,
}));

vi.mock("@/components/mailchimp-parity/audience-intelligence-panel", () => ({
  AudienceIntelligencePanel: () => null,
}));

const RESPONSE = {
  generated: "2026-08-21T09:00:00Z",
  notice: "Suggestions are generated from your own tenant data.",
  items: [
    {
      key: "lapsed_90d",
      name: "Lapsed buyers (90 days)",
      description: "Bought before, nothing in the last 90 days.",
      predicate_json: {
        type: "group" as const,
        op: "and" as const,
        children: [],
      },
      estimated_size: 12345,
      rationale: "Your repeat-purchase window closes around day 74.",
      category: "commerce",
    },
    {
      key: "highly_engaged",
      name: "Highly engaged",
      description: "Opened 5 of the last 6 campaigns.",
      predicate_json: {
        type: "group" as const,
        op: "and" as const,
        children: [],
      },
      estimated_size: 480,
      rationale: "",
      category: "",
    },
  ],
};

function disclosure(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-expanded]");
  if (!el) throw new Error("no disclosure button");
  return el;
}

function applyButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")].filter((b) =>
    /Use this segment|Applying/.test(b.textContent ?? ""),
  );
}

beforeEach(() => {
  stubFixtureTransport();
  // clearAllMocks() in afterEach strips the resolved values too.
  mocks.whoami.mockResolvedValue({
    user_id: "u_test",
    tenant_id: "t_test",
    email: "qa@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  });
  mocks.getAiSuggestions.mockResolvedValue(RESPONSE);
  mocks.createSegment.mockResolvedValue({ id: "seg_new" });
  mocks.listSegmentFolders.mockResolvedValue([]);
  mocks.listSegments.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("AiSuggestionsPanel", () => {
  it("starts collapsed and does not fetch until opened", async () => {
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      expect(container.textContent).toContain("Suggested segments");
      expect(disclosure(container).getAttribute("aria-expanded")).toBe("false");
      expect(disclosure(container).className).toContain("min-h-11");
      expect(disclosure(container).getAttribute("aria-controls")).toBeTruthy();
      expect(container.textContent).toContain("Show");
      expect(container.textContent).not.toContain("Lapsed buyers");
      // The whole point of `enabled: open && me.isFetched`.
      expect(mocks.getAiSuggestions).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("renders one card per suggestion once opened", async () => {
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      await act(async () => {
        disclosure(container).click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(mocks.getAiSuggestions).toHaveBeenCalledTimes(1);
      expect(disclosure(container).getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("Hide");

      const text = container.textContent ?? "";
      expect(text).toContain("Lapsed buyers (90 days)");
      expect(text).toContain("Bought before, nothing in the last 90 days.");
      expect(text).toContain("Highly engaged");
      // Size is locale-formatted, not raw.
      expect(text).toContain("~12,345 subscribers");
      expect(text).toContain("~480 subscribers");
      // Category chip renders for the one that has it, and not for the blank.
      expect(text).toContain("commerce");
      // Optional rationale renders only where present.
      expect(text).toContain(
        "Your repeat-purchase window closes around day 74.",
      );
      // The server-authored disclosure notice is rendered verbatim.
      expect(text).toContain(
        "Suggestions are generated from your own tenant data.",
      );

      expect(applyButtons(container)).toHaveLength(2);
      for (const button of applyButtons(container)) {
        expect(button.className).toContain("min-h-11");
      }
      const panelId = disclosure(container).getAttribute("aria-controls");
      expect(panelId ? document.getElementById(panelId) : null).toBeTruthy();
    } finally {
      unmount(root);
    }
  });

  it("gives mobile segment-name links a full touch target", async () => {
    const segment = {
      id: "segment-mobile-target",
      tenantId: "t_test",
      name: "Mobile target segment",
      description: "A deterministic saved audience.",
      queryAst: { op: "and" as const, children: [] },
      createdAt: "2026-08-21T09:00:00Z",
      updatedAt: "2026-08-21T09:00:00Z",
    };
    mocks.listSegments.mockResolvedValue([segment]);
    const { container, root } = await renderPage(SegmentsList, {
      initialSegments: [segment],
    });
    try {
      const link = Array.from(container.querySelectorAll("a")).find(
        (candidate) => candidate.textContent?.trim() === segment.name,
      );
      expect(link).toBeTruthy();
      expect(link?.className).toContain("min-h-11");
      expect(link?.className).toContain("focus-visible:ring-2");
    } finally {
      unmount(root);
    }
  });

  it("creates the segment from the suggestion and navigates to its editor", async () => {
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      await act(async () => {
        disclosure(container).click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      await act(async () => {
        applyButtons(container)[0].click();
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(mocks.createSegment).toHaveBeenCalledWith({
        name: "Lapsed buyers (90 days)",
        description: "Bought before, nothing in the last 90 days.",
        queryAst: RESPONSE.items[0].predicate_json,
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'Created "Lapsed buyers (90 days)" — review and save.',
      );
      expect(mocks.push).toHaveBeenCalledWith(
        "/app/subscribers/segments/seg_new/edit",
      );
    } finally {
      unmount(root);
    }
  });

  it("re-enables the buttons and toasts when apply fails", async () => {
    mocks.createSegment.mockRejectedValue(new Error("predicate rejected"));
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      await act(async () => {
        disclosure(container).click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      await act(async () => {
        applyButtons(container)[0].click();
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(mocks.toastError).toHaveBeenCalledWith("predicate rejected");
      expect(mocks.push).not.toHaveBeenCalled();
      // `setApplying(null)` in the catch is what makes the panel usable again.
      for (const b of applyButtons(container)) expect(b.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("shows the not-enough-signal copy for an empty item list", async () => {
    mocks.getAiSuggestions.mockResolvedValue({
      items: [],
      generated: "2026-08-21T09:00:00Z",
      notice: "n/a",
    });
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      await act(async () => {
        disclosure(container).click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.textContent).toContain("Not enough signal yet");
      expect(applyButtons(container)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("shows the unavailable copy when the suggestions request fails", async () => {
    mocks.getAiSuggestions.mockRejectedValue(new Error("503"));
    const { container, root } = await renderPage(AiSuggestionsPanel);
    try {
      await act(async () => {
        disclosure(container).click();
        await new Promise((r) => setTimeout(r, 0));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(container.textContent).toContain(
        "Suggestions aren't available right now.",
      );
      expect(container.textContent).not.toContain("Not enough signal");
    } finally {
      unmount(root);
    }
  });
});
