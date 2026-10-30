// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// RecipeApplyDialog: opening reads GET /api/v1/integrations/recipes/{id};
// "Prepare setup plan" POSTs …/{id}/apply with an empty body and renders the
// server's handoff (owning endpoint, fields, next steps) while saying no
// automation was created. A planned recipe or a non-admin sends no POST.

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buttonNamed,
  catalogItem,
  click,
  identity,
  installFetchRouter,
  mount,
  recipe,
  text,
  unmountAll,
  waitFor,
  type FetchRouter,
} from "../helpers/integrations-lifecycle-harness";
import {
  RECIPE_PLANNED_REASON,
  RecipeApplyDialog,
} from "@/components/integrations/recipe-apply-dialog";
import { ADMIN_REQUIRED_REASON } from "@/components/integrations/use-integration-lifecycle-authority";

const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("@/lib/auth-api", () => ({
  whoami: async () => auth.me,
  whoamiFresh: async () => auth.me,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

const ID = "hubspot-contacts-to-list";
let router: FetchRouter;

function render(available = true) {
  mount(
    createElement(RecipeApplyDialog, {
      recipe: { id: ID, name: "HubSpot contacts → Moosewave list", available },
      open: true,
      onOpenChange: () => {},
    }),
  );
}

beforeEach(() => {
  auth.me = identity("owner");
  router = installFetchRouter({
    [`GET /api/v1/integrations/recipes/${ID}`]: {
      body: { recipe: recipe(), source: catalogItem() },
    },
    [`POST /api/v1/integrations/recipes/${ID}/apply`]: {
      status: 202,
      body: {
        recipe_id: ID,
        status: "delegated",
        message:
          "Open the owning Moosewave surface and configure this recipe with the provided blueprint.",
        delegated_to: "POST /api/v1/crm/integrations",
        manage_path: "/integrations",
        required_fields: ["credentials_ref", "email"],
        next_steps: [
          { title: "Connect HubSpot", description: "Authorize the CRM." },
        ],
        blueprint: {},
      },
    },
  });
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe("RecipeApplyDialog", () => {
  it("reviews the blueprint, then POSTs apply and renders the delegated plan", async () => {
    render();
    await waitFor(() => expect(text()).toContain("contact.updated"));
    expect(text()).toContain("crm.objects.contacts.read");
    expect(text()).toContain("From HubSpot");
    expect(router.writes()).toEqual([]);

    await waitFor(() =>
      expect(buttonNamed("Prepare setup plan")?.disabled).toBe(false),
    );
    await click(buttonNamed("Prepare setup plan"));

    await waitFor(() =>
      expect(text()).toContain("Setup plan ready — no automation was created"),
    );
    expect(text()).toContain("POST /api/v1/crm/integrations");
    expect(text()).toContain("credentials_ref");
    expect(text()).toContain("Continue in Integrations");
    expect(router.writes()).toEqual([
      {
        method: "POST",
        path: `/api/v1/integrations/recipes/${ID}/apply`,
        search: "",
        body: {},
      },
    ]);
    expect(buttonNamed("Setup plan prepared")?.disabled).toBe(true);
  });

  it("renders the server's refusal when preparation fails", async () => {
    router.route(`POST /api/v1/integrations/recipes/${ID}/apply`, {
      status: 404,
      body: { error: { code: "recipe_not_found", message: "recipe not found" } },
    });
    render();
    await waitFor(() =>
      expect(buttonNamed("Prepare setup plan")?.disabled).toBe(false),
    );
    await click(buttonNamed("Prepare setup plan"));
    await waitFor(() => expect(text()).toContain("recipe not found"));
    expect(text()).not.toContain("Setup plan ready");
  });

  it("a planned recipe is reviewable but never prepared", async () => {
    router.route(`GET /api/v1/integrations/recipes/${ID}`, {
      body: { recipe: recipe({ available: false }), source: catalogItem() },
    });
    render(false);
    await waitFor(() => expect(text()).toContain(RECIPE_PLANNED_REASON));
    expect(buttonNamed("Prepare setup plan")?.disabled).toBe(true);
    await click(buttonNamed("Prepare setup plan"));
    expect(router.writes()).toEqual([]);
  });

  it("an editor can review but not prepare", async () => {
    auth.me = identity("editor");
    render();
    await waitFor(() => expect(text()).toContain("contact.updated"));
    expect(text()).toContain(ADMIN_REQUIRED_REASON);
    expect(buttonNamed("Prepare setup plan")?.disabled).toBe(true);
    expect(router.writes()).toEqual([]);
  });
});
