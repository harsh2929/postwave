import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createAeoOperationsMethods,
  type AeoOperationsDependencies,
  type AeoRequester,
  type AeoRequestOptions,
} from "../../lib/api/aeo-operations";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AeoRequestOptions | undefined;
}

const METHOD_NAMES = [
  "getAEOSettings",
  "putAEOSettings",
  "getAEOSummary",
  "listAEORollups",
  "listAEOPrompts",
  "createAEOPrompt",
  "toggleAEOPrompt",
  "deleteAEOPrompt",
  "listAEOProbes",
  "listAEOCompetitors",
  "upsertAEOCompetitor",
  "deleteAEOCompetitor",
  "runAEONow",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: AeoRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AeoRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: AeoOperationsDependencies = { request };
  return {
    calls,
    methods: createAeoOperationsMethods(dependencies),
  };
}

describe("AEO operations API extraction contracts", () => {
  it("retains the exact ordered 13-method inventory without eager work", () => {
    const { calls, methods } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
  });

  it("preserves settings, summary, rollup, and prompt-list transports", async () => {
    const { calls, methods } = createHarness();
    const settings = {
      enabled: true,
      brand_terms: ["Moosewave"],
      brand_domain: "moosewave.com",
    };

    await methods.getAEOSettings();
    await methods.putAEOSettings(settings);
    await methods.getAEOSummary();
    await methods.listAEORollups({ engine: "chatgpt", days: 30 });
    await methods.listAEOPrompts({ enabledOnly: true });

    expect(calls).toEqual([
      { path: "/api/v1/aeo/settings", init: undefined, opts: undefined },
      {
        path: "/api/v1/aeo/settings",
        init: { method: "PUT", body: JSON.stringify(settings) },
        opts: undefined,
      },
      { path: "/api/v1/aeo/summary", init: undefined, opts: undefined },
      {
        path: "/api/v1/aeo/rollups?engine=chatgpt&days=30",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/prompts?enabled_only=true",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves prompt creation, toggle, and deletion transports", async () => {
    const { calls, methods } = createHarness();
    const input = {
      category: "comparison" as const,
      prompt_text: "Compare Moosewave with alternatives",
    };

    await methods.createAEOPrompt(input);
    await methods.toggleAEOPrompt("prompt/one", false);
    await methods.deleteAEOPrompt("prompt/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/aeo/prompts",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/prompts/prompt%2Fone/toggle",
        init: {
          method: "POST",
          body: JSON.stringify({ enabled: false }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/prompts/prompt%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves probe and competitor listing and mutation transports", async () => {
    const { calls, methods } = createHarness();
    const competitor = {
      competitor_key: "ac/me",
      display_name: "ACME",
      terms: ["ACME"],
      domain: "acme.example",
    };

    await methods.listAEOProbes({
      engine: "perplexity",
      promptId: "prompt/one",
      limit: 50,
    });
    await methods.listAEOCompetitors();
    await methods.upsertAEOCompetitor(competitor);
    await methods.deleteAEOCompetitor("ac/me");

    expect(calls).toEqual([
      {
        path: "/api/v1/aeo/probes?engine=perplexity&prompt_id=prompt%2Fone&limit=50",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/competitors",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/competitors",
        init: { method: "PUT", body: JSON.stringify(competitor) },
        opts: undefined,
      },
      {
        path: "/api/v1/aeo/competitors/ac%2Fme",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves the explicit run-now POST body", async () => {
    const { calls, methods } = createHarness();

    await methods.runAEONow();

    expect(calls).toEqual([
      {
        path: "/api/v1/aeo/run-now",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("retains empty-query defaults and passes request errors through unchanged", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.getAEOSettings()).resolves.toBe(expectedError);
    await methods.listAEORollups();
    await methods.listAEOPrompts();
    await methods.listAEOProbes();

    expect(calls).toEqual([
      { path: "/api/v1/aeo/settings", init: undefined, opts: undefined },
      { path: "/api/v1/aeo/rollups", init: undefined, opts: undefined },
      { path: "/api/v1/aeo/prompts", init: undefined, opts: undefined },
      { path: "/api/v1/aeo/probes", init: undefined, opts: undefined },
    ]);
  });
});
