// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// ConnectorDetailPanels: GET /api/v1/integrations/{slug} feeds the connection,
// lifecycle, health, contract, setup and recipe panels; "Re-check health"
// sends GET …/{slug}/health and "Re-read contract" GET …/{slug}/contract and
// each replaces its panel with the fresh read. A failed or mismatched detail
// renders as a failure, never as an empty connector.

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONN,
  buttonNamed,
  catalogItem,
  click,
  contract,
  detailBody,
  healthReport,
  identity,
  installFetchRouter,
  mount,
  text,
  unmountAll,
  waitFor,
  type FetchRouter,
} from "../helpers/integrations-lifecycle-harness";
import { ConnectorDetailPanels } from "@/components/integrations/connector-detail-panels";

const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@/lib/auth-api", () => ({
  whoami: async () => auth.me,
  whoamiFresh: async () => auth.me,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

let router: FetchRouter;

function reads(): string[] {
  return router.requests
    .filter((request) => request.method === "GET")
    .map((request) => request.path);
}

beforeEach(() => {
  auth.me = identity("admin");
  router = installFetchRouter({
    "GET /api/v1/integrations/hubspot": { body: detailBody() },
    "GET /api/v1/integrations/hubspot/health": {
      body: healthReport({
        state: "needs_attention",
        message: "Token expires in 2 days; re-authorize HubSpot.",
      }),
    },
    "GET /api/v1/integrations/hubspot/contract": {
      body: contract({
        native_verified: true,
        public_claim: "API-verified HubSpot contact sync.",
      }),
    },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("ConnectorDetailPanels", () => {
  it("renders the server's detail: lifecycle verbs, health, contract, recipes", async () => {
    mount(createElement(ConnectorDetailPanels, { slug: "hubspot" }));
    await waitFor(() => expect(text()).toContain("Last pull completed."));
    expect(reads()).toEqual(["/api/v1/integrations/hubspot"]);
    expect(text()).toContain("Native CRM foundation with managed OAuth.");
    expect(text()).toContain("Native foundation — verification incomplete");
    expect(text()).toContain("Credential reference — Vault reference resolves.");
    expect(text()).toContain(`Action target: ${CONN}`);
    expect(buttonNamed("Backfill")).toBeDefined();
    expect(text()).toContain("HubSpot contacts → Moosewave list");
    expect(text()).toContain("Store the credential");
  });

  it("Re-check health GETs the health route and replaces the report", async () => {
    mount(createElement(ConnectorDetailPanels, { slug: "hubspot" }));
    await waitFor(() => expect(text()).toContain("Last pull completed."));

    await click(buttonNamed("Re-check health"));
    await waitFor(() =>
      expect(text()).toContain("Token expires in 2 days; re-authorize HubSpot."),
    );
    expect(text()).not.toContain("Last pull completed.");
    expect(reads()).toEqual([
      "/api/v1/integrations/hubspot",
      "/api/v1/integrations/hubspot/health",
    ]);
  });

  it("Re-read contract GETs the contract route and replaces the contract", async () => {
    mount(createElement(ConnectorDetailPanels, { slug: "hubspot" }));
    await waitFor(() =>
      expect(text()).toContain("Native CRM foundation with managed OAuth."),
    );

    await click(buttonNamed("Re-read contract"));
    await waitFor(() =>
      expect(text()).toContain("API-verified HubSpot contact sync."),
    );
    expect(text()).toContain("API-verified native contract");
    expect(reads()).toEqual([
      "/api/v1/integrations/hubspot",
      "/api/v1/integrations/hubspot/contract",
    ]);
  });

  it("a detail for another integration renders as a failed read", async () => {
    router.route("GET /api/v1/integrations/hubspot", {
      body: detailBody({ item: catalogItem({ slug: "salesforce" }) }),
    });
    mount(createElement(ConnectorDetailPanels, { slug: "hubspot" }));
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "malformed or mismatched integration detail",
      ),
    );
    expect(buttonNamed("Backfill")).toBeUndefined();
  });
});
