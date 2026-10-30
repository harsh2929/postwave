import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  analyticsExtrasApi,
  api,
  apiSendTimeAssets,
  invalidateApiUrlCache,
} from "../../lib/api-client";
import { campaignTemplateDesignsApi } from "../../lib/api/campaign-template-designs";

const localStorageStub: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

function successfulFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () =>
    Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
): unknown {
  const init = fetchMock.mock.calls[0]?.[1];
  if (!init || typeof init.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body) as unknown;
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: localStorageStub,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
  });
  invalidateApiUrlCache();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("campaign template library API contract", () => {
  it("rejects impossible leaderboard windows before making a request", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    for (const days of [0, 1.5, 366, Number.NaN]) {
      const result = await analyticsExtrasApi.templateLeaderboard({ days });
      expect(result.error?.code).toBe("invalid_template_leaderboard_days");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes the visual-catalog filters expected by search", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.searchCampaignTemplates({
      query: "weekly digest",
      goal: "newsletter",
      category: "editorial",
      source: "platform",
      provider: "Really Good Emails",
      industry: "media",
      style: "minimal",
      layout: "single column",
      kind: "reference",
      tags: ["curated", "dark"],
      featured: true,
      favorited: true,
      archived: "archived",
      page: 2,
      per_page: 50,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/api/v1/campaign-templates/search");
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      category: "editorial",
      archived: "archived",
      featured: "1",
      favorited: "1",
      goal: "newsletter",
      industry: "media",
      kind: "reference",
      layout: "single column",
      page: "2",
      per_page: "50",
      provider: "Really Good Emails",
      query: "weekly digest",
      source: "platform",
      style: "minimal",
      tags: "curated,dark",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("requires and forwards strong If-Match versions for edit, archive, and restore", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const etag = '"campaign-template:template-1:v7"';

    await api.updateCampaignTemplate(
      "template-1",
      { subject: "Concurrent-safe subject" },
      { expectedVersion: etag },
    );
    await api.archiveCampaignTemplate("template-1", etag);
    await api.restoreCampaignTemplate("template-1", etag);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map(([url, init]) => ({
        method: init?.method,
        path: new URL(String(url)).pathname,
        ifMatch: new Headers(init?.headers).get("If-Match"),
      })),
    ).toEqual([
      {
        method: "PATCH",
        path: "/api/v1/campaign-templates/template-1",
        ifMatch: etag,
      },
      {
        method: "PATCH",
        path: "/api/v1/campaign-templates/template-1/archive",
        ifMatch: etag,
      },
      {
        method: "PATCH",
        path: "/api/v1/campaign-templates/template-1/restore",
        ifMatch: etag,
      },
    ]);

    fetchMock.mockClear();
    const blocked = await api.updateCampaignTemplate(
      "template-1",
      { subject: "Unsafe" },
      { expectedVersion: 'W/"weak"' },
    );
    expect(blocked.error?.code).toBe("campaign_template_etag_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses bounded read-only lifecycle revision routes", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.listCampaignTemplateRevisions("template/one", {
      page: 2,
      per_page: 20,
    });
    await api.getCampaignTemplateRevision("template/one", 7);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://localhost:8080/api/v1/campaign-templates/template%2Fone/revisions?page=2&per_page=20",
      "http://localhost:8080/api/v1/campaign-templates/template%2Fone/revisions/7",
    ]);
  });

  it("posts adaptation and generation jobs to the durable design route", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const adaptation = {
      mode: "adapt" as const,
      source_template_id: "reference/one",
      instructions: "Keep the hierarchy and adapt it for our July roundup.",
      tone: "warm",
      reference_template_ids: ["reference-2"],
    };

    await campaignTemplateDesignsApi.create(adaptation, {
      idempotencyKey: "desktop-design-create-attempt-1",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:8080/api/v1/campaign-template-designs",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(
      (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        "Idempotency-Key"
      ],
    ).toBe("desktop-design-create-attempt-1");
    expect(requestBody(fetchMock)).toEqual(adaptation);

    fetchMock.mockClear();
    const generation = {
      mode: "generate" as const,
      brief: "A monthly product and community newsletter",
      kind: "newsletter" as const,
      tone: "clear and energetic",
      category: "editorial",
      subject: "Creator Dispatch",
      preview_text: "Products, people, and practical ideas",
      audience: "independent creators",
      industry: "media",
      style: "minimal",
      layout: "editorial digest",
      variables: { edition: "July" },
      reference_template_ids: ["reference-1"],
    };

    await campaignTemplateDesignsApi.create(generation);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:8080/api/v1/campaign-template-designs",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(requestBody(fetchMock)).toEqual(generation);
  });

  it("commits only an exact reviewed revision/hash through the durable save route", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      revision: 3,
      output_hash: "a".repeat(64),
      slug: "creator-dispatch-reviewed",
      name: "Creator Dispatch",
      subject: "Products, people, and practical ideas",
      preview_text: "The reviewed July edition",
    };

    await campaignTemplateDesignsApi.save("design/one", input, {
      idempotencyKey: "desktop-design-save-attempt-1",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:8080/api/v1/campaign-template-designs/design%2Fone/save",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(
      (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)[
        "Idempotency-Key"
      ],
    ).toBe("desktop-design-save-attempt-1");
    expect(requestBody(fetchMock)).toEqual(input);
    expect(requestBody(fetchMock)).not.toHaveProperty("body_html");
  });

  it("keeps server-controlled governance out of ordinary authoring creates", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await api.createCampaignTemplate({
      slug: "workspace-authored",
      name: "Workspace authored",
      subject: "A normal authoring request",
      body_html: "<p>Owned copy</p>",
      goal: "newsletter",
    });

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty("reference_template_ids");
    expect(body).not.toHaveProperty("generation_metadata");
    expect(body).not.toHaveProperty("review_status");
    expect(body).not.toHaveProperty("source_license_status");
  });

  it("creates campaign drafts through the from-template route", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      template_id: "template-1",
      name: "July newsletter",
      list_id: 42,
      variables: { first_name: "Ada" },
    };

    await api.createCampaignFromTemplate(input);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost:8080/api/v1/campaigns/from-template",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(requestBody(fetchMock)).toEqual(input);
  });

  it("keeps a missing saved-block endpoint distinct from a verified empty library", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "not_found", message: "Saved blocks unavailable" },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiSendTimeAssets.listSavedBlocks();

    expect(result.error?.status).toBe(404);
    expect(result.data).toBeUndefined();
  });

  it("carries create-only zero and exact asset/content revisions on every desktop write", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const id = "00000000-0000-4000-8000-000000000002";

    await apiSendTimeAssets.uploadAsset({
      filename: "hero.png",
      mime: "image/png",
      content_base64: "iVBORw==",
    });
    await apiSendTimeAssets.patchAsset(id, {
      alt_text: "Hero",
      expected_version: 7,
    });
    await apiSendTimeAssets.deleteAsset(id, {
      expectedVersion: 7,
      force: true,
    });
    await apiSendTimeAssets.createAssetFolder("Launch");
    await apiSendTimeAssets.renameAssetFolder(id, "Launch 2", 4);
    await apiSendTimeAssets.deleteAssetFolder(id, 5);
    await apiSendTimeAssets.createSavedBlock({
      name: "Hero",
      kind: "block",
      body_html: "<p>Hero</p>",
      body_json: {},
    });
    await apiSendTimeAssets.deleteSavedBlock(id, 3);

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    }));
    expect(requests[0]?.body).toMatchObject({ expected_version: 0 });
    expect(requests[1]?.body).toEqual({
      alt_text: "Hero",
      expected_version: 7,
    });
    expect(requests[2]).toMatchObject({
      url: expect.not.stringContaining("force="),
      method: "DELETE",
      body: { expected_version: 7, force: true },
    });
    expect(requests[3]?.body).toEqual({
      name: "Launch",
      expected_version: 0,
    });
    expect(requests[4]?.body).toEqual({
      name: "Launch 2",
      expected_version: 4,
    });
    expect(requests[5]?.body).toEqual({ expected_version: 5 });
    expect(requests[6]?.body).toMatchObject({ expected_version: 0 });
    expect(requests[7]?.body).toEqual({ expected_version: 3 });
  });
});

describe("campaign template library UI wiring", () => {
  const readComponent = (name: string): string =>
    readFileSync(new URL(`../../components/${name}`, import.meta.url), "utf8");

  it("routes AI generation, adaptation, refinement, and commits through durable designs", () => {
    const source = readComponent("templates/AiTemplateGeneratorModal.tsx");
    const designClient = readFileSync(
      new URL("../../lib/api/campaign-template-designs.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("campaignTemplateDesignsApi.create(input");
    expect(source).toContain("campaignTemplateDesignsApi.refine(");
    expect(source).toContain("base_revision: selectedRevision.revision");
    expect(source).toContain(
      "campaignTemplateDesignsApi.save<CampaignTemplate>",
    );
    expect(source).toContain("output_hash: revision.output_hash");
    expect(source).toContain("buildTemplateDirection({");
    expect(designClient).toContain('"/api/v1/campaign-template-designs"');
    expect(designClient).toContain("/create-campaign");
    expect(designClient).not.toContain("from-generated-design");
  });

  it("adapts references and directly creates campaigns from editable templates", () => {
    const source = readComponent("TemplateDetailSlideover.tsx");

    expect(source).toContain('working.template_kind === "reference"');
    expect(source).toContain("onAdapt(working)");
    expect(source).toContain("api.createCampaignFromTemplate({");
    expect(source).toContain("template_id: working.id");
  });

  it("keeps compact and coarse template controls at a 44px touch target", () => {
    const styles = readFileSync(
      new URL("../../styles-templates-v2.css", import.meta.url),
      "utf8",
    );
    const mediaStart = styles.indexOf(
      "@media (pointer: coarse), (max-width: 720px)",
    );
    const mediaEnd = styles.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      mediaStart,
    );
    const touchTargets = styles.slice(mediaStart, mediaEnd);

    expect(mediaStart).toBeGreaterThanOrEqual(0);
    expect(mediaEnd).toBeGreaterThan(mediaStart);
    for (const selector of [
      ".tpl-page-surface .btn",
      ".tpl-page-surface .btn-sm",
      ".tpl-page-surface .input",
      ".tpl-page-surface .tpl-card-compare",
      ".tpl-page-surface .chips.goal-rail .chip",
      '.tpl-page-surface .tpl-discovery-tabs [role="tab"]',
      ".tpl-page-surface .tpl-discovery-picker select",
    ]) {
      expect(touchTargets).toContain(selector);
    }
    expect(touchTargets).toContain("min-height: 44px");
    expect(touchTargets).toContain("min-width: 44px");
  });
});
