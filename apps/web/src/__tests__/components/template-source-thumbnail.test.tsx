// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// TMPL-A4. Every built-in starter card read "Preview unavailable": search
// results carry no body, and hosted preview images exist only for imported
// references, so an editable template's card had nothing to show although
// its detail page renders the design. The card now draws the template's own
// stored HTML, lazily, in the same network-silent sandbox the detail preview
// uses. These tests render the real gallery and read what a person sees.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateGallery } from "@/app/(dashboard)/app/templates/_components/template-gallery";
import { resetTemplateSourceThumbnailCache } from "@/app/(dashboard)/app/templates/_components/template-source-thumbnail";
import type { CampaignTemplateSummary } from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ get: vi.fn(), compile: vi.fn() }));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return { ...actual, getCampaignTemplate: mocks.get };
});

vi.mock("@/components/editor/compile-mjml", () => ({
  compileMjmlSource: mocks.compile,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/templates",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Cards come into view one observer callback at a time, as in a browser.
const observed: Array<{ node: Element; fire: () => void }> = [];

class FakeIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(node: Element) {
    observed.push({
      node,
      fire: () =>
        this.callback(
          [{ isIntersecting: true, target: node } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ),
    });
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}

const STARTER_HTML =
  '<!doctype html><html><head><title>x</title></head><body><h1>One link this week</h1><img src="https://tracker.example/pixel.gif"></body></html>';

function template(
  overrides: Partial<CampaignTemplateSummary> = {},
): CampaignTemplateSummary {
  return {
    id: "starter-one-link",
    name: "One-Link Roundup",
    subject: "One link",
    tags: [],
    goal: "newsletter",
    template_kind: "editable",
    // As normalizeSummary shapes a search row from the API.
    source_provider: "postwave",
    provider: "postwave",
    source: "postwave",
    etag: '"v1"',
    review_status: "approved",
    capabilities: {
      can_preview: true,
      can_use_directly: true,
      can_create_campaign: true,
      has_source_html: true,
      has_desktop_preview: true,
    },
    ...overrides,
  };
}

let root: Root | null = null;

function render(ui: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(ui));
}

function gallery(templates: CampaignTemplateSummary[]) {
  return (
    <TemplateGallery
      templates={templates}
      galleryPath="/app/templates"
      selected={new Set()}
      compareSelectedIds={new Set()}
      loading={false}
      loadingMore={false}
      onToggleFavorite={vi.fn()}
      onDuplicate={vi.fn()}
      onArchive={vi.fn()}
      onRestore={vi.fn()}
      onToggleSelect={vi.fn()}
      onToggleCompare={vi.fn()}
      onAddToCollection={vi.fn()}
    />
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function scrollAllIntoView() {
  await act(async () => {
    for (const entry of observed.splice(0)) entry.fire();
  });
  await settle();
}

beforeEach(() => {
  observed.length = 0;
  resetTemplateSourceThumbnailCache();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("gallery card thumbnails for editable templates", () => {
  it("draws a built-in starter from its own HTML instead of 'Preview unavailable'", async () => {
    mocks.get.mockResolvedValue({ ...template(), body_html: STARTER_HTML });
    render(gallery([template()]));

    // Nothing is fetched until the card nears the viewport.
    await settle();
    expect(mocks.get).not.toHaveBeenCalled();

    await scrollAllIntoView();
    expect(mocks.get).toHaveBeenCalledWith("starter-one-link");

    const thumbnail = document.querySelector(
      '[role="img"][aria-label="Preview of One-Link Roundup"]',
    );
    expect(thumbnail).not.toBeNull();
    const frame = thumbnail?.querySelector("iframe");
    expect(frame).not.toBeNull();
    // Sandboxed with no privileges, out of the tab order and the a11y tree.
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("tabindex")).toBe("-1");
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
    // Every built-in carries a phone stylesheet at max-width:620px; a frame
    // drawn narrower than that would show the phone layout on a desktop card.
    expect(Number.parseFloat(frame?.style.width ?? "0")).toBeGreaterThan(620);
    const doc = frame?.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("One link this week");
    // Network-silent: the tracking pixel can never load.
    expect(doc).toContain("default-src 'none'; img-src data: blob:");
    expect(document.body.textContent).not.toContain("Preview unavailable");
    // The provider badge reads as words, not the product's slug.
    expect(document.body.textContent).toContain("Built-in");
    expect(document.body.textContent).not.toMatch(/\bpostwave\b/i);
  });

  it("draws an MJML-only editable design in the card", async () => {
    const source = "<mjml><mj-body><mj-section><mj-column><mj-text>New design</mj-text></mj-column></mj-section></mj-body></mjml>";
    mocks.get.mockResolvedValue({ ...template(), body_html: "", body_mjml: source });
    mocks.compile.mockResolvedValue({ html: "<html><body>New design</body></html>", errors: [] });
    render(gallery([template({
      capabilities: {
        can_preview: true,
        can_use_directly: true,
        can_create_campaign: true,
        has_source_html: false,
        has_source_mjml: true,
      },
    })]));
    await scrollAllIntoView();

    expect(mocks.compile).toHaveBeenCalledWith(source);
    expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("New design");
    expect(document.body.textContent).toContain("Edit in blocks");
    expect(document.body.textContent).not.toContain("Preview unavailable");
  });

  it("labels a card by who made it: built-in, the workspace's own, or an outside catalogue", async () => {
    mocks.get.mockResolvedValue({ ...template(), body_html: STARTER_HTML });
    render(
      gallery([
        template(),
        // A design the workspace saved itself: source_provider defaults to
        // the product's slug for every row, so ownership is the tenant id.
        template({
          id: "workspace-design",
          name: "Our spring letter",
          tenant_id: "3f1f5f55-7c1a-4a55-9d2e-8f2f4d1b0c11",
        }),
        template({
          id: "rge-reference",
          name: "Borrowed layout",
          template_kind: "reference",
          provider: "reallygoodemails",
          source_provider: "reallygoodemails",
          source: "reallygoodemails",
        }),
      ]),
    );
    await settle();
    const badgesFor = (id: string) => {
      const card = document.getElementById(`campaign-template-card-${id}`);
      expect(card, id).toBeTruthy();
      return Array.from(card!.querySelectorAll(".absolute.left-3.top-3 > *")).map(
        (badge) => badge.textContent?.trim(),
      );
    };
    expect(badgesFor("starter-one-link")).toEqual(["Built-in"]);
    expect(badgesFor("workspace-design")).toEqual([]);
    expect(badgesFor("rge-reference")).toEqual(["Really Good Emails"]);
  });

  it("fetches each design once however often the gallery re-renders", async () => {
    mocks.get.mockResolvedValue({ ...template(), body_html: STARTER_HTML });
    render(gallery([template()]));
    await scrollAllIntoView();
    // A search refresh hands the card a new object for the same version.
    act(() => root?.render(gallery([{ ...template() }])));
    await scrollAllIntoView();
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("falls back to 'Preview unavailable' when the design cannot be loaded", async () => {
    mocks.get.mockRejectedValue(new Error("offline"));
    render(gallery([template()]));
    await scrollAllIntoView();
    expect(document.body.textContent).toContain("Preview unavailable");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("never fetches source for a reference; its card keeps the hosted-image path", async () => {
    render(
      gallery([
        template({
          id: "reference-one",
          name: "Reference one",
          template_kind: "reference",
          source_provider: "reallygoodemails",
          provider: "reallygoodemails",
          source: "reallygoodemails",
          capabilities: { can_preview: false, has_source_html: false },
        }),
      ]),
    );
    await scrollAllIntoView();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Preview unavailable");
    expect(document.body.textContent).toContain("Really Good Emails");
  });
});
