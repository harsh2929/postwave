// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// The audience section now carries the freeze-audience verb, which reads its
// campaign id from the route and its authority from whoami. Neither exists in
// a bare component render, so both are stubbed here; the assertions below are
// unchanged and still about the segment picker.
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
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import {
  CampaignAudienceSection,
  campaignAudienceStatusText,
} from "@/app/(dashboard)/app/campaigns/[id]/campaign-audience-section";
import { CampaignFieldsSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-fields-section";
import type { Campaign } from "@/lib/campaigns-api";
import type { Segment } from "@/lib/segments-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const baseCampaign: Campaign = {
  id: "campaign-1",
  tenant_id: "tenant-1",
  name: "Launch",
  subject: "Hello",
  status: "draft",
  campaign_type: "regular",
  editor_mode: "html",
  body_html: "<p>Hello</p>",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

const baseSegment: Segment = {
  id: "segment-1",
  tenantId: "tenant-1",
  name: "VIPs",
  description: "",
  queryAst: {
    op: "condition",
    field: "email",
    comparator: "contains",
    value: "@example.com",
  },
  lastCount: 1200,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement))
    throw new Error(`Input not found: ${id}`);
  return input;
}

function selectById(id: string): HTMLSelectElement {
  const select = document.getElementById(id);
  if (!(select instanceof HTMLSelectElement))
    throw new Error(`Select not found: ${id}`);
  return select;
}

function textareaById(id: string): HTMLTextAreaElement {
  const textarea = document.getElementById(id);
  if (!(textarea instanceof HTMLTextAreaElement))
    throw new Error(`Textarea not found: ${id}`);
  return textarea;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("campaign settings sections", () => {
  it("formats audience status copy for each audience kind", () => {
    const status = (
      audience: { list_id: string; segment_id: string },
      extra: Partial<Parameters<typeof campaignAudienceStatusText>[0]> = {},
    ) =>
      campaignAudienceStatusText({
        audience,
        audienceCount: null,
        countError: null,
        frozen: false,
        loading: false,
        ...extra,
      });
    expect(status({ list_id: "", segment_id: "" })).toBe(
      "Sends to every contact in this workspace who is subscribed and can receive email. The send review shows the exact count.",
    );
    expect(
      status({ list_id: "", segment_id: "segment-1" }, { loading: true }),
    ).toBe("Counting recipients…");
    expect(
      status(
        { list_id: "", segment_id: "segment-1" },
        {
          audienceCount: {
            base: 12,
            excluded: 2,
            deliverable: 1,
            kind: "segment",
          },
        },
      ),
    ).toBe("1 recipient will receive this.");
    expect(
      status(
        { list_id: "16", segment_id: "" },
        {
          audienceCount: {
            base: 1300,
            excluded: 100,
            deliverable: 1200,
            kind: "list",
          },
        },
      ),
    ).toBe("1,200 recipients will receive this.");
    expect(status({ list_id: "16", segment_id: "" })).toBe(
      "Recipient count unavailable for this list.",
    );
    expect(
      status(
        { list_id: "16", segment_id: "" },
        { countError: "The selected list isn't available." },
      ),
    ).toBe("The selected list isn't available.");
    expect(
      status({ list_id: "", segment_id: "segment-1" }, { frozen: true }),
    ).toBe(
      "This campaign sends to the audience snapshot taken when it was frozen.",
    );
  });

  it("routes audience choices through the caller as one list-or-segment edit", () => {
    const onAudienceChange =
      vi.fn<(audience: { list_id: string; segment_id: string }) => void>();
    const root = render(
      createElement(CampaignAudienceSection, {
        audience: { list_id: "", segment_id: baseSegment.id },
        audienceCount: {
          base: 10,
          excluded: 0,
          deliverable: 10,
          kind: "segment",
        },
        audienceCountError: null,
        audienceCountLoading: false,
        frozen: false,
        lists: [
          {
            id: 16,
            postwave_uuid: "63cd02b0-d61e-458b-bae2-2a8e067a71f0",
            name: "Newsletter",
            type: "private",
            optin: "single",
            tags: [],
            description: "",
          },
        ],
        listsError: false,
        listsLoading: false,
        onAudienceChange,
        onRetryLists: vi.fn(),
        onRetrySegments: vi.fn(),
        segmentsError: false,
        segmentsLoading: false,
        segments: [
          baseSegment,
          {
            ...baseSegment,
            id: "segment-2",
            name: "Recent buyers",
            lastCount: null,
          },
        ],
      }),
    );

    try {
      const select = selectById("campaign-audience");
      expect(select.value).toBe("segment:segment-1");
      expect(document.body.textContent).toContain("VIPs (1,200)");
      expect(document.body.textContent).toContain(
        "10 recipients will receive this.",
      );

      act(() => {
        changeSelect(select, "");
      });
      expect(onAudienceChange).toHaveBeenLastCalledWith({
        list_id: "",
        segment_id: "",
      });

      act(() => {
        changeSelect(select, "list:16");
      });
      expect(onAudienceChange).toHaveBeenLastCalledWith({
        list_id: "16",
        segment_id: "",
      });

      act(() => {
        changeSelect(select, "segment:segment-2");
      });
      expect(onAudienceChange).toHaveBeenLastCalledWith({
        list_id: "",
        segment_id: "segment-2",
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes campaign field and source-body edits through the caller", () => {
    const onFieldChange = vi.fn();
    const root = render(
      createElement(CampaignFieldsSection, {
        campaign: baseCampaign,
        editorMode: "html",
        onFieldChange,
      }),
    );

    try {
      act(() => {
        changeInput(inputById("campaign-name"), "Spring launch");
      });
      expect(onFieldChange).toHaveBeenLastCalledWith("name", "Spring launch");

      act(() => {
        changeSelect(selectById("campaign-type"), "ab_test");
      });
      expect(onFieldChange).toHaveBeenLastCalledWith(
        "campaign_type",
        "ab_test",
      );

      act(() => {
        changeSelect(selectById("editor-mode"), "mjml");
      });
      expect(onFieldChange).toHaveBeenLastCalledWith("editor_mode", "mjml");

      act(() => {
        changeTextarea(textareaById("campaign-html"), "<p>Updated</p>");
      });
      expect(onFieldChange).toHaveBeenLastCalledWith(
        "body_html",
        "<p>Updated</p>",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows only the active source editor for the selected editor mode", () => {
    const onFieldChange = vi.fn();
    const root = render(
      createElement(CampaignFieldsSection, {
        campaign: {
          ...baseCampaign,
          editor_mode: "plain_text",
          plain_text: "Plain body",
        },
        editorMode: "plain_text",
        onFieldChange,
      }),
    );

    try {
      expect(document.getElementById("campaign-html")).toBeNull();
      expect(textareaById("plain-text").value).toBe("Plain body");
      expect(document.getElementById("mjml-body")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("never exposes legacy body editors for a semantic campaign", () => {
    const onFieldChange = vi.fn();
    const root = render(
      createElement(CampaignFieldsSection, {
        campaign: {
          ...baseCampaign,
          source_mode: "semantic",
          content_schema_version: 2,
          content_blocks: [{ id: "title" }],
          fact_contract: {},
        },
        editorMode: "html",
        onFieldChange,
      }),
    );

    try {
      expect(selectById("editor-mode").disabled).toBe(true);
      expect(document.getElementById("campaign-html")).toBeNull();
      expect(document.getElementById("plain-text")).toBeNull();
      expect(document.getElementById("mjml-body")).toBeNull();
      expect(document.body.textContent).toContain("AST v2 source");
    } finally {
      act(() => root.unmount());
    }
  });
});
