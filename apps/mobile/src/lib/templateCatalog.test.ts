/**
 * The template catalogue's wire parsing, driven with the payloads the Go
 * handlers actually emit.
 *
 * Every fixture below is shaped from the struct tags in
 * `apps/api/internal/campaigntemplates/campaigntemplates.go` and the projection
 * in `catalog.go` — including the `omitempty` omissions, which are the part a
 * hand-written fixture always gets wrong by helpfully including every field.
 */
import { describe, expect, it } from "vitest";

import {
  goalQueryValue,
  parseGoalCounts,
  parseTemplate,
  parseTemplateCatalogPage,
  templateBodyState,
  templateGoalLabel,
  templateGoalOptions,
  templateOrigin,
  templatePreviewLine,
  TEMPLATE_GOALS,
  type MobileTemplate,
} from "./templateCatalog";

/** A catalogue row exactly as `Repo.Search` scans and marshals one. */
const CATALOG_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  slug: "spring-launch",
  name: "Spring launch",
  description: "Announce the seasonal drop",
  category: "product",
  subject: "The spring drop is live",
  preview_text: "Six new pieces",
  // The catalogue projection blanks both bodies.
  body_html: "",
  body_mjml: "",
  variables: [{ name: "first_name", label: "First name", default: "" }],
  tags: ["seasonal", "launch"],
  created_at: "2026-05-01T09:00:00Z",
  updated_at: "2026-06-02T09:00:00Z",
  goal: "promotional",
  is_featured: true,
  usage_count: 12,
  last_used_at: "2026-07-01T09:00:00Z",
  template_kind: "editable",
  source_provider: "postwave",
  source_license_status: "owned",
  review_status: "approved",
  quality_score: 0.9,
};

function template(overrides: Partial<MobileTemplate> = {}): MobileTemplate {
  const base = parseTemplate(CATALOG_ROW);
  if (!base) throw new Error("fixture failed to parse");
  return { ...base, ...overrides };
}

describe("parseTemplate", () => {
  it("reads a catalogue row without inventing a body", () => {
    const parsed = parseTemplate(CATALOG_ROW);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("Spring launch");
    expect(parsed?.goal).toBe("promotional");
    expect(parsed?.usageCount).toBe(12);
    expect(parsed?.variableNames).toEqual(["first_name"]);
    expect(parsed?.isPlatform).toBe(false);
    expect(parsed?.bodyHTML).toBe("");
    // "unknown", not "empty" — the list simply does not carry a body.
    expect(templateBodyState(parsed)).toBe("unknown");
  });

  it("treats an omitted tenant_id as the platform gallery", () => {
    const { tenant_id: _dropped, ...platform } = CATALOG_ROW;
    expect(parseTemplate(platform)?.isPlatform).toBe(true);
  });

  it("reads omitted zero-value counters as zero, because the columns are NOT NULL", () => {
    const {
      usage_count: _u,
      is_featured: _f,
      quality_score: _q,
      last_used_at: _l,
      ...bare
    } = CATALOG_ROW;
    const parsed = parseTemplate(bare);
    expect(parsed?.usageCount).toBe(0);
    expect(parsed?.isFeatured).toBe(false);
    // NOT NULL DEFAULT 0.500 with CHECK 0..1 — absent can only mean 0.000.
    expect(parsed?.qualityScore).toBe(0);
    // last_used_at is a nullable timestamptz: absent means never used.
    expect(parsed?.lastUsedAt).toBeNull();
  });

  it("refuses a quality score outside the server's CHECK rather than showing it", () => {
    expect(parseTemplate({ ...CATALOG_ROW, quality_score: 7 })?.qualityScore).toBeNull();
    expect(
      parseTemplate({ ...CATALOG_ROW, quality_score: "high" })?.qualityScore,
    ).toBeNull();
  });

  it("drops Go's zero time rather than rendering the year 1", () => {
    const parsed = parseTemplate({
      ...CATALOG_ROW,
      last_used_at: "0001-01-01T00:00:00Z",
    });
    expect(parsed?.lastUsedAt).toBeNull();
  });

  it("rejects a row with no id", () => {
    expect(parseTemplate({ name: "Nameless" })).toBeNull();
    expect(parseTemplate(null)).toBeNull();
    expect(parseTemplate("nonsense")).toBeNull();
  });

  it("keeps only named variables, de-duplicated", () => {
    const parsed = parseTemplate({
      ...CATALOG_ROW,
      variables: [
        { name: "a" },
        { name: "a" },
        { label: "unnamed" },
        "junk",
        { name: "  b  " },
      ],
    });
    expect(parsed?.variableNames).toEqual(["a", "b"]);
  });
});

describe("parseTemplateCatalogPage", () => {
  it("reads the SearchResponse envelope, cursor included", () => {
    const page = parseTemplateCatalogPage({
      items: [CATALOG_ROW],
      page: 1,
      per_page: 24,
      total: 40,
      next_cursor: "2",
      facets: { goals: [], categories: [] },
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(40);
    expect(page.nextPage).toBe(2);
  });

  it("stops paging on the last page", () => {
    const page = parseTemplateCatalogPage({
      items: [CATALOG_ROW],
      page: 2,
      per_page: 24,
      total: 25,
    });
    expect(page.nextPage).toBeNull();
  });

  it("never claims another page from a bare array", () => {
    const page = parseTemplateCatalogPage([CATALOG_ROW]);
    expect(page.items).toHaveLength(1);
    expect(page.nextPage).toBeNull();
  });

  it("reports a genuinely empty library as zero, because the server said zero", () => {
    // `SearchResponse.Total` has no omitempty (catalog.go:69), so a 0 here is
    // the server's own answer and the header may state it.
    expect(
      parseTemplateCatalogPage({ items: [], page: 1, per_page: 24, total: 0 })
        .total,
    ).toBe(0);
  });

  it("reports a MISSING total as unknown, never as an empty library", () => {
    // The regression: `count()` collapses absent into 0, which would print
    // "0 designs in this workspace" as a header over a list with rows in it.
    expect(parseTemplateCatalogPage([CATALOG_ROW]).total).toBeNull();
    expect(parseTemplateCatalogPage({ items: [CATALOG_ROW] }).total).toBeNull();
    expect(
      parseTemplateCatalogPage({ items: [CATALOG_ROW], total: "many" }).total,
    ).toBeNull();
  });

  it("survives an envelope that lost its items rather than throwing", () => {
    expect(parseTemplateCatalogPage({ data: [CATALOG_ROW] }).items).toEqual([]);
    expect(parseTemplateCatalogPage(null).items).toEqual([]);
  });
});

describe("parseGoalCounts + templateGoalOptions", () => {
  it("drops the blank-goal bucket the /goals rollup can return", () => {
    // Repo.GoalCounts groups on COALESCE(goal, '') and does not filter it out.
    const counts = parseGoalCounts([
      { goal: "", count: 9 },
      { goal: "welcome", count: 3 },
    ]);
    expect(counts).toEqual([{ goal: "welcome", count: 3 }]);
  });

  it("drops any goal outside the CHECK taxonomy, which would 400 the list", () => {
    expect(parseGoalCounts([{ goal: "seasonal", count: 4 }])).toEqual([]);
  });

  it("accepts every goal the server's validGoal accepts", () => {
    const counts = parseGoalCounts(
      TEMPLATE_GOALS.map((goal) => ({ goal, count: 1 })),
    );
    expect(counts.map((row) => row.goal)).toEqual([...TEMPLATE_GOALS]);
  });

  it("builds a stable rail led by All, in taxonomy order, skipping empty goals", () => {
    const options = templateGoalOptions([
      // Server order is count-descending; the rail must not inherit it.
      { goal: "promotional", count: 7 },
      { goal: "welcome", count: 2 },
      { goal: "automation", count: 0 },
    ]);
    expect(options.map((option) => option.value)).toEqual([
      "all",
      "welcome",
      "promotional",
    ]);
    expect(options[0]?.badge).toBe(9);
    // The badge renders as a bare numeral and a chip's accessibilityLabel
    // replaces its children, so the count has to be spelled out or a screen
    // reader hears "Promotional" and nothing else.
    expect(options.map((option) => option.accessibilityLabel)).toEqual([
      "All goals, 9 designs",
      "Welcome, 2 designs",
      "Promotional, 7 designs",
    ]);
  });

  it("leaves All without a count when the library is empty", () => {
    const options = templateGoalOptions([]);
    expect(options).toHaveLength(1);
    expect(options[0]?.badge).toBeUndefined();
    // And says nothing about a count it does not have.
    expect(options[0]?.accessibilityLabel).toBe("All goals");
  });

  it("sends no goal param for All and the raw goal otherwise", () => {
    expect(goalQueryValue("all")).toBeNull();
    expect(goalQueryValue("re_engagement")).toBe("re_engagement");
  });
});

describe("presentation helpers", () => {
  it("labels goals in product language and never swallows an unknown one", () => {
    expect(templateGoalLabel("re_engagement")).toBe("Win-back");
    expect(templateGoalLabel("seasonal")).toBe("seasonal");
    expect(templateGoalLabel("")).toBe("No goal");
  });

  it("prefers the subject line, falling back rather than showing nothing", () => {
    expect(templatePreviewLine(template())).toBe("The spring drop is live");
    expect(
      templatePreviewLine(template({ subject: "", description: "Fallback" })),
    ).toBe("Fallback");
    expect(
      templatePreviewLine(
        template({ subject: "", description: "", previewText: "" }),
      ),
    ).toBe("No subject line yet");
  });

  it("truncates a long subject instead of blowing the row height out", () => {
    const long = templatePreviewLine(template({ subject: "x".repeat(400) }), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names the provenance of each population in the mixed catalogue", () => {
    expect(templateOrigin(template({ sourceBrand: "Allbirds" }))).toBe(
      "Captured from Allbirds",
    );
    expect(templateOrigin(template({ isPlatform: true, sourceBrand: "" }))).toBe(
      "Moosewave gallery",
    );
    expect(
      templateOrigin(
        template({ isPlatform: false, sourceBrand: "", sourceProvider: "mailchimp" }),
      ),
    ).toBe("Imported from mailchimp");
    expect(templateOrigin(template({ sourceBrand: "" }))).toBe(
      "Built in this workspace",
    );
  });
});

describe("templateBodyState", () => {
  it("separates not-loaded from loaded-and-empty", () => {
    expect(templateBodyState(null)).toBe("unknown");
    // `bodyLoaded` is what separates the two, and it cannot come from the
    // payload: the catalogue query selects '' AS body_html (catalog.go:182),
    // so a list row and a genuinely bodyless design are identical on the wire.
    // The base fixture is a CATALOGUE row, so these cases say "loaded".
    expect(
      templateBodyState(
        template({ bodyHTML: "", bodyMJML: "", bodyLoaded: true }),
      ),
    ).toBe("empty");
    expect(
      templateBodyState(template({ bodyHTML: "<p>hi</p>", bodyLoaded: true })),
    ).toBe("present");
    expect(
      templateBodyState(template({ bodyMJML: "<mjml/>", bodyLoaded: true })),
    ).toBe("present");
    // Whitespace is not a design.
    expect(
      templateBodyState(template({ bodyHTML: "   ", bodyLoaded: true })),
    ).toBe("empty");
  });

  it("stays 'unknown' for a catalogue row no matter what the body says", () => {
    // The regression this guards: a blank string from the list masquerading as
    // "this design has no email in it", which the sheet would report as "a
    // draft made from it would arrive blank" — about a design never read.
    expect(templateBodyState(template({ bodyHTML: "", bodyMJML: "" }))).toBe(
      "unknown",
    );
  });
});
