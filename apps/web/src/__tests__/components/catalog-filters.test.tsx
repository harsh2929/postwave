// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalog posture: the workspace-state and customer-stack filters join the
// catalog against GET /api/v1/integrations/connections and /stacks and narrow
// the rendered rows; a failed connections read disables its filter with the
// reason instead of reading as "nothing needs attention". The posture panels
// read /readiness, /coverage, /stacks, /recipes and /connections, and "Retry
// verification" re-reads readiness and renders the new verdict.

import { createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonNamed,
  catalogItem,
  click,
  connectionRow,
  identity,
  installFetchRouter,
  mount,
  recipe,
  text,
  type,
  unmountAll,
  waitFor,
  type FetchRouter,
} from "../helpers/integrations-lifecycle-harness";
import {
  CatalogFilters,
  CatalogPosturePanels,
  useCatalogPosture,
} from "@/components/integrations/catalog-filters";
import {
  EMPTY_POSTURE_FILTER,
  filterCatalogByPosture,
} from "@/lib/integrations-lifecycle-api";

const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@/lib/auth-api", () => ({
  whoami: async () => auth.me,
  whoamiFresh: async () => auth.me,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

const ITEMS = [
  catalogItem(),
  catalogItem({ slug: "salesforce", name: "Salesforce" }),
  catalogItem({
    slug: "iterable",
    name: "Iterable",
    category: "marketing",
    runtime_status: "planned",
    badge: "planned",
    sources: [],
  }),
];

// The page's mount, reproduced: its own catalog rows narrowed by the posture
// filter the component owns.
function PostureHarness() {
  const posture = useCatalogPosture();
  const [filter, setFilter] = useState(EMPTY_POSTURE_FILTER);
  const shown = filterCatalogByPosture(
    ITEMS,
    filter,
    posture.connections,
    posture.stacks,
  );
  return createElement(
    "div",
    null,
    createElement(CatalogFilters, {
      value: filter,
      onChange: setFilter,
      categories: [
        { key: "crm", label: "CRM" },
        { key: "marketing", label: "Marketing" },
      ],
      posture,
    }),
    createElement(
      "ul",
      { "data-testid": "rows" },
      shown.map((item) => createElement("li", { key: item.slug }, item.name)),
    ),
  );
}

function rows(): string[] {
  return [
    ...document.querySelectorAll('[data-testid="rows"] li'),
  ].map((row) => row.textContent ?? "");
}

function select(label: string): HTMLSelectElement {
  const labelEl = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === label,
  );
  const found = document.getElementById(labelEl?.getAttribute("for") ?? "");
  if (!(found instanceof HTMLSelectElement)) {
    throw new Error(`no select labelled ${label}`);
  }
  return found;
}

let router: FetchRouter;

beforeEach(() => {
  auth.me = identity("admin");
  router = installFetchRouter({
    "GET /api/v1/integrations/connections": {
      body: {
        items: [
          connectionRow(),
          connectionRow({
            slug: "salesforce",
            health_state: "action_required",
            last_error: "refresh token revoked",
          }),
        ],
        summary: {
          total: 3,
          connected: 2,
          "health:action_required": 1,
        },
        returned: 2,
      },
    },
    "GET /api/v1/integrations/stacks": {
      body: {
        covered_pct: 50,
        target_coverage_pct: 80,
        covered_stacks: 1,
        total_stacks: 2,
        stacks: [
          {
            key: "b2b-saas",
            name: "B2B SaaS",
            status: "partial",
            required_covered: 1,
            required_total: 2,
            components: [{ slug: "hubspot", name: "HubSpot" }],
          },
        ],
      },
    },
    "GET /api/v1/integrations/readiness": {
      body: {
        ready: false,
        public_claim: "Catalog parity is not yet marketable.",
        checks: [
          {
            key: "native",
            label: "Native managed target",
            state: "gap",
            message: "62 of 70 native connectors.",
          },
        ],
        issues: [{ key: "native_gap", severity: "warning", message: "gap" }],
      },
    },
    "GET /api/v1/integrations/coverage": {
      body: {
        public_entries: 614,
        target_public_entries: 350,
        native_managed: 62,
        target_native_managed: 70,
        native_verified: 12,
        target_native_verified: 70,
        bridge_ready: 400,
        priority_gaps: [
          {
            slug: "iterable",
            name: "Iterable",
            reason: "No native connector yet.",
          },
        ],
      },
    },
    "GET /api/v1/integrations/recipes": {
      body: { items: [recipe()], summary: { total: 1, available: 1 } },
    },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("CatalogFilters", () => {
  it("narrows the catalog by workspace state, stack, category and search", async () => {
    mount(createElement(PostureHarness));
    await waitFor(() =>
      expect(select("Workspace state").disabled).toBe(false),
    );
    await waitFor(() =>
      expect(select("Customer stack").textContent).toContain("B2B SaaS"),
    );
    expect(rows()).toEqual(["HubSpot", "Salesforce", "Iterable"]);

    await type(select("Workspace state"), "attention");
    expect(rows()).toEqual(["Salesforce"]);
    expect(text()).toContain("1 active filter");

    await type(select("Workspace state"), "all");
    await type(select("Customer stack"), "b2b-saas");
    expect(rows()).toEqual(["HubSpot"]);

    await type(select("Customer stack"), "");
    await type(select("Category"), "marketing");
    expect(rows()).toEqual(["Iterable"]);

    await click(buttonNamed("Reset filters"));
    expect(rows()).toEqual(["HubSpot", "Salesforce", "Iterable"]);
    expect(
      router.requests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "GET /api/v1/integrations/connections",
      "GET /api/v1/integrations/stacks",
    ]);
  });

  it("pauses the workspace-state filter with the server's reason when connections fail", async () => {
    router.route("GET /api/v1/integrations/connections", {
      status: 503,
      body: {
        error: {
          code: "tenant_tx_failed",
          message: "could not open tenant-scoped transaction",
        },
      },
    });
    mount(createElement(PostureHarness));
    await waitFor(() =>
      expect(text()).toContain("could not open tenant-scoped transaction"),
    );
    expect(select("Workspace state").disabled).toBe(true);
    expect(buttonNamed("Retry loading filters")).toBeDefined();
  });
});

describe("CatalogPosturePanels", () => {
  it("renders readiness, coverage, stacks and recipes, and Retry verification re-reads readiness", async () => {
    mount(createElement(CatalogPosturePanels));
    await waitFor(() =>
      expect(text()).toContain("Catalog parity is not yet marketable."),
    );
    await waitFor(() => expect(text()).toContain("614 of 350"));
    expect(text()).toContain("Not ready");
    expect(text()).toContain("62 of 70 native connectors.");
    expect(text()).toContain("Iterable — No native connector yet.");
    expect(text()).toContain("1 of 2 stacks covered");
    expect(text()).toContain("1 ready of 1");
    await waitFor(() =>
      expect(text()).toContain("2 configured · 1 need attention"),
    );

    router.route("GET /api/v1/integrations/readiness", {
      body: {
        ready: true,
        public_claim: "Catalog parity verified.",
        checks: [],
        issues: [],
      },
    });
    await click(buttonNamed("Retry verification"));
    await waitFor(() => expect(text()).toContain("Catalog parity verified."));
    expect(text()).toContain("Ready");
    expect(
      router.requests.filter(
        (request) => request.path === "/api/v1/integrations/readiness",
      ),
    ).toHaveLength(2);
  });

  it("a failed readiness read is shown as a failure, not a passing check", async () => {
    router.route("GET /api/v1/integrations/readiness", {
      status: 500,
      body: { error: { code: "internal", message: "readiness exploded" } },
    });
    mount(createElement(CatalogPosturePanels));
    await waitFor(() => expect(text()).toContain("readiness exploded"));
    expect(text()).not.toContain("Not ready");
  });
});
