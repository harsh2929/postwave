// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignFieldsSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-fields-section";
import type { Campaign } from "@/lib/campaigns-api";
import type { FromNamePickerResponse } from "@/lib/from-name-picker-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const campaign: Campaign = {
  id: "campaign-1",
  tenant_id: "tenant-1",
  name: "Launch",
  subject: "Hello",
  from_name: "Current sender",
  status: "draft",
  campaign_type: "regular",
  editor_mode: "html",
  body_html: "<p>Hello</p>",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
};

function response(count = 2): FromNamePickerResponse {
  return {
    window_days: 180,
    min_campaigns: 2,
    from_names: Array.from({ length: count }, (_, index) => ({
      from_name: `Sender ${index + 1}`,
      campaigns_using: index + 2,
      total_recipients: 1_000 - index,
      opens: 400,
      clicks: 50,
      complaints: 1,
      open_rate: 0.4 - index * 0.01,
      click_rate: 0.05,
      complaint_rate: 0.001,
      confidence: 0.75,
      rank: index + 1,
    })),
    count,
  };
}

function mount(
  fromNameSuggestions: NonNullable<
    Parameters<typeof CampaignFieldsSection>[0]["fromNameSuggestions"]
  >,
): {
  container: HTMLElement;
  onFieldChange: ReturnType<typeof vi.fn>;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onFieldChange = vi.fn();
  act(() => {
    root.render(
      createElement(CampaignFieldsSection, {
        campaign,
        editorMode: "html",
        fromNameSuggestions,
        onFieldChange,
      }),
    );
  });
  return { container, onFieldChange, root };
}

function button(container: HTMLElement, name: RegExp): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((item) =>
    name.test(item.textContent ?? ""),
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("campaign from-name performance suggestions", () => {
  it("renders bounded evidence and applies a suggestion only after activation", () => {
    const { container, onFieldChange, root } = mount({
      data: response(6),
      pending: false,
      error: false,
      retrying: false,
      onRetry: vi.fn(),
    });

    try {
      expect(container.textContent).toContain(
        "Top historical performers · 180-day window",
      );
      expect(container.textContent).toContain("Sender 5");
      expect(container.textContent).not.toContain("Sender 6");
      expect(onFieldChange).not.toHaveBeenCalled();

      const suggestion = button(container, /Sender 1/u);
      const descriptionId = suggestion.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      expect(document.getElementById(descriptionId ?? "")?.textContent).toMatch(
        /open rate.*click rate.*campaigns.*confidence.*apply this from name/isu,
      );

      act(() => suggestion.click());
      expect(onFieldChange).toHaveBeenCalledWith("from_name", "Sender 1");
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes loading from a verified empty result", () => {
    const loading = mount({
      pending: true,
      error: false,
      retrying: false,
      onRetry: vi.fn(),
    });
    try {
      expect(
        loading.container.querySelector(
          '[role="status"][aria-label="Loading from-name suggestions"]',
        ),
      ).not.toBeNull();
    } finally {
      act(() => loading.root.unmount());
    }

    const empty = mount({
      data: response(0),
      pending: false,
      error: false,
      retrying: false,
      onRetry: vi.fn(),
    });
    try {
      expect(empty.container.textContent).not.toContain(
        "Top historical performers",
      );
      expect(empty.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => empty.root.unmount());
    }
  });

  it("renders a retryable read failure without mutating the draft", () => {
    const onRetry = vi.fn();
    const { container, onFieldChange, root } = mount({
      pending: false,
      error: true,
      retrying: false,
      onRetry,
    });

    try {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Historical from-name performance could not be loaded.",
      );
      act(() => button(container, /^Retry$/u).click());
      expect(onRetry).toHaveBeenCalledOnce();
      expect(onFieldChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
