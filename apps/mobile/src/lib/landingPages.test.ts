/**
 * The landing-page decisions, pinned against the shapes the Go handlers
 * actually emit.
 *
 * The fixture below is not invented: it is `landingpages.LandingPage`
 * serialised with its JSON tags (`id`, `tenant_id`, `slug`, `name`, `status`,
 * `domain,omitempty`, `template`, `blocks`, `seo`, `tracking`, `metrics`,
 * `created_at`, `updated_at`), and the leads fixture is
 * `{"items":[Conversion]}` with `email` / `metadata,omitempty` / `at` — the two
 * envelopes `Deps.List` and `Deps.Leads` write. The list is a BARE ARRAY and
 * the leads are WRAPPED, which is exactly the asymmetry a parser gets wrong.
 */
import { describe, expect, it } from "vitest";

import {
  filterLandingPages,
  hasAnyMetric,
  landingMetrics,
  landingStatusCounts,
  landingStatusPresentation,
  LEADS_LIMIT,
  leadDetails,
  leadDisplayEmail,
  leadsTruncated,
  orderLandingPages,
  parseLandingPage,
  parseLandingPageList,
  parseLead,
  parseLeadList,
  publicLandingPath,
  publicLandingUrl,
  publicUrlUnavailableReason,
  type MobileLandingPage,
} from "./landingPages";

/** One row exactly as `Deps.List` serialises it. */
const WIRE_ROW = {
  id: "8f0d2f9e-3f61-4d0a-9c9e-11115ba7a001",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  slug: "spring-launch",
  name: "Spring launch",
  status: "published",
  domain: "get.example.com",
  template: "signup",
  blocks: [{ type: "hero" }],
  seo: {},
  tracking: {},
  metrics: {},
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-20T11:30:00Z",
};

function page(overrides: Partial<MobileLandingPage> = {}): MobileLandingPage {
  const parsed = parseLandingPage(WIRE_ROW);
  if (!parsed) throw new Error("fixture must parse");
  return { ...parsed, ...overrides };
}

describe("parsing the wire shapes", () => {
  it("reads a row with the handler's own JSON tag names", () => {
    expect(parseLandingPage(WIRE_ROW)).toEqual({
      id: "8f0d2f9e-3f61-4d0a-9c9e-11115ba7a001",
      slug: "spring-launch",
      name: "Spring launch",
      status: "published",
      domain: "get.example.com",
      template: "signup",
      createdAt: "2026-07-01T09:00:00Z",
      updatedAt: "2026-07-20T11:30:00Z",
      metrics: {},
    });
  });

  it("reads the BARE ARRAY the list handler sends", () => {
    // `Deps.List` writes the slice itself — no envelope. A parser that only
    // understood `{items}` would report an empty workspace here.
    expect(parseLandingPageList([WIRE_ROW]).map((p) => p.slug)).toEqual([
      "spring-launch",
    ]);
  });

  it("also reads an {items} envelope, so a normalised route can't empty the screen", () => {
    expect(parseLandingPageList({ items: [WIRE_ROW] })).toHaveLength(1);
  });

  it("returns an empty list for anything that is not a list", () => {
    expect(parseLandingPageList(null)).toEqual([]);
    expect(parseLandingPageList({ data: [WIRE_ROW] })).toEqual([]);
    expect(parseLandingPageList("nope")).toEqual([]);
  });

  it("drops a row with no id rather than rendering a page nothing can open", () => {
    expect(parseLandingPage({ ...WIRE_ROW, id: "" })).toBeNull();
    expect(parseLandingPageList([WIRE_ROW, { slug: "orphan" }])).toHaveLength(1);
  });

  it("treats Go's zero time as absent, never as the year 1", () => {
    const parsed = parseLandingPage({
      ...WIRE_ROW,
      created_at: "0001-01-01T00:00:00Z",
      updated_at: "not a date",
    });
    expect(parsed?.createdAt).toBeNull();
    expect(parsed?.updatedAt).toBeNull();
  });

  it("defaults a missing status to draft, which is the column's own default", () => {
    expect(parseLandingPage({ id: "a" })?.status).toBe("draft");
    // `domain,omitempty` means the key is absent when unset — "" not undefined.
    expect(parseLandingPage({ id: "a" })?.domain).toBe("");
  });
});

describe("parsing leads", () => {
  const LEADS_WIRE = {
    items: [
      {
        email: "ada@example.com",
        metadata: { utm_source: "twitter" },
        at: "2026-07-24T10:00:00Z",
      },
      { email: "", metadata: {}, at: "2026-07-23T10:00:00Z" },
    ],
  };

  it("reads the {items} envelope Deps.Leads writes", () => {
    expect(parseLeadList(LEADS_WIRE)).toHaveLength(2);
    expect(parseLeadList(LEADS_WIRE)[0]?.email).toBe("ada@example.com");
  });

  it("keeps a conversion recorded WITHOUT an address — it still happened", () => {
    // The column is `COALESCE(email, '')`, so "" is a real row.
    const lead = parseLead({ email: "", at: "2026-07-23T10:00:00Z" });
    expect(lead).not.toBeNull();
    expect(leadDisplayEmail(lead!)).toBe("No email captured");
  });

  it("drops a row carrying neither an address nor an instant", () => {
    expect(parseLead({ metadata: { a: 1 } })).toBeNull();
  });

  it("says when the server's 5000-row cap was hit", () => {
    expect(leadsTruncated(LEADS_LIMIT - 1)).toBe(false);
    expect(leadsTruncated(LEADS_LIMIT)).toBe(true);
  });
});

describe("status", () => {
  it("marks ONLY published as publicly live", () => {
    expect(landingStatusPresentation("published").live).toBe(true);
    expect(landingStatusPresentation("draft").live).toBe(false);
    expect(landingStatusPresentation("archived").live).toBe(false);
  });

  it("never lets an unrecognised status read as live, and shows it verbatim", () => {
    const unknown = landingStatusPresentation("scheduled");
    expect(unknown.live).toBe(false);
    expect(unknown.label).toBe("scheduled");
    expect(landingStatusPresentation("").label).toBe("Unknown");
  });

  it("counts each status, and 'all' is the whole set", () => {
    const counts = landingStatusCounts([
      page(),
      page({ id: "b", status: "draft" }),
      page({ id: "c", status: "archived" }),
      page({ id: "d", status: "draft" }),
    ]);
    expect(counts).toEqual({ all: 4, published: 1, draft: 2, archived: 1 });
  });
});

describe("filtering and ordering", () => {
  const PAGES = [
    page({ id: "a", name: "Spring launch", slug: "spring-launch" }),
    page({
      id: "b",
      name: "Webinar signup",
      slug: "webinar",
      status: "draft",
      updatedAt: "2026-07-25T08:00:00Z",
    }),
    page({
      id: "c",
      name: "Archived promo",
      slug: "promo-2025",
      status: "archived",
      updatedAt: null,
    }),
  ];

  it("filters by status", () => {
    expect(
      filterLandingPages(PAGES, { status: "draft" }).map((p) => p.id),
    ).toEqual(["b"]);
  });

  it("matches free text against BOTH the name and the slug", () => {
    expect(filterLandingPages(PAGES, { q: "WEBINAR" }).map((p) => p.id)).toEqual(
      ["b"],
    );
    expect(filterLandingPages(PAGES, { q: "promo-2025" }).map((p) => p.id)).toEqual(
      ["c"],
    );
  });

  it("orders most-recently-edited first and sinks rows with no timestamp", () => {
    expect(orderLandingPages(PAGES).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("never mutates the array it was given", () => {
    const input = [...PAGES];
    orderLandingPages(input);
    expect(input.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("metrics — absence is not zero", () => {
  it("reports NULL for the empty {} every row actually carries", () => {
    const metrics = landingMetrics({ metrics: {} });
    expect(metrics).toEqual({
      views: null,
      conversions: null,
      conversionRate: null,
    });
    // hasAnyMetric is what lets the UI omit the block instead of printing
    // three em-dashes on a surface where nothing is ever measured.
    expect(hasAnyMetric(metrics)).toBe(false);
  });

  it("derives a rate only when both halves are present", () => {
    expect(landingMetrics({ metrics: { views: 200, conversions: 40 } })).toEqual(
      { views: 200, conversions: 40, conversionRate: 20 },
    );
    expect(landingMetrics({ metrics: { views: 200 } }).conversionRate).toBeNull();
  });

  it("accepts a server-supplied rate in either fraction or percent form", () => {
    expect(landingMetrics({ metrics: { conversion_rate: 0.25 } }).conversionRate).toBe(25);
    expect(landingMetrics({ metrics: { conversionRate: 25 } }).conversionRate).toBe(25);
  });

  it("does not divide by zero views", () => {
    expect(
      landingMetrics({ metrics: { views: 0, conversions: 0 } }).conversionRate,
    ).toBe(0);
  });
});

describe("the public link", () => {
  it("builds the same path apps/web copies to the clipboard", () => {
    expect(publicLandingPath("spring-launch")).toBe("/landing/spring-launch");
    expect(publicLandingPath("a b")).toBe("/landing/a%20b");
  });

  it("returns an absolute URL for a published page", () => {
    expect(publicLandingUrl("https://app.moosewave.com", page())).toBe(
      "https://app.moosewave.com/landing/spring-launch",
    );
  });

  it("tolerates a trailing slash on the origin instead of doubling it", () => {
    expect(publicLandingUrl("https://app.moosewave.com/", page())).toBe(
      "https://app.moosewave.com/landing/spring-launch",
    );
  });

  it("refuses to build a link to a page Moosewave does not serve", () => {
    // `Repo.PublicLandingPage` filters `status = 'published'`: a draft's URL
    // is a 404, and handing one out is worse than showing no link.
    expect(publicLandingUrl("https://app.moosewave.com", page({ status: "draft" }))).toBeNull();
    expect(
      publicLandingUrl("https://app.moosewave.com", page({ status: "archived" })),
    ).toBeNull();
    expect(publicLandingUrl("https://app.moosewave.com", page({ slug: "" }))).toBeNull();
  });

  it("explains the absence in the user's terms, and stays silent when live", () => {
    expect(publicUrlUnavailableReason(page())).toBeNull();
    expect(publicUrlUnavailableReason(page({ status: "draft" }))).toMatch(
      /aren't served publicly/,
    );
    expect(publicUrlUnavailableReason(page({ slug: "" }))).toMatch(/no slug/);
  });

  it("never builds a URL from the custom domain, which no resolver reads", () => {
    // `domain` is INSERTed, SELECTed and echoed, and used by nothing in the
    // request path — `https://get.example.com/...` would be a URL this
    // codebase cannot show resolves.
    const url = publicLandingUrl("https://app.moosewave.com", page());
    expect(url).not.toContain("get.example.com");
  });
});

describe("lead metadata", () => {
  const lead = (metadata: Record<string, unknown>) => ({
    email: "ada@example.com",
    at: "2026-07-24T10:00:00Z",
    metadata,
  });

  it("renders whatever the public form posted, keys sorted and humanised", () => {
    expect(leadDetails(lead({ utm_source: "twitter", campaign: "spring" }))).toEqual([
      { key: "Campaign", value: "spring" },
      { key: "Utm source", value: "twitter" },
    ]);
  });

  it("bounds the number of pairs so one payload cannot blow the row out", () => {
    expect(
      leadDetails(lead({ a: 1, b: 2, c: 3, d: 4, e: 5 })).length,
    ).toBe(4);
  });

  it("truncates a long value rather than wrapping forever", () => {
    const value = leadDetails(lead({ note: "x".repeat(200) }))[0]?.value ?? "";
    expect(value.length).toBeLessThanOrEqual(60);
    expect(value.endsWith("…")).toBe(true);
  });

  it("keeps a nested object readable instead of printing [object Object]", () => {
    expect(leadDetails(lead({ ctx: { a: 1 } }))[0]?.value).toBe('{"a":1}');
  });

  it("skips entries that carry nothing", () => {
    expect(leadDetails(lead({ empty: "   ", missing: null }))).toEqual([]);
  });
});
