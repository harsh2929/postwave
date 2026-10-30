// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignContentEditor } from "@/app/(dashboard)/app/campaigns/[id]/campaign-content-editor";

const api = vi.hoisted(() => ({
  listCompatResources: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: (
    _loader: unknown,
    options?: { loading?: () => React.ReactNode },
  ) => options?.loading ?? (() => null),
}));

vi.mock("@/lib/mailchimp-compat-api", () => ({
  convertVideoForEmail: vi.fn(),
  listCompatResources: api.listCompatResources,
  runInlineAI: vi.fn(),
}));

vi.mock(
  "@/app/(dashboard)/app/campaigns/[id]/campaign-content-blocks-section",
  () => ({ CampaignContentBlocksSection: () => null }),
);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  const attempts = { assets: 0, sections: 0 };
  api.listCompatResources.mockImplementation((resource: "assets" | "sections") => {
    attempts[resource] += 1;
    if (attempts[resource] === 1) {
      return Promise.reject(new Error(`${resource} unavailable`));
    }
    return Promise.resolve(
      resource === "assets"
        ? [
            {
              id: "asset-1",
              name: "Hero image",
              asset_type: "image",
              url: "https://assets.example/hero.png",
              alt_text: "Hero",
            },
          ]
        : [
            {
              id: "section-1",
              name: "Standard footer",
              category: "footer",
              html: "<footer>Footer</footer>",
              blocks: [],
            },
          ],
    );
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("campaign content editor resources", () => {
  it("does not represent failed resource reads as empty and retries each one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(CampaignContentEditor, {
          campaignId: "campaign-1",
          campaignName: "Launch",
          campaignSubject: "Hello",
          blocks: [],
          selectedSectionIds: [],
          onBlocksChange: vi.fn(),
          onReusableSectionIdsChange: vi.fn(),
        }),
      );
    });

    try {
      await waitFor(
        () => document.querySelectorAll('[role="alert"]').length === 2,
      );
      expect(document.body.textContent).toContain(
        "Could not load campaign assets.",
      );
      expect(document.body.textContent).toContain(
        "Could not load reusable sections.",
      );
      expect(document.body.textContent).not.toContain(
        "No campaign assets have been created yet.",
      );
      expect(document.body.textContent).not.toContain(
        "No reusable sections have been saved yet.",
      );

      const retries = Array.from(document.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retries).toHaveLength(2);
      await act(async () => {
        retries.forEach((button) => button.click());
        await Promise.resolve();
      });

      await waitFor(
        () =>
          document.body.textContent?.includes("Hero image") === true &&
          document.body.textContent?.includes("Standard footer") === true,
      );
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(api.listCompatResources).toHaveBeenCalledTimes(4);
    } finally {
      act(() => root.unmount());
    }
  });
});
