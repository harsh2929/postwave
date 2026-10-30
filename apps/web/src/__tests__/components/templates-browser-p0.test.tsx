// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TemplatesBrowser as DeferredTemplatesBrowser,
  campaignTemplateLibraryUrlSchema,
  campaignTemplateSavedSearchUrlPatch,
} from "@/app/(dashboard)/app/templates/_components/browser";
import { TemplateGallery } from "@/app/(dashboard)/app/templates/_components/template-gallery";
import { VerifiedAuthScopeProvider } from "@/lib/auth-scope";
import { parseParams, serializeParamsString } from "@/lib/table-url-state";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  setState: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/templates",
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/use-table-url-state", () => ({
  useTableUrlState: () => ({
    state: {
      view: "inspiration",
      q: "",
      goal: "newsletter",
      category: "",
      style: "",
      industry: "",
      layout: "",
      source: "platform",
      provider: "",
      kind: "all",
      tag: "",
      featured: undefined,
      favorited: false,
      sort: "recommended",
      archived: "active",
    },
    setState: mocks.setState,
  }),
}));
vi.mock("@/lib/use-template-generation-availability", () => ({
  useTemplateGenerationAvailability: () => "unavailable",
}));

function TemplatesBrowser(
  props: ComponentProps<typeof DeferredTemplatesBrowser>,
) {
  return (
    <DeferredTemplatesBrowser {...props} galleryComponent={TemplateGallery} />
  );
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("Template browser P0 discovery", () => {
  it("renders the three friendly views and truthful reference capabilities", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          VerifiedAuthScopeProvider,
          {
            scope: {
              userId: "user-1",
              tenantId: "tenant-1",
              canWriteCampaigns: true,
            },
          },
          createElement(TemplatesBrowser, {
            initialResult: {
              items: [
                {
                  id: "reference-1",
                  name: "Editorial Signal",
                  subject: "Weekly signal",
                  tags: [],
                  template_kind: "reference",
                  review_status: "pending",
                  source_license_status: "personal-use-unreviewed",
                  thumbnail_url: "https://cdn.example.test/reference.png",
                },
              ],
              next_cursor: null,
              total: 1,
              facets: {},
            },
          }),
        ),
      );
    });

    try {
      await act(async () => {
        for (let index = 0; index < 3; index += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          await new Promise((resolve) => window.requestAnimationFrame(resolve));
        }
      });
      const tabs = Array.from(
        document.querySelectorAll('[role="tab"]'),
      ) as HTMLButtonElement[];
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        expect.stringContaining("Inspiration"),
        expect.stringContaining("My templates"),
        expect.stringContaining("Favorites"),
      ]);
      expect(document.querySelector('a[href="/app/templates/new?mode=import"]')?.textContent)
        .toContain("Import HTML/MJML");
      const advancedFilters = document.querySelector<HTMLElement>("#template-advanced-filters");
      expect(advancedFilters?.hidden).toBe(true);
      const moreFilters = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("More filters"),
      );
      expect(moreFilters).toBeTruthy();
      act(() => moreFilters?.click());
      expect(advancedFilters?.hidden).toBe(false);
      expect(tabs[0].getAttribute("aria-selected")).toBe("true");
      act(() => {
        tabs[0].focus();
        tabs[0].dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // My templates: yours, of every kind and goal.
      expect(mocks.setState).toHaveBeenCalledWith({
        view: "mine",
        source: "mine",
        kind: "all",
        favorited: false,
        goal: "",
        provider: "",
        archived: "active",
      });
      expect(document.activeElement).toBe(tabs[1]);

      expect(document.body.textContent).toContain("Visual inspiration");
      expect(document.body.textContent).toContain("Awaiting review");
      expect(
        Array.from(document.querySelectorAll("button"))
          .find((button) => button.textContent?.includes("Awaiting review"))
          ?.getAttribute("aria-disabled"),
      ).toBe("true");

      const selectLoaded = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Select 1 loaded"),
      );
      expect(selectLoaded).toBeTruthy();
      act(() => {
        selectLoaded?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      // The bulk bar is a deferred module; wait (bounded) for it to mount.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.body.textContent?.includes("1 selected")) break;
        await act(async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
      }
      expect(document.body.textContent).toContain("1 selected");
      expect(document.body.textContent).toContain("Deselect loaded");
    } finally {
      act(() => root.unmount());
    }
  });

  it("maps a saved definition without collapsing all, false, or kind", () => {
    const patch = campaignTemplateSavedSearchUrlPatch({
      q: "  weekly signal  ",
      source: "platform",
      provider: "postwave",
      kind: "editable",
      featured: false,
      favorited: false,
      archived: "all",
    });
    expect(patch).toEqual({
      q: "weekly signal",
      goal: "",
      category: "",
      style: "",
      industry: "",
      layout: "",
      source: "platform",
      provider: "postwave",
      kind: "editable",
      tag: "",
      featured: false,
      favorited: false,
      sort: "recommended",
      archived: "all",
    });

    const query = serializeParamsString(
      campaignTemplateLibraryUrlSchema,
      patch,
    );
    expect(query).toContain("kind=editable");
    expect(query).toContain("archived=all");
    expect(query).toContain("featured=false");
    expect(
      parseParams(
        campaignTemplateLibraryUrlSchema,
        new URLSearchParams(query).get.bind(new URLSearchParams(query)),
      ),
    ).toMatchObject({
      kind: "editable",
      archived: "all",
      featured: false,
      favorited: false,
    });
  });

  it("reads a provider saved into the ownership field as the provider it meant", () => {
    // The old Source dropdown wrote provider names into `source`, so saved
    // searches carry source="postwave". Replayed verbatim, that dropped the
    // tab's ownership scope and listed every platform starter under My
    // templates (TMPL-A2).
    const patch = campaignTemplateSavedSearchUrlPatch({
      source: "postwave",
      kind: "editable",
      favorited: false,
    });
    expect(patch.source).toBe("all");
    expect(patch.provider).toBe("postwave");
    expect(patch).not.toHaveProperty("view");

    const mine = campaignTemplateSavedSearchUrlPatch({ source: "mine" });
    expect(mine).toMatchObject({ view: "mine", source: "mine", provider: "" });
  });
});
