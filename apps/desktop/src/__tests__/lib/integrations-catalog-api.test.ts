import { describe, expect, it } from "vitest";

import { createIntegrationsCatalogApi } from "../../lib/api/integrations-catalog";
import type { ApiResult } from "../../lib/api/result";

type IntegrationsRequester = Parameters<typeof createIntegrationsCatalogApi>[0];
type IntegrationsRequestOptions = Parameters<IntegrationsRequester>[2];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: IntegrationsRequestOptions;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: IntegrationsRequester;
} {
  const calls: RequestCall[] = [];
  const request: IntegrationsRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: IntegrationsRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const INTEGRATIONS_OPERATIONS = [
  "catalog",
  "connections",
  "coverage",
  "stacks",
  "readiness",
  "detail",
  "health",
  "contract",
  "recipes",
  "recipeDetail",
  "applyRecipe",
  "startConnect",
  "callback",
  "sync",
  "backfill",
  "pause",
  "disconnect",
] as const;

describe("createIntegrationsCatalogApi", () => {
  it("retains the complete 17-operation catalog facade", () => {
    const { request } = recordingRequester();

    expect(Object.keys(createIntegrationsCatalogApi(request))).toEqual(
      INTEGRATIONS_OPERATIONS,
    );
  });

  it("preserves recipe filtering and encoded detail routes", async () => {
    const { calls, request } = recordingRequester();
    const api = createIntegrationsCatalogApi(request);

    await api.recipes({
      q: "profile email",
      source: "hub/spot",
      target: "post wave",
      provider: "zapier & partner",
      badge: "native",
      capability: "sync:profiles",
      available: false,
    });
    await api.detail("hub/spot");
    await api.health("hub/spot");
    await api.contract("hub/spot");
    await api.recipeDetail("recipe/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/integrations/recipes?q=profile+email&source=hub%2Fspot&target=post+wave&provider=zapier+%26+partner&badge=native&capability=sync%3Aprofiles&available=false",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/health",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/contract",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/recipes/recipe%2Fone",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("exposes and encodes every documented connection inventory filter", async () => {
    const { calls, request } = recordingRequester();
    const api = createIntegrationsCatalogApi(request);

    await api.connections({
      footprint: false,
      connected: true,
      q: "hub spot",
      category: "CRM & support",
      health: ["action_required", "needs_attention"],
      status: "error,paused",
    });
    await api.connections();

    expect(calls).toEqual([
      {
        path: "/api/v1/integrations/connections?footprint=false&connected=true&q=hub+spot&category=CRM+%26+support&health=action_required%2Cneeds_attention&status=error%2Cpaused",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/connections",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves every action route, HTTP method, body, and default transport policy", async () => {
    const { calls, request } = recordingRequester();
    const api = createIntegrationsCatalogApi(request);

    await api.applyRecipe("recipe/one");
    await api.startConnect("hub/spot");
    await api.callback("hub/spot");
    await api.sync("hub/spot");
    await api.backfill("hub/spot");
    await api.pause("hub/spot");
    await api.disconnect("hub/spot");

    expect(calls).toEqual([
      {
        path: "/api/v1/integrations/recipes/recipe%2Fone/apply",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/connect/start",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/connect/callback",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/sync",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/backfill",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot/pause",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/integrations/hub%2Fspot",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });
});
