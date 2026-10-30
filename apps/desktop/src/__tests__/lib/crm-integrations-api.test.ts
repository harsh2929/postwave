import { describe, expect, it } from "vitest";

import { createCrmIntegrationsApi } from "../../lib/api/crm-integrations";
import type { ApiResult } from "../../lib/api/result";

type CrmRequester = Parameters<typeof createCrmIntegrationsApi>[0];
type CrmRequestOptions = Parameters<CrmRequester>[2];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: CrmRequestOptions;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: CrmRequester;
} {
  const calls: RequestCall[] = [];
  const request: CrmRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: CrmRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const CRM_OPERATIONS = [
  "oauthAvailability",
  "oauthStartUrl",
  "providers",
  "list",
  "create",
  "sync",
  "backfill",
  "pause",
  "disconnect",
  "runs",
] as const;

describe("createCrmIntegrationsApi", () => {
  it("retains the complete ten-operation CRM facade", () => {
    const { request } = recordingRequester();

    expect(
      Object.keys(createCrmIntegrationsApi(request, (path) => path)),
    ).toEqual(CRM_OPERATIONS);
  });

  it("builds encoded OAuth availability and start URLs", async () => {
    const { calls, request } = recordingRequester();
    const api = createCrmIntegrationsApi(
      request,
      (path) => `https://api.example.test${path}`,
    );

    await api.oauthAvailability("sales/force");
    expect(
      api.oauthStartUrl("sales/force", {
        redirect_to: "/settings/integrations?tab=crm",
        reconnect: true,
        attempts: 2,
        empty: "",
        absent: undefined,
        nullable: null,
      }),
    ).toBe(
      "https://api.example.test/api/v1/crm/sales%2Fforce/oauth/start?redirect_to=%2Fsettings%2Fintegrations%3Ftab%3Dcrm&reconnect=true&attempts=2",
    );
    expect(calls).toEqual([
      {
        path: "/api/v1/crm/sales%2Fforce/oauth/availability",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves CRUD, execution, and run-history transport contracts", async () => {
    const { calls, request } = recordingRequester();
    const api = createCrmIntegrationsApi(request, (path) => path);
    const input = {
      provider: "hubspot",
      name: "CRM primary",
      scopes: ["contacts:read"],
    };

    await api.providers();
    await api.list();
    await api.create(input);
    await api.sync("crm/one", { cursor: "next" });
    await api.backfill("crm/one", { since: "2026-01-01" });
    await api.pause("crm/one");
    await api.disconnect("crm/one");
    await api.runs("crm/one");
    await api.runs("crm/two", 7);

    expect(calls).toEqual([
      { path: "/api/v1/crm/providers", init: undefined, opts: undefined },
      { path: "/api/v1/crm/integrations", init: undefined, opts: undefined },
      {
        path: "/api/v1/crm/integrations",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/crm/integrations/crm%2Fone/sync",
        init: { method: "POST", body: JSON.stringify({ cursor: "next" }) },
        opts: { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/crm/integrations/crm%2Fone/backfill",
        init: {
          method: "POST",
          body: JSON.stringify({ since: "2026-01-01" }),
        },
        opts: { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/crm/integrations/crm%2Fone/pause",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/crm/integrations/crm%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/crm/integrations/crm%2Fone/runs?limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/crm/integrations/crm%2Ftwo/runs?limit=7",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
