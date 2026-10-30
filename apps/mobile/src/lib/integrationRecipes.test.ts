import { describe, expect, it } from "vitest";

import {
  RECIPE_PAGE_SIZE,
  blueprintLines,
  filterRecipes,
  normalizeRecipeDetail,
  normalizeRecipeList,
  recipeApplyNotice,
  recipeAvailabilityLine,
  recipeResultSentence,
  recipeSearchTerm,
  type RecipeRow,
} from "./integrationRecipes";

const listPayload = {
  items: [
    {
      id: "shopify-orders",
      name: "Shopify orders to commerce events",
      provider: "Shopify",
      source_slug: "shopify",
      target_slug: "",
      summary: "Stream orders into Moosewave commerce events.",
      badge: "native",
      available: true,
      estimated_minutes: 15,
      setup_path: "/commerce",
      capabilities: ["orders", "commerce"],
      steps: [
        {
          title: "Connect Shopify",
          description: "Authorise the app.",
          action: "connect",
          path: "/commerce",
          required_fields: ["shop_domain"],
        },
        { action: "noop" },
      ],
      blueprint: {
        trigger: "orders/create webhook",
        destination: "Moosewave commerce events",
        postwave_surface: "Commerce",
        required_scopes: ["read_orders"],
        required_secrets: ["shopify_api_secret"],
        events: ["order.created"],
        data_handling: ["Order line items are stored."],
        field_mappings: [
          {
            source: "email",
            target: "subscriber.email",
            required: true,
            description: "Buyer email",
          },
          { required: true },
        ],
        sample_payload: { id: 1 },
      },
    },
    {
      id: "acme-bridge",
      name: "Acme bridge",
      provider: "Acme",
      source_slug: "acme",
      summary: "Planned bridge wiring.",
      badge: "zapier",
      available: false,
      blueprint: { trigger: "webhook", destination: "Moosewave webhooks" },
    },
    { id: "shopify-orders", name: "Duplicate" },
    { name: "no id" },
    { id: "no-name" },
  ],
  summary: { total: 310, available: 190, planned: 120, "badge:native": 90 },
};

const list = normalizeRecipeList(listPayload);

function row(over: Partial<RecipeRow>): RecipeRow {
  return {
    id: "x",
    name: "X",
    provider: "",
    sourceSlug: "",
    targetSlug: "",
    summary: "",
    badge: "native",
    available: true,
    estimatedMinutes: null,
    setupPath: "",
    capabilities: [],
    steps: [],
    blueprint: {
      trigger: "",
      destination: "",
      postwaveSurface: "",
      requiredScopes: [],
      requiredSecrets: [],
      events: [],
      dataHandling: [],
      fieldMappings: [],
    },
    ...over,
  };
}

describe("normalizeRecipeList", () => {
  it("keeps rows with an id and a name, deduplicated", () => {
    expect(list.items.map((item) => item.id)).toEqual([
      "shopify-orders",
      "acme-bridge",
    ]);
  });

  it("carries the server's summary counts", () => {
    expect(list.summary.total).toBe(310);
    expect(list.summary.available).toBe(190);
  });

  it("drops a step with neither a title nor a description", () => {
    expect(list.items[0]!.steps).toHaveLength(1);
    expect(list.items[0]!.steps[0]!.requiredFields).toEqual(["shop_domain"]);
  });

  it("drops a field mapping with neither a source nor a target", () => {
    expect(list.items[0]!.blueprint.fieldMappings).toHaveLength(1);
  });

  it("reads a missing `available` as NOT available", () => {
    const guessed = normalizeRecipeList({
      items: [{ id: "a", name: "A" }],
    });
    expect(guessed.items[0]!.available).toBe(false);
    // and only a real boolean true flips it
    expect(
      normalizeRecipeList({ items: [{ id: "a", name: "A", available: "true" }] })
        .items[0]!.available,
    ).toBe(false);
  });

  it("survives junk", () => {
    expect(normalizeRecipeList(null).items).toEqual([]);
    expect(normalizeRecipeList({ items: "nope" }).items).toEqual([]);
    expect(normalizeRecipeList({ summary: [] }).summary).toEqual({});
  });
});

describe("normalizeRecipeDetail", () => {
  it("resolves the source and optional target", () => {
    const detail = normalizeRecipeDetail({
      recipe: listPayload.items[0],
      source: { name: "Shopify", runtime_status: "available" },
      target: { name: "Klaviyo", runtime_status: "partial" },
    });
    expect(detail?.sourceName).toBe("Shopify");
    expect(detail?.targetStatus).toBe("partial");
  });

  it("leaves the target blank when the server sent none", () => {
    const detail = normalizeRecipeDetail({
      recipe: listPayload.items[0],
      source: { name: "Shopify", runtime_status: "available" },
    });
    expect(detail?.targetName).toBe("");
  });

  it("refuses a body with no readable recipe rather than showing a blank one", () => {
    expect(normalizeRecipeDetail({})).toBeNull();
    expect(normalizeRecipeDetail({ recipe: { id: "a" } })).toBeNull();
    expect(normalizeRecipeDetail(null)).toBeNull();
  });
});

describe("filterRecipes", () => {
  const all = { search: "", availability: "" };

  it("returns everything with no filters", () => {
    expect(filterRecipes(list.items, all)).toHaveLength(2);
  });

  it("splits on the server's availability flag", () => {
    expect(
      filterRecipes(list.items, { ...all, availability: "available" }).map(
        (r) => r.id,
      ),
    ).toEqual(["shopify-orders"]);
    expect(
      filterRecipes(list.items, { ...all, availability: "planned" }).map(
        (r) => r.id,
      ),
    ).toEqual(["acme-bridge"]);
  });

  it("searches the server's fields: provider, event, scope, surface, step text", () => {
    const by = (q: string) =>
      filterRecipes(list.items, { ...all, search: q }).map((r) => r.id);
    expect(by("SHOPIFY")).toEqual(["shopify-orders"]);
    expect(by("order.created")).toEqual(["shopify-orders"]);
    expect(by("read_orders")).toEqual(["shopify-orders"]);
    expect(by("commerce")).toEqual(["shopify-orders"]);
    expect(by("authorise the app")).toEqual(["shopify-orders"]);
    expect(by("subscriber.email")).toEqual(["shopify-orders"]);
    expect(by("zapier")).toEqual(["acme-bridge"]);
  });

  // The server's recipeMatches (handlers.go:697) also joins required secrets,
  // data handling, each mapping's DESCRIPTION and each step's action, path and
  // required fields. If the phone drops any of them its result set is a strict
  // subset of what ?q= would have returned, and the reader concludes the
  // product has no such recipe. One assertion per field the server searches.
  it("searches every remaining field the server's recipeMatches joins", () => {
    const by = (q: string) =>
      filterRecipes(list.items, { ...all, search: q }).map((r) => r.id);
    // required_secrets — "shopify" alone would match on the id, so the query is
    // the whole secret name, which appears nowhere else in the row.
    expect(by("shopify_api_secret")).toEqual(["shopify-orders"]);
    // data_handling
    expect(by("order line items are stored")).toEqual(["shopify-orders"]);
    // field_mappings[].description
    expect(by("buyer email")).toEqual(["shopify-orders"]);
    // steps[].required_fields
    expect(by("shop_domain")).toEqual(["shopify-orders"]);
    // steps[].path — "/commerce" with the slash appears only there; the
    // capability is the bare word "commerce".
    expect(by("/commerce")).toEqual(["shopify-orders"]);
  });

  it("searches a step's action, which no other field repeats", () => {
    const rows = [
      row({
        id: "with-action",
        steps: [
          {
            title: "Step one",
            description: "Do the thing.",
            action: "provision_bridge",
            path: "",
            requiredFields: [],
          },
        ],
      }),
      row({ id: "without-action" }),
    ];
    expect(
      filterRecipes(rows, { ...all, search: "provision_bridge" }).map(
        (r) => r.id,
      ),
    ).toEqual(["with-action"]);
  });

  it("bounds the search term", () => {
    expect(recipeSearchTerm("a".repeat(400))).toHaveLength(256);
    expect(recipeSearchTerm("  Acme ")).toBe("acme");
  });
});

describe("blueprintLines", () => {
  it("renders only the fields the server filled", () => {
    const lines = blueprintLines(list.items[0]!);
    const labels = lines.map((line) => line.label);
    expect(labels).toEqual([
      "Trigger",
      "Destination",
      "Moosewave surface",
      "Events",
      "Required scopes",
      "Required secrets",
      "Data handling",
      "Field mappings",
    ]);
    expect(lines.at(-1)!.value).toBe("email → subscriber.email (required)");
  });

  it("omits an empty section rather than claiming the recipe needs none", () => {
    const labels = blueprintLines(list.items[1]!).map((line) => line.label);
    expect(labels).toEqual(["Trigger", "Destination"]);
    expect(labels).not.toContain("Required scopes");
  });

  it("never renders the untyped sample payload", () => {
    expect(
      blueprintLines(list.items[0]!).some((line) =>
        line.label.toLowerCase().includes("payload"),
      ),
    ).toBe(false);
  });
});

describe("recipeApplyNotice", () => {
  it("says a planned recipe cannot be run", () => {
    expect(recipeApplyNotice(row({ available: false }))).toContain(
      "not available yet",
    );
  });

  it("says an available recipe is still finished at a desk, and offers no apply", () => {
    const notice = recipeApplyNotice(row({ available: true }));
    expect(notice).toContain("desk work");
    expect(notice).toContain("blueprint");
  });
});

describe("recipeAvailabilityLine", () => {
  it("uses the server's summary, not the rows in hand", () => {
    expect(recipeAvailabilityLine(list)).toContain("190 of 310");
  });

  it("says nothing when the summary is absent", () => {
    expect(recipeAvailabilityLine({ ...list, summary: {} })).toBeNull();
    expect(
      recipeAvailabilityLine({ ...list, summary: { total: 310 } }),
    ).toBeNull();
  });
});

describe("recipeResultSentence", () => {
  it("counts plainly, then relatively", () => {
    expect(recipeResultSentence(310, 310, false)).toBe("310 recipes.");
    expect(recipeResultSentence(310, 4, true)).toBe(
      "4 of 310 recipes match the active filters.",
    );
  });
});

describe("paging", () => {
  it("caps the first render", () => {
    expect(RECIPE_PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});
