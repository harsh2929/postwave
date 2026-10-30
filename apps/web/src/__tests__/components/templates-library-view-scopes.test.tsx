// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TemplatesPage from "@/app/(dashboard)/app/templates/page";
import { TemplatesBrowser as DeferredTemplatesBrowser } from "@/app/(dashboard)/app/templates/_components/browser";
import { TemplateGallery } from "@/app/(dashboard)/app/templates/_components/template-gallery";
import {
  buildCampaignTemplateSearchPath,
  type CampaignTemplateSearchInput,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// TMPL-A / TMPL-A2. The gallery's default tab asked for kind=reference while
// every built-in starter is a platform *editable* template, so on every
// migrated database Inspiration and My templates both read "Showing 0 of 0".
// And the Source filter wrote provider names into the ownership parameter,
// widening My templates to all 29 platform starters. These tests drive the
// real page seed and browser and read the exact search requests they send.

const INSPIRATION_STATE = {
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
};

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setState: vi.fn(),
  search: vi.fn(),
  redirect: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/templates",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => mocks.searchParams,
  redirect: mocks.redirect,
}));

vi.mock("@/lib/use-table-url-state", () => ({
  useTableUrlState: () => ({ state: mocks.state, setState: mocks.setState }),
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return { ...actual, searchCampaignTemplates: mocks.search };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function TemplatesBrowser(
  props: ComponentProps<typeof DeferredTemplatesBrowser>,
) {
  return (
    <DeferredTemplatesBrowser {...props} galleryComponent={TemplateGallery} />
  );
}

function starter(slug: string, name: string): CampaignTemplateSummary {
  return {
    id: `${slug}-id`,
    name,
    subject: `${name} subject`,
    tags: [],
    goal: "newsletter",
    template_kind: "editable",
    source_provider: "postwave",
    review_status: "approved",
    source_license_status: "owned",
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_use_directly: true,
      can_create_campaign: true,
      can_clone: true,
      has_source_html: true,
      has_desktop_preview: true,
    },
  };
}

function searchResult(items: CampaignTemplateSummary[], facets = {}) {
  return { items, next_cursor: null, total: items.length, facets };
}

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  });
}

function lastRequest(): CampaignTemplateSearchInput {
  const call = mocks.search.mock.calls.at(-1);
  if (!call) throw new Error("no search request was sent");
  return call[0] as CampaignTemplateSearchInput;
}

function selectByLabel(label: string): HTMLSelectElement {
  const match = Array.from(document.querySelectorAll("label")).find((node) =>
    node.textContent?.trim().startsWith(label),
  );
  const select = match?.querySelector("select");
  if (!select) throw new Error(`select not found: ${label}`);
  return select;
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.state)) delete mocks.state[key];
  Object.assign(mocks.state, INSPIRATION_STATE);
  mocks.searchParams = new URLSearchParams();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("design library view scopes", () => {
  it("seeds the default page with the platform catalog, not kind=reference", async () => {
    mocks.search.mockResolvedValueOnce(
      searchResult([starter("newsletter-one-link", "One-Link Roundup")]),
    );
    await TemplatesPage({ searchParams: Promise.resolve({}) });

    expect(mocks.search).toHaveBeenCalledTimes(1);
    const seed = lastRequest();
    const path = buildCampaignTemplateSearchPath(seed);
    expect(path).toContain("source=platform");
    expect(path).toContain("goal=newsletter");
    expect(path).not.toContain("kind=");
  });

  it("reuses the server seed for the canonical Inspiration view and shows its starters", async () => {
    const items = [
      starter("newsletter-one-link", "One-Link Roundup"),
      starter("newsletter-weekly", "Stat-of-the-Week Dispatch"),
    ];
    const root = render(<TemplatesBrowser initialResult={searchResult(items)} />);
    try {
      await flush();
      // The client state equals the seed's scope, so there is no second fetch.
      expect(mocks.search).not.toHaveBeenCalled();
      const cards = Array.from(document.querySelectorAll('[role="article"]'));
      expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
        "One-Link Roundup",
        "Stat-of-the-Week Dispatch",
      ]);
      expect(document.body.textContent).toContain("Showing 2 of 2 designs");
      // A usable starter, not a disabled reference.
      expect(
        Array.from(cards[0].querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Use",
        ),
      ).toBe(true);
      expect(document.body.textContent).not.toContain(
        "Your design library is empty",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("reads an old Favorites link without a source as every starred template, not only built-ins", async () => {
    // Written when `source` defaulted to "all", so it was left out of the
    // URL; the schema now decodes a missing source as Inspiration's scope.
    mocks.searchParams = new URLSearchParams("view=favorites&favorited=true");
    Object.assign(mocks.state, {
      view: "favorites",
      favorited: true,
      goal: "",
      source: "platform",
    });
    mocks.search.mockResolvedValueOnce(searchResult([]));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([])} initialRequiresRefresh />,
    );
    try {
      await flush();
      const request = lastRequest();
      expect(request.favorited).toBe(true);
      expect(request.source ?? "all").toBe("all");
      expect(buildCampaignTemplateSearchPath(request)).not.toContain(
        "source=platform",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("asks My templates for your templates of every kind and goal", async () => {
    Object.assign(mocks.state, {
      view: "mine",
      source: "mine",
      kind: "all",
      goal: "",
    });
    mocks.search.mockResolvedValueOnce(searchResult([]));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([])} initialRequiresRefresh />,
    );
    try {
      await flush();
      const path = buildCampaignTemplateSearchPath(lastRequest());
      expect(path).toContain("source=mine");
      expect(path).not.toContain("kind=");
      expect(path).not.toContain("goal=");
      expect(document.body.textContent).toContain(
        "You haven’t made a template yet",
      );
      const browse = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Browse inspiration",
      );
      act(() => {
        browse?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(mocks.setState).toHaveBeenCalledWith({
        view: "inspiration",
        source: "platform",
        kind: "all",
        favorited: false,
        goal: "newsletter",
        provider: "",
        archived: "active",
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    ["mine", "mine"],
    ["inspiration", "platform"],
  ])(
    "keeps the %s tab's ownership scope when a source is chosen",
    async (view, source) => {
      Object.assign(mocks.state, {
        view,
        source,
        kind: "all",
        goal: view === "mine" ? "" : "newsletter",
      });
      mocks.search.mockResolvedValue(
        searchResult([starter("welcome-launch", "First-Sentence Welcome")], {
          providers: [
            { value: "postwave", count: 29 },
            { value: "reallygoodemails", count: 3 },
          ],
        }),
      );
      const root = render(
        <TemplatesBrowser initialResult={searchResult([])} initialRequiresRefresh />,
      );
      try {
        await flush();
        const sourceSelect = selectByLabel("Source");
        const labels = Array.from(sourceSelect.options).map((option) =>
          option.textContent?.trim(),
        );
        expect(labels).toEqual([
          "All sources",
          "Made in this app",
          "Really Good Emails",
        ]);
        choose(sourceSelect, "postwave");
        expect(mocks.setState).toHaveBeenLastCalledWith({ provider: "postwave" });

        // The URL now carries the provider; the next request keeps the tab's
        // ownership scope alongside it.
        Object.assign(mocks.state, { provider: "postwave" });
        act(() => {
          root.render(
            <TemplatesBrowser initialResult={searchResult([])} initialRequiresRefresh />,
          );
        });
        await flush();
        const path = buildCampaignTemplateSearchPath(lastRequest());
        expect(path).toContain(`source=${source}`);
        expect(path).toContain("provider=postwave");
      } finally {
        act(() => root.unmount());
      }
    },
  );
});
