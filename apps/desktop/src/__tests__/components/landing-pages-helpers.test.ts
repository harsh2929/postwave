// Tests for the pure landing-pages logic behind the Forms page's
// Landing pages section (landingpages — pages render in apps/web at
// /landing/[slug], never on the API host).

import { describe, expect, it } from "vitest";

import {
  blocksSummary,
  buildLandingPageInput,
  landingPageToDraft,
  landingPageUrl,
  landingStatusTone,
  newLandingPageDraft,
  slugifyPageName,
  sortLandingPages,
  statusAction,
} from "../../components/forms/landing-pages-helpers";
import type { LandingPage } from "../../lib/api-client";

const page = (over: Partial<LandingPage> = {}): LandingPage => ({
  id: "p1",
  tenant_id: "t1",
  slug: "spring-promo",
  name: "Spring promo",
  status: "draft",
  template: "",
  blocks: [],
  seo: {},
  tracking: {},
  metrics: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  ...over,
});

describe("slugifyPageName", () => {
  it("lowercases, hyphenates, strips quotes", () => {
    expect(slugifyPageName("Spring Promo '26!")).toBe("spring-promo-26");
  });
  it("trims leading/trailing hyphens", () => {
    expect(slugifyPageName("--Hello--")).toBe("hello");
  });
  it("prefixes digit-first names so generated slugs satisfy the server contract", () => {
    expect(slugifyPageName("2026 Launch")).toBe("page-2026-launch");
  });
});

describe("landingPageUrl", () => {
  it("builds an absolute https URL when a custom domain is set", () => {
    expect(landingPageUrl(page({ domain: "pages.example.com" }))).toEqual({
      url: "https://pages.example.com/landing/spring-promo",
      absolute: true,
    });
  });
  it("strips trailing slashes from the domain", () => {
    expect(landingPageUrl(page({ domain: "pages.example.com/" })).url).toBe(
      "https://pages.example.com/landing/spring-promo",
    );
  });
  it("falls back to the web-app path when no domain — honest, not getApiUrl", () => {
    expect(landingPageUrl(page())).toEqual({
      url: "/landing/spring-promo",
      absolute: false,
    });
  });
  it("URL-encodes the slug", () => {
    expect(landingPageUrl(page({ slug: "a b" })).url).toBe("/landing/a%20b");
  });
});

describe("landingStatusTone", () => {
  it("maps the three wire statuses", () => {
    expect(landingStatusTone("published")).toBe("success");
    expect(landingStatusTone("archived")).toBe("warning");
    expect(landingStatusTone("draft")).toBe("default");
    expect(landingStatusTone(undefined)).toBe("default");
  });
});

describe("blocksSummary", () => {
  it("counts blocks honestly", () => {
    expect(blocksSummary([])).toBe("no blocks yet");
    expect(blocksSummary([{}])).toBe("1 block");
    expect(blocksSummary([{}, {}, {}])).toBe("3 blocks");
    expect(blocksSummary(undefined)).toBe("no blocks yet");
  });
});

describe("sortLandingPages", () => {
  it("orders newest-updated first, name as tiebreak", () => {
    const a = page({
      id: "a",
      name: "Alpha",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const b = page({
      id: "b",
      name: "Beta",
      updated_at: "2026-03-01T00:00:00Z",
    });
    const c = page({
      id: "c",
      name: "Aaa",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(sortLandingPages([a, b, c]).map((p) => p.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
  it("doesn't mutate the input", () => {
    const input = [page({ id: "a" }), page({ id: "b" })];
    sortLandingPages(input);
    expect(input.map((p) => p.id)).toEqual(["a", "b"]);
  });
  it("returns [] for a missing/non-array list body (empty response)", () => {
    // The list endpoint is a bare array, but a minimal/empty response
    // can arrive null or as `{}` — must not throw "pages is not
    // iterable".
    expect(sortLandingPages(undefined)).toEqual([]);
    expect(sortLandingPages(null)).toEqual([]);
    expect(
      sortLandingPages({} as unknown as Parameters<typeof sortLandingPages>[0]),
    ).toEqual([]);
  });
});

describe("buildLandingPageInput", () => {
  it("builds create + patch from a valid draft", () => {
    const r = buildLandingPageInput({
      id: null,
      name: " Spring promo ",
      slug: "spring-promo",
      slugTouched: true,
      domain: "pages.example.com",
      template: "minimal",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create).toEqual({
      slug: "spring-promo",
      name: "Spring promo",
      domain: "pages.example.com",
      template: "minimal",
    });
    // PATCH never carries slug (immutable server-side).
    expect("slug" in r.patch).toBe(false);
    expect(r.patch.name).toBe("Spring promo");
  });
  it("derives the slug from the name when blank", () => {
    const r = buildLandingPageInput({
      ...newLandingPageDraft(),
      name: "My Page",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.slug).toBe("my-page");
  });
  it("omits empty domain/template on create but sends them on patch so clears stick", () => {
    const r = buildLandingPageInput({ ...newLandingPageDraft(), name: "X" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("domain" in r.create).toBe(false);
    expect(r.patch.domain).toBe("");
    expect(r.patch.template).toBe("");
  });
  it("rejects missing name and bad slugs", () => {
    expect(buildLandingPageInput(newLandingPageDraft())).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(
      buildLandingPageInput({
        ...newLandingPageDraft(),
        name: "X",
        slug: "-bad-",
        slugTouched: true,
      }),
    ).toMatchObject({ ok: false, field: "slug" });
    expect(
      buildLandingPageInput({
        ...newLandingPageDraft(),
        name: "X",
        slug: "Has Space",
        slugTouched: true,
      }),
    ).toMatchObject({ ok: false, field: "slug" });
    expect(
      buildLandingPageInput({
        ...newLandingPageDraft(),
        name: "X",
        slug: "1-sale",
        slugTouched: true,
      }),
    ).toMatchObject({ ok: false, field: "slug" });
  });
  it("rejects a non-hostname domain", () => {
    expect(
      buildLandingPageInput({
        ...newLandingPageDraft(),
        name: "X",
        domain: "https://pages.example.com",
      }),
    ).toMatchObject({ ok: false, field: "domain" });
  });
});

describe("landingPageToDraft", () => {
  it("projects a wire row into the editor", () => {
    const d = landingPageToDraft(
      page({ domain: "d.example.com", template: "t" }),
    );
    expect(d).toEqual({
      id: "p1",
      name: "Spring promo",
      slug: "spring-promo",
      slugTouched: true,
      domain: "d.example.com",
      template: "t",
    });
  });
});

describe("statusAction", () => {
  it("offers the one honest transition per status", () => {
    expect(statusAction("draft")).toEqual({
      next: "published",
      label: "Publish",
    });
    expect(statusAction("published")).toEqual({
      next: "draft",
      label: "Unpublish",
    });
    expect(statusAction("archived")).toEqual({
      next: "draft",
      label: "Restore to draft",
    });
    expect(statusAction(undefined).next).toBe("published");
  });
});
