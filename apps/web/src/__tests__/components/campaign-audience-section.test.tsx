// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The campaign editor's audience picker offered segments only, defaulting to
// "Entire audience". A campaign that targeted a list — possible through the
// API, MCP and SDK — read "No segment selected - this campaign targets the
// entire eligible audience." while the checklist beneath it said a list was
// selected. Lists are now a first-class choice beside segments.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "11111111-2222-4333-8444-555555555555" }),
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: vi.fn().mockResolvedValue({
    user_id: "u1",
    tenant_id: "t1",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
  }),
  whoamiFresh: vi.fn(),
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("@/lib/api", () => ({
  api: { post: vi.fn() },
  apiErrorMessage: (_error: unknown, fallback = "Something went wrong") =>
    fallback,
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import {
  CampaignAudienceSection,
  type CampaignAudienceChoice,
} from "@/app/(dashboard)/app/campaigns/[id]/campaign-audience-section";
import type { AudienceList } from "@/lib/audience-admin-api";
import type { Segment } from "@/lib/segments-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

function list(id: number, name: string, mapped = true): AudienceList {
  return {
    id,
    ...(mapped
      ? {
          postwave_uuid: `63cd02b0-d61e-458b-bae2-2a8e067a7${String(id).padStart(3, "0")}`,
        }
      : {}),
    name,
    type: "private",
    optin: "single",
    tags: [],
    description: "",
  };
}

const SEGMENT: Segment = {
  id: "segment-1",
  tenantId: "t1",
  name: "VIPs",
  description: "",
  queryAst: {
    op: "condition",
    field: "email",
    comparator: "contains",
    value: "@",
  },
  lastCount: 42,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function mount(
  props: Partial<Parameters<typeof CampaignAudienceSection>[0]> & {
    audience: CampaignAudienceChoice;
  },
): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const ui: ReactNode = createElement(CampaignAudienceSection, {
    audienceCount: null,
    audienceCountError: null,
    audienceCountLoading: false,
    frozen: false,
    lists: [list(16, "Newsletter"), list(21, "Customers")],
    listsError: false,
    listsLoading: false,
    onAudienceChange: vi.fn(),
    onRetryLists: vi.fn(),
    onRetrySegments: vi.fn(),
    segments: [SEGMENT],
    segmentsError: false,
    segmentsLoading: false,
    ...props,
  });
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

function picker(): HTMLSelectElement {
  const select = document.getElementById("campaign-audience");
  if (!(select instanceof HTMLSelectElement))
    throw new Error("no audience picker");
  return select;
}

function selectedText(): string {
  const select = picker();
  return select.options[select.selectedIndex]?.textContent ?? "";
}

describe("campaign audience picker", () => {
  it("shows a list campaign as the list it sends to, with its count", () => {
    mount({
      audience: { list_id: "16", segment_id: "" },
      audienceCount: {
        base: 1204,
        excluded: 0,
        deliverable: 1204,
        kind: "list",
      },
    });

    expect(picker().value).toBe("list:16");
    expect(selectedText()).toBe("Newsletter");
    const text = document.body.textContent ?? "";
    expect(text).toContain("1,204 recipients will receive this.");
    expect(text).not.toMatch(
      /entire eligible audience|every contact in this workspace/i,
    );
    const listLink = [...document.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("View list"),
    );
    expect(listLink?.getAttribute("href")).toBe("/app/lists/16");
  });

  it("groups lists and segments under an accessible label", () => {
    mount({ audience: { list_id: "", segment_id: "" } });

    const label = document.querySelector('label[for="campaign-audience"]');
    expect(label?.textContent).toBe("Send to");
    const groups = [...picker().querySelectorAll("optgroup")].map(
      (g) => g.label,
    );
    expect(groups).toEqual(["Lists", "Segments"]);
    expect(selectedText()).toBe("Everyone eligible (no list or segment)");
    expect(picker().getAttribute("aria-describedby")).toBe(
      "campaign-audience-status",
    );
  });

  it("offers only this workspace's lists and never names the others", () => {
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [
        list(16, "Newsletter"),
        list(1, "Default list", false),
        list(7, "Another workspace's VIPs", false),
      ],
    });

    const lists = [...picker().options].filter((o) =>
      o.value.startsWith("list:"),
    );
    expect(lists.map((o) => [o.value, o.textContent, o.disabled])).toEqual([
      ["list:16", "Newsletter", false],
    ]);
    expect(document.body.textContent).not.toContain("Default list");
    expect(document.body.textContent).not.toContain("Another workspace's VIPs");
  });

  it("offers no lists, and says why, when the catalogue reports no workspace identities", () => {
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [list(16, "Newsletter", false), list(1, "Default list", false)],
    });

    expect(
      [...picker().options].filter((o) => o.value.startsWith("list:")),
    ).toEqual([]);
    expect(
      [...picker().querySelectorAll("optgroup")].map((g) => g.label),
    ).toEqual(["Segments"]);
    expect(document.body.textContent).not.toContain("Newsletter");
    expect(document.body.textContent).toContain(
      "No lists to choose from yet. Lists you create in this workspace can be used as audiences.",
    );
  });

  it("shows a saved list this workspace does not own without naming it", () => {
    mount({
      audience: { list_id: "1", segment_id: "" },
      lists: [list(16, "Newsletter"), list(1, "Default list", false)],
    });

    expect(picker().value).toBe("list:1");
    expect(selectedText()).toBe("The campaign's current list");
    expect(document.body.textContent).not.toContain("Default list");
  });

  it("keeps a saved list that the catalogue no longer shows, without printing its id", () => {
    mount({ audience: { list_id: "99", segment_id: "" } });

    expect(picker().value).toBe("list:99");
    expect(selectedText()).toBe("The campaign's current list");
    expect(selectedText()).not.toContain("99");
  });

  it("says why a picked list can't be counted", () => {
    mount({
      audience: { list_id: "16", segment_id: "" },
      audienceCountError:
        "The selected list isn't available as an audience in this workspace. Choose another list or segment.",
    });

    expect(
      document.getElementById("campaign-audience-status")?.textContent,
    ).toBe(
      "The selected list isn't available as an audience in this workspace. Choose another list or segment.",
    );
  });

  it("reports a failed list catalogue as a failure with a retry", () => {
    const onRetryLists = vi.fn();
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [],
      listsError: true,
      onRetryLists,
    });

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Lists couldn't be loaded");
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry lists",
    );
    act(() => retry?.click());
    expect(onRetryLists).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("No lists or segments yet");
  });

  it("explains what to do when there is nothing to target", () => {
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [],
      segments: [],
    });

    expect(document.body.textContent).toContain(
      "No lists or segments yet. Create a list or a segment to send to part of your audience.",
    );
  });

  it("does not claim the workspace is empty while segments are still loading", () => {
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [],
      segments: [],
      segmentsLoading: true,
    });

    expect(document.body.textContent).not.toContain("No lists or segments yet");
  });

  it("reports failed segments as a failure with a retry, not as none", () => {
    const onRetrySegments = vi.fn();
    mount({
      audience: { list_id: "", segment_id: "" },
      lists: [],
      segments: [],
      segmentsError: true,
      onRetrySegments,
    });

    const alerts = [...document.querySelectorAll('[role="alert"]')].map(
      (a) => a.textContent,
    );
    expect(alerts.some((t) => t?.includes("Segments couldn't be loaded"))).toBe(
      true,
    );
    const retry = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry segments",
    );
    act(() => retry?.click());
    expect(onRetrySegments).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("No lists or segments yet");
  });

  it("keeps a saved segment while segments load, without printing its id", () => {
    mount({
      audience: { list_id: "", segment_id: "segment-9" },
      segments: [],
      segmentsLoading: true,
    });

    expect(picker().value).toBe("segment:segment-9");
    expect(selectedText()).toBe("Loading segments…");
  });
});
