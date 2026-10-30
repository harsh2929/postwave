import { describe, expect, it } from "vitest";

import {
  a11yApi,
  campaignCloneApi,
  contentOptimizerApi,
  contentRemixApi,
  controlGroupsApi,
  emailBlocksApi,
  emailValidationApi,
  fromNamePickerApi,
  holdoutApi,
  linkCheckerApi,
  resendUnopenedApi,
  sendWindowApi,
  subjectAnalyzerApi,
  translationsApi,
  utmTemplatesApi,
} from "../../lib/api-client";
import {
  createCampaignAuthoringApis,
  type CampaignAuthoringDependencies,
  type CampaignAuthoringRequestOptions,
  type CampaignAuthoringRequester,
} from "../../lib/api/campaign-authoring";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: CampaignAuthoringRequestOptions | undefined;
}

interface NativeCall {
  input: string;
  init: RequestInit | undefined;
}

function recordingRequester(responses: ApiResult<unknown>[] = []): {
  calls: RequestCall[];
  request: CampaignAuthoringRequester;
} {
  const calls: RequestCall[] = [];
  const request: CampaignAuthoringRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: CampaignAuthoringRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  return { calls, request };
}

const LLM_OPTIONS = { timeoutMs: 60_000, maxAttempts: 1 } as const;

function campaignDependencies(
  overrides: Partial<CampaignAuthoringDependencies> = {},
): CampaignAuthoringDependencies {
  return {
    apiUrl: (path) => `https://api.example.test${path}`,
    errorFromResponse: async () => ({
      message: "download rejected",
      kind: "http",
      status: 403,
    }),
    getApiKey: () => "  pw_test_secret  ",
    llmRequestOptions: LLM_OPTIONS,
    nativeFetch: async () =>
      new Response("term,es\nHello,Hola\n", {
        headers: {
          "Content-Disposition": 'attachment; filename="dictionary-es.csv"',
          "Content-Type": "text/csv",
        },
      }),
    normalizeApiKey: (key) => key?.trim() || null,
    transportError: () => ({
      message: "download transport failed",
      kind: "network",
    }),
    ...overrides,
  };
}

const DOMAIN_OPERATIONS = {
  emailBlocksApi: ["catalog", "compose"],
  sendWindowApi: ["get", "upsert", "check", "remove"],
  a11yApi: ["check"],
  translationsApi: [
    "getSettings",
    "putSettings",
    "listDictionary",
    "upsertDictionaryEntry",
    "deleteDictionaryEntry",
    "importDictionaryCSV",
    "exportDictionaryCSV",
    "preview",
  ],
  fromNamePickerApi: ["list"],
  linkCheckerApi: ["check"],
  utmTemplatesApi: [
    "list",
    "upsertDefault",
    "upsertCampaign",
    "remove",
    "preview",
  ],
  subjectAnalyzerApi: ["buckets", "score"],
  emailValidationApi: ["check", "checkBatch"],
  resendUnopenedApi: ["resend"],
  campaignCloneApi: ["clone"],
  holdoutApi: ["create", "get", "remove", "lift"],
  controlGroupsApi: ["list", "create", "get", "update", "remove", "report"],
  contentOptimizerApi: ["get", "preview", "createRun"],
  contentRemixApi: ["remix"],
} as const;

const COMPOSED_FACADES = {
  emailBlocksApi,
  sendWindowApi,
  a11yApi,
  translationsApi,
  fromNamePickerApi,
  linkCheckerApi,
  utmTemplatesApi,
  subjectAnalyzerApi,
  emailValidationApi,
  resendUnopenedApi,
  campaignCloneApi,
  holdoutApi,
  controlGroupsApi,
  contentOptimizerApi,
  contentRemixApi,
};

describe("campaign authoring API extraction contracts", () => {
  it("retains all 15 facades and all 42 factory/composed operations", () => {
    const { request } = recordingRequester();
    const created = createCampaignAuthoringApis(
      request,
      campaignDependencies(),
    );

    expect(Object.keys(created)).toEqual(Object.keys(DOMAIN_OPERATIONS));
    expect(
      Object.values(DOMAIN_OPERATIONS).reduce(
        (total, operations) => total + operations.length,
        0,
      ),
    ).toBe(42);
    for (const name of Object.keys(
      DOMAIN_OPERATIONS,
    ) as (keyof typeof DOMAIN_OPERATIONS)[]) {
      expect(Object.keys(created[name])).toEqual(DOMAIN_OPERATIONS[name]);
      expect(Object.keys(COMPOSED_FACADES[name])).toEqual(
        DOMAIN_OPERATIONS[name],
      );
    }
  });

  it("preserves block, send-window, and accessibility request contracts", async () => {
    const { calls, request } = recordingRequester();
    const {
      emailBlocksApi: blocks,
      sendWindowApi: window,
      a11yApi: a11y,
    } = createCampaignAuthoringApis(request, campaignDependencies());
    const brand = {
      primary_color: "#112233",
      body_font: "Inter",
      heading_font: "Fraunces",
      background_color: "#ffffff",
    };

    await blocks.catalog();
    await blocks.compose({
      brand,
      blocks: [{ block_id: "hero/one", config: { title: "Hello" } }],
      subscriber_email: "reader@example.test",
      subject: "Welcome",
    });
    await window.get();
    await window.upsert({
      start_local: "09:00",
      end_local: "17:00",
      timezone: "Asia/Kolkata",
      weekday_bitmap: 62,
      enforcement: "block",
    });
    await window.check("2026-07-15T10:00:00Z");
    await window.remove();
    await a11y.check({ html: "<h1>Hello</h1>", subject: "Welcome" });

    expect(calls).toEqual([
      {
        path: "/api/v1/email-blocks/catalog",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/email-blocks/compose",
        init: {
          method: "POST",
          body: JSON.stringify({
            brand,
            blocks: [{ block_id: "hero/one", config: { title: "Hello" } }],
            subscriber_email: "reader@example.test",
            subject: "Welcome",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/send-window",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/send-window",
        init: {
          method: "PUT",
          body: JSON.stringify({
            start_local: "09:00",
            end_local: "17:00",
            timezone: "Asia/Kolkata",
            weekday_bitmap: 62,
            enforcement: "block",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/send-window/check",
        init: {
          method: "POST",
          body: JSON.stringify({ scheduled_at: "2026-07-15T10:00:00Z" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/send-window",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/a11y/check",
        init: {
          method: "POST",
          body: JSON.stringify({
            html: "<h1>Hello</h1>",
            subject: "Welcome",
          }),
        },
        opts: undefined,
      },
    ]);
  });

  it("preserves every JSON translation route, CSV body, and LLM policy", async () => {
    const { calls, request } = recordingRequester();
    const { translationsApi: api } = createCampaignAuthoringApis(
      request,
      campaignDependencies(),
    );

    await api.getSettings();
    await api.putSettings({
      enabled: true,
      default_locale: "en",
      supported_locales: ["en", "es"],
      fallback_strategy: "default",
      locale_attribute: "locale",
    });
    await api.listDictionary();
    await api.upsertDictionaryEntry({
      term: "Hello",
      translations: { es: "Hola" },
      case_sensitive: true,
      notes: "Greeting",
    });
    await api.deleteDictionaryEntry("entry/one");
    await api.importDictionaryCSV("term,es\nHello,Hola\n");
    await api.preview({ body: "Hello", locale: "es-MX" });

    expect(calls).toEqual([
      {
        path: "/api/v1/translations/settings",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/translations/settings",
        init: {
          method: "PUT",
          body: JSON.stringify({
            enabled: true,
            default_locale: "en",
            supported_locales: ["en", "es"],
            fallback_strategy: "default",
            locale_attribute: "locale",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/translations/dictionary",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/translations/dictionary",
        init: {
          method: "POST",
          body: JSON.stringify({
            term: "Hello",
            translations: { es: "Hola" },
            case_sensitive: true,
            notes: "Greeting",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/translations/dictionary/entry%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/translations/dictionary/import",
        init: {
          method: "POST",
          body: "term,es\nHello,Hola\n",
          headers: { "Content-Type": "text/csv" },
        },
        opts: undefined,
      },
      {
        path: "/api/v1/translations/preview",
        init: {
          method: "POST",
          body: JSON.stringify({ body: "Hello", locale: "es-MX" }),
        },
        opts: LLM_OPTIONS,
      },
    ]);
  });

  it("preserves authenticated native CSV export and filename parsing", async () => {
    const { calls, request } = recordingRequester();
    const nativeCalls: NativeCall[] = [];
    const normalizedKeys: Array<string | null | undefined> = [];
    const dependencies = campaignDependencies({
      nativeFetch: async (input, init) => {
        nativeCalls.push({ input, init });
        return new Response("term,es\nHello,Hola\n", {
          headers: {
            "Content-Disposition": 'attachment; filename="dictionary-es.csv"',
          },
        });
      },
      normalizeApiKey: (key) => {
        normalizedKeys.push(key);
        return key?.trim() || null;
      },
    });

    const result = await createCampaignAuthoringApis(
      request,
      dependencies,
    ).translationsApi.exportDictionaryCSV();

    expect(calls).toEqual([]);
    expect(normalizedKeys).toEqual(["  pw_test_secret  "]);
    expect(nativeCalls).toEqual([
      {
        input:
          "https://api.example.test/api/v1/translations/dictionary/export.csv",
        init: {
          method: "GET",
          headers: {
            Accept: "text/csv",
            Authorization: "Bearer pw_test_secret",
          },
          mode: "cors",
          credentials: "include",
          cache: "no-store",
        },
      },
    ]);
    expect(result.error).toBeUndefined();
    if (result.error) throw new Error(result.error.message);
    expect(result.data.filename).toBe("dictionary-es.csv");
    await expect(result.data.blob.text()).resolves.toBe(
      "term,es\nHello,Hola\n",
    );
  });

  it("preserves CSV export fallback naming and exact HTTP/transport errors", async () => {
    const { request } = recordingRequester();
    const fallback = await createCampaignAuthoringApis(
      request,
      campaignDependencies({
        getApiKey: () => null,
        nativeFetch: async () => new Response("term,es\n"),
      }),
    ).translationsApi.exportDictionaryCSV();
    expect(fallback.error).toBeUndefined();
    if (fallback.error) throw new Error(fallback.error.message);
    expect(fallback.data.filename).toBe("translations-dictionary.csv");

    const httpError = {
      message: "forbidden export",
      kind: "http" as const,
      status: 403,
      code: "forbidden",
    };
    const nativeCalls: NativeCall[] = [];
    const rejected = await createCampaignAuthoringApis(
      request,
      campaignDependencies({
        getApiKey: () => null,
        errorFromResponse: async () => httpError,
        nativeFetch: async (input, init) => {
          nativeCalls.push({ input, init });
          return new Response("forbidden", { status: 403 });
        },
      }),
    ).translationsApi.exportDictionaryCSV();
    expect(rejected).toEqual({ error: httpError });
    expect(nativeCalls[0]?.init).toEqual({
      method: "GET",
      headers: { Accept: "text/csv" },
      mode: "cors",
      credentials: "include",
      cache: "no-store",
    });

    const transportError = {
      message: "native fetch failed",
      kind: "network" as const,
      code: "native_failed",
    };
    const failed = await createCampaignAuthoringApis(
      request,
      campaignDependencies({
        nativeFetch: async () => {
          throw new Error("bridge unavailable");
        },
        transportError: () => transportError,
      }),
    ).translationsApi.exportDictionaryCSV();
    expect(failed).toEqual({ error: transportError });
  });

  it("preserves from-name, link-check, and all UTM request contracts", async () => {
    const { calls, request } = recordingRequester();
    const {
      fromNamePickerApi: fromNames,
      linkCheckerApi: links,
      utmTemplatesApi: utm,
    } = createCampaignAuthoringApis(request, campaignDependencies());

    await fromNames.list({ days: 30, minCampaigns: 4 });
    await links.check("campaign/one");
    await utm.list();
    await utm.upsertDefault({
      utm_source: "newsletter",
      utm_medium: "email",
    });
    await utm.upsertCampaign("campaign/one", {
      utm_campaign: "summer & sale",
      utm_content: "hero",
    });
    await utm.remove("template/one");
    await utm.preview({
      url: "https://example.test/products?id=1",
      campaign_id: "campaign/one",
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/from-name-picker?days=30&min_campaigns=4",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/check-links",
        init: { method: "POST", body: "{}" },
        opts: { timeoutMs: 30_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/utm-templates",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/utm-templates",
        init: {
          method: "POST",
          body: JSON.stringify({
            utm_source: "newsletter",
            utm_medium: "email",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/utm-templates/campaign/campaign%2Fone",
        init: {
          method: "POST",
          body: JSON.stringify({
            utm_campaign: "summer & sale",
            utm_content: "hero",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/utm-templates/template%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/utm-templates/preview",
        init: {
          method: "POST",
          body: JSON.stringify({
            url: "https://example.test/products?id=1",
            campaign_id: "campaign/one",
          }),
        },
        opts: undefined,
      },
    ]);
  });

  it("preserves subject, validation, resend, and clone execution policies", async () => {
    const { calls, request } = recordingRequester();
    const {
      subjectAnalyzerApi: subjects,
      emailValidationApi: validation,
      resendUnopenedApi: resend,
      campaignCloneApi: clone,
    } = createCampaignAuthoringApis(request, campaignDependencies());

    await subjects.buckets(0);
    await subjects.score("A better subject?");
    await validation.check("reader+one@example.test");
    await validation.checkBatch(["one@example.test", "two@example.test"]);
    await resend.resend("campaign/one", {
      subject: "A second chance",
      name: "Resend",
      send_after_hours: 48,
    });
    await clone.clone("campaign/one", "Campaign copy");
    await clone.clone("campaign/two");

    expect(calls).toEqual([
      {
        path: "/api/v1/subject-analyzer/buckets?days=0",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subject-analyzer/score",
        init: {
          method: "POST",
          body: JSON.stringify({ subject: "A better subject?" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/email-validation/check",
        init: {
          method: "POST",
          body: JSON.stringify({ email: "reader+one@example.test" }),
        },
        opts: { timeoutMs: 15_000 },
      },
      {
        path: "/api/v1/email-validation/check-batch",
        init: {
          method: "POST",
          body: JSON.stringify({
            emails: ["one@example.test", "two@example.test"],
          }),
        },
        opts: { timeoutMs: 30_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/resend-unopened",
        init: {
          method: "POST",
          body: JSON.stringify({
            subject: "A second chance",
            name: "Resend",
            send_after_hours: 48,
          }),
        },
        opts: { requireOnline: true },
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/clone",
        init: {
          method: "POST",
          body: JSON.stringify({ name: "Campaign copy" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Ftwo/clone",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("preserves every holdout and control-group request contract", async () => {
    const { calls, request } = recordingRequester();
    const { holdoutApi: holdout, controlGroupsApi: controls } =
      createCampaignAuthoringApis(request, campaignDependencies());

    await holdout.create("campaign/one", 12.5);
    await holdout.get("campaign/one");
    await holdout.remove("campaign/one");
    await holdout.lift("campaign/one");
    await controls.list();
    await controls.create({
      name: "Q3 baseline",
      description: "Persistent control",
      percent: 10,
      seed: "seed-1",
      ends_at: "2026-09-30T00:00:00Z",
    });
    await controls.get("group/one");
    await controls.update("group/one", {
      description: "Updated",
      status: "paused",
      ends_at: "2026-10-31T00:00:00Z",
    });
    await controls.remove("group/one");
    await controls.report("group/one", 14);

    expect(calls).toEqual([
      {
        path: "/api/v1/campaigns/campaign%2Fone/holdout",
        init: {
          method: "POST",
          body: JSON.stringify({ percent: 12.5 }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/holdout",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/holdout",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/holdout/lift",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Q3 baseline",
            description: "Persistent control",
            percent: 10,
            seed: "seed-1",
            ends_at: "2026-09-30T00:00:00Z",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups/group%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups/group%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            description: "Updated",
            status: "paused",
            ends_at: "2026-10-31T00:00:00Z",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups/group%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/control-groups/group%2Fone/report?window=14",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves optimizer and remix paths, bodies, and LLM policy", async () => {
    const { calls, request } = recordingRequester();
    const { contentOptimizerApi: optimizer, contentRemixApi: remix } =
      createCampaignAuthoringApis(request, campaignDependencies());
    const previewInput = {
      arms: [
        {
          key: "a",
          subject: "Subject A",
          preview_text: "Preview A",
          body_html: "<p>A</p>",
          metadata: { source: "editor" },
        },
      ],
      exploration_rate: 0.2,
      max_active_arms: 3,
      primary_metric: "click",
      min_sample_per_arm: 100,
      persist_as_run: true,
      activation_status: "active",
    };

    await optimizer.get("campaign/one");
    await optimizer.preview("campaign/one", previewInput);
    await optimizer.createRun("campaign/one", previewInput);
    await remix.remix("campaign/one", {
      channels: ["sms", "social"],
      tone: "concise",
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/campaigns/campaign%2Fone/content-optimizer",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/content-optimizer/preview",
        init: { method: "POST", body: JSON.stringify(previewInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/content-optimizer",
        init: { method: "POST", body: JSON.stringify(previewInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/remix",
        init: {
          method: "POST",
          body: JSON.stringify({
            channels: ["sms", "social"],
            tone: "concise",
          }),
        },
        opts: LLM_OPTIONS,
      },
    ]);
  });
});
