// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignTemplateReferencePicker } from "@/app/(dashboard)/app/templates/_components/campaign-template-reference-picker";
import type { CampaignTemplateSummary } from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return { ...actual, searchCampaignTemplates: mocks.search };
});

function template(
  id: string,
  name: string,
  canAdapt: boolean,
): CampaignTemplateSummary {
  return {
    id,
    name,
    subject: name,
    tags: [],
    template_kind: "reference",
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_adapt: canAdapt,
      can_use_directly: false,
      can_edit_directly: false,
      can_clone: false,
      can_create_campaign: false,
      can_delete: false,
      has_source_html: false,
      has_source_mjml: false,
      has_desktop_preview: true,
      has_mobile_preview: false,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("full-catalog campaign template reference picker", () => {
  it("searches the server catalogue and exposes only capability-eligible results", async () => {
    vi.useFakeTimers();
    mocks.search.mockResolvedValue({
      items: [
        template("eligible", "Eligible signal", true),
        template("pending", "Pending review", false),
      ],
      next_cursor: null,
      total: 2,
      facets: {},
    });
    const onChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(CampaignTemplateReferencePicker, {
          selected: [],
          onChange,
          initialTemplates: [template("loaded-only", "Loaded only", false)],
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({
        perPage: 40,
      }),
    );
    expect(document.body.textContent).toContain("Eligible signal");
    expect(document.body.textContent).not.toContain("Pending review");
    expect(document.body.textContent).not.toContain("Loaded only");

    act(() => {
      Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Eligible signal"))
        ?.click();
    });
    expect(onChange).toHaveBeenCalledWith(["eligible"]);

    act(() => root.unmount());
  });
});
