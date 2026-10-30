// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CampaignTemplateDesignWaitError,
  archiveCampaignTemplateDesign,
  archiveCampaignTemplate,
  buildCampaignTemplateSearchPath,
  campaignTemplateActionReason,
  campaignTemplateCapabilities,
  campaignTemplateCapabilityLabel,
  campaignTemplateExportableSource,
  campaignTemplateHostedPreviewAssets,
  campaignTemplatePreviewUrl,
  campaignTemplateThumbnailSource,
  campaignTemplateThumbnailUrl,
  clearRecentCampaignTemplateViews,
  compareCampaignTemplates,
  createCampaignFromTemplateDesign,
  createCampaignTemplateCollection,
  createCampaignTemplateDesign,
  createCampaignTemplateSavedSearch,
  deleteCampaignTemplateSavedSearch,
  facetOptions,
  getCampaignTemplateRevision,
  isOwnedCampaignTemplate,
  isVisualOnlyCampaignTemplate,
  listCampaignTemplateDesigns,
  normalizeCampaignTemplateSearchResponse,
  refineCampaignTemplateDesign,
  replaceCampaignTemplateCollectionItems,
  runCampaignTemplateSavedSearch,
  saveCampaignTemplateDesign,
  templateSlugFromName,
  restoreCampaignTemplate,
  restoreCampaignTemplateRevision,
  updateCampaignTemplate,
  waitForCampaignTemplateDesign,
  type CampaignTemplateDesignDraft,
  type CampaignTemplate,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function designDraft(
  overrides: Partial<CampaignTemplateDesignDraft> = {},
): CampaignTemplateDesignDraft {
  return {
    id: "018f4f51-1a2b-7c3d-8e4f-123456789abc",
    mode: "generate",
    status: "queued",
    reference_template_ids: [],
    current_revision: 0,
    attempt_count: 0,
    capabilities: {
      can_refine: false,
      can_retry: false,
      can_save: false,
      can_create_campaign: false,
      can_archive: true,
    },
    recommended_action: "poll_campaign_template_design",
    retry_after_seconds: 1,
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
    request: { mode: "generate", brief: "Weekly signal" },
    ...overrides,
  };
}

describe("campaign template catalog API", () => {
  it("serializes the visual discovery filters expected by the search API", () => {
    const path = buildCampaignTemplateSearchPath({
      q: " editorial digest ",
      goal: "newsletter",
      category: "media",
      source: "ingested",
      provider: "reallygoodemails",
      style: "minimal",
      layout: "link-roundup",
      industry: "technology",
      kind: "reference",
      tags: ["weekly", "curated"],
      featured: true,
      favorited: true,
      archived: "archived",
      page: 2,
      perPage: 48,
    });
    const url = new URL(path, "https://postwave.test");

    expect(url.pathname).toBe("/api/v1/campaign-templates/search");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "editorial digest",
      goal: "newsletter",
      category: "media",
      source: "ingested",
      provider: "reallygoodemails",
      style: "minimal",
      layout: "link-roundup",
      industry: "technology",
      kind: "reference",
      tags: "weekly,curated",
      featured: "true",
      favorited: "true",
      archived: "archived",
      page: "2",
      per_page: "48",
    });
  });

  it("keeps template and revision identifiers in their own encoded segments", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getCampaignTemplateRevision("team/template", 7);
    await restoreCampaignTemplateRevision("team/template", 7);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8080/api/v1/campaign-templates/team%2Ftemplate/revisions/7",
      "http://localhost:8080/api/v1/campaign-templates/team%2Ftemplate/revisions/7/restore",
    ]);
    expect(() => getCampaignTemplateRevision("team/template", 1.5)).toThrow(
      /positive integer/i,
    );
  });

  it("normalizes legacy arrays and derives design metadata from tags", () => {
    const result = normalizeCampaignTemplateSearchResponse([
      {
        id: "tpl-1",
        name: "Signal",
        subject: "This week in AI",
        tags: ["style:editorial", "layout:link-roundup", "industry:technology"],
      },
    ]);

    expect(result.total).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.items[0]).toMatchObject({
      style: "editorial",
      layout_archetype: "link-roundup",
      industry: "technology",
    });
  });

  it("normalizes the API provenance vocabulary used by ingested designs", () => {
    const result = normalizeCampaignTemplateSearchResponse({
      items: [
        {
          id: "rge-1",
          name: "Editorial Signal",
          subject: "The weekly signal",
          tags: [],
          source_provider: "reallygoodemails",
          source_brand: "Example Publisher",
          layout: "editorial-digest",
        },
      ],
      next_cursor: "2",
      total: 50,
      facets: {},
    });

    expect(result.items[0]).toMatchObject({
      source: "reallygoodemails",
      provider: "reallygoodemails",
      layout_archetype: "editorial-digest",
    });
    expect(result.next_cursor).toBe("2");
    expect(result.total).toBe(50);
  });

  it("strips governed reference source from mixed-version list payloads", () => {
    const leakedReference = {
      id: "reference-leak",
      name: "Governed source",
      subject: "Reference",
      tags: [],
      template_kind: "reference",
      body_html: "<p>internal source</p>",
      body_mjml: "<mjml><mj-body /></mjml>",
      capabilities: {
        has_source_html: true,
        has_source_mjml: true,
      },
    } as CampaignTemplateSummary & {
      body_html: string;
      body_mjml: string;
    };

    const [normalized] = normalizeCampaignTemplateSearchResponse([
      leakedReference,
    ]).items;
    expect(normalized).not.toHaveProperty("body_html");
    expect(normalized).not.toHaveProperty("body_mjml");
  });

  it("preserves catalog paging metadata when the API returns it", () => {
    const result = normalizeCampaignTemplateSearchResponse({
      items: [],
      page: 2,
      per_page: 24,
      next_cursor: "3",
      total: 75,
      facets: {},
    });

    expect(result).toMatchObject({ page: 2, per_page: 24, next_cursor: "3" });
  });

  it("serializes every explicit server sort, including recommended", () => {
    expect(
      new URL(
        buildCampaignTemplateSearchPath({ sort: "most_used" }),
        "https://postwave.test",
      ).searchParams.get("sort"),
    ).toBe("most_used");
    expect(
      new URL(
        buildCampaignTemplateSearchPath({ sort: "recommended" }),
        "https://postwave.test",
      ).searchParams.get("sort"),
    ).toBe("recommended");
  });

  it("keeps explicit featured=false distinct from an omitted predicate", () => {
    const explicitFalse = new URL(
      buildCampaignTemplateSearchPath({ featured: false }),
      "https://postwave.test",
    );
    const omitted = new URL(
      buildCampaignTemplateSearchPath({}),
      "https://postwave.test",
    );

    expect(explicitFalse.searchParams.get("featured")).toBe("false");
    expect(omitted.searchParams.has("featured")).toBe(false);
  });

  it("derives API-valid slugs from template names", () => {
    expect(templateSlugFromName("Weekly AI Digest")).toBe("weekly-ai-digest");
    expect(templateSlugFromName("  Spaced  &  Symbols!! ")).toBe(
      "spaced-symbols",
    );
    expect(templateSlugFromName("123 numbers first")).toBe(
      "template-123-numbers-first",
    );
    expect(templateSlugFromName("!!!")).toBe("template");
  });

  it("gates management actions to workspace-owned templates", () => {
    expect(isOwnedCampaignTemplate({ tenant_id: "t-1", source: "team" })).toBe(
      true,
    );
    expect(isOwnedCampaignTemplate({ source: "mine" })).toBe(true);
    expect(isOwnedCampaignTemplate({ source: "platform" })).toBe(false);
    expect(isOwnedCampaignTemplate({ source: "reallygoodemails" })).toBe(false);
  });

  it("uses server-projected archive and restore rights without guessing them", () => {
    const active = {
      id: "owned-1",
      tenant_id: "tenant-1",
      name: "Owned",
      subject: "Signal",
      tags: [],
      etag: '"campaign-template:owned-1:v2"',
      capabilities: { can_archive: true, can_restore: false },
    } satisfies CampaignTemplateSummary;
    expect(campaignTemplateCapabilities(active)).toMatchObject({
      can_archive: true,
      can_restore: false,
    });
    expect(
      campaignTemplateCapabilities({
        ...active,
        archived_at: "2026-07-29T00:00:00Z",
        capabilities: { can_archive: false, can_restore: true },
      }),
    ).toMatchObject({ can_archive: false, can_restore: true });
    expect(
      campaignTemplateCapabilities({
        ...active,
        capabilities: undefined,
      }),
    ).toMatchObject({ can_archive: false, can_restore: false });
  });

  it("echoes a strong ETag on edit, archive, and restore mutations", async () => {
    const template = {
      id: "owned-1",
      name: "Owned",
      subject: "Signal",
      tags: [],
      version: 3,
      etag: '"campaign-template:owned-1:v3"',
    };
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => Response.json(template));
    vi.stubGlobal("fetch", fetchMock);

    await updateCampaignTemplate(
      template.id,
      { name: "Renamed" },
      template.etag,
    );
    await archiveCampaignTemplate(template.id, template.etag);
    await restoreCampaignTemplate(template.id, template.etag);

    expect(
      fetchMock.mock.calls.map((call) => ({
        url: call[0],
        method: call[1]?.method,
        ifMatch: new Headers(call[1]?.headers).get("If-Match"),
      })),
    ).toEqual([
      {
        url: "http://localhost:8080/api/v1/campaign-templates/owned-1",
        method: "PATCH",
        ifMatch: template.etag,
      },
      {
        url: "http://localhost:8080/api/v1/campaign-templates/owned-1/archive",
        method: "PATCH",
        ifMatch: template.etag,
      },
      {
        url: "http://localhost:8080/api/v1/campaign-templates/owned-1/restore",
        method: "PATCH",
        ifMatch: template.etag,
      },
    ]);
  });

  it("refuses wildcard or stale-shape concurrency tokens before networking", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => archiveCampaignTemplate("owned-1", "*")).toThrow(
      /fresh template version/i,
    );
    expect(() =>
      updateCampaignTemplate("owned-1", { name: "Unsafe" }, 'W/"old"'),
    ).toThrow(/fresh template version/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires and forwards the caller-owned collection idempotency key", async () => {
    const id = "018f4f51-1a2b-7c3d-8e4f-123456789abc";
    const collection = {
      id,
      name: "Editorial",
      description: "",
      template_ids: [],
      item_count: 0,
      created_at: "2026-07-30T00:00:00Z",
      updated_at: "2026-07-30T00:00:00Z",
      version: 1,
      etag: `"campaign-template-collection:${id}:v1"`,
    };
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => Response.json(collection, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await createCampaignTemplateCollection(
      { name: collection.name },
      { idempotencyKey: "web-create-collection-1" },
    );

    const request = fetchMock.mock.calls[0]?.[1] ?? {};
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("Idempotency-Key")).toBe(
      "web-create-collection-1",
    );
    await expect(
      createCampaignTemplateCollection(
        { name: "Unsafe" },
        { idempotencyKey: "bad\nkey" },
      ),
    ).rejects.toThrow(/1–255 UTF-8 bytes/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("echoes only the exact collection resource/version ETag on reorder", async () => {
    const id = "018f4f51-1a2b-7c3d-8e4f-123456789abc";
    const collection = {
      id,
      name: "Editorial",
      description: "",
      template_ids: [],
      item_count: 0,
      created_at: "2026-07-30T00:00:00Z",
      updated_at: "2026-07-30T00:00:00Z",
      version: 4,
      etag: `"campaign-template-collection:${id}:v4"`,
    };
    const updated = {
      ...collection,
      template_ids: ["118f4f51-1a2b-7c3d-8e4f-123456789abc"],
      item_count: 1,
      version: 5,
      etag: `"campaign-template-collection:${id}:v5"`,
    };
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => Response.json(updated));
    vi.stubGlobal("fetch", fetchMock);

    await replaceCampaignTemplateCollectionItems(
      collection,
      updated.template_ids,
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("If-Match"),
    ).toBe(collection.etag);

    await expect(
      replaceCampaignTemplateCollectionItems(
        {
          ...collection,
          etag: `"campaign-template-saved-search:${id}:v4"`,
        },
        [],
      ),
    ).rejects.toThrow(/changed.*reload/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("covers saved-search create/run/delete plus repeated compare parameters", async () => {
    const id = "018f4f51-1a2b-7c3d-8e4f-123456789abc";
    const savedSearch = {
      id,
      name: "Minimal",
      filters: { goal: "newsletter", style: "minimal" },
      created_at: "2026-07-30T00:00:00Z",
      updated_at: "2026-07-30T00:00:00Z",
      version: 1,
      etag: `"campaign-template-saved-search:${id}:v1"`,
    };
    const template = {
      id: "218f4f51-1a2b-7c3d-8e4f-123456789abc",
      name: "Signal",
      subject: "Signal",
      tags: [],
    };
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async (request) => {
      const url = String(request);
      if (url.includes("/compare?")) {
        return Response.json({
          items: [
            {
              requested_identifier: "one",
              matched_by: "slug",
              template,
            },
            {
              requested_identifier: "two",
              matched_by: "slug",
              template: { ...template, id: `${template.id}-2`, name: "Two" },
            },
          ],
          unavailable_identifiers: ["removed"],
        });
      }
      if (url.endsWith("/results?per_page=8")) {
        return Response.json({
          items: [template],
          next_cursor: null,
          total: 1,
          facets: {},
        });
      }
      if (url.endsWith(`/saved-searches/${id}`)) {
        return Response.json({ ok: true, deleted: true });
      }
      return Response.json(savedSearch, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createCampaignTemplateSavedSearch(
      { name: savedSearch.name, filters: savedSearch.filters },
      { idempotencyKey: "web-save-search-1" },
    );
    const results = await runCampaignTemplateSavedSearch(id, { perPage: 8 });
    expect(results.items[0].name).toBe("Signal");
    await deleteCampaignTemplateSavedSearch(savedSearch);
    await expect(compareCampaignTemplates(["one", "two"])).resolves.toEqual({
      items: [
        expect.objectContaining({ requested_identifier: "one" }),
        expect.objectContaining({ requested_identifier: "two" }),
      ],
      unavailable_identifiers: ["removed"],
    });
    await clearRecentCampaignTemplateViews();

    const requests = fetchMock.mock.calls.map((call) => ({
      url: String(call[0]),
      method: call[1]?.method,
      headers: new Headers(call[1]?.headers),
    }));
    expect(requests[0].headers.get("Idempotency-Key")).toBe(
      "web-save-search-1",
    );
    expect(requests[2].headers.get("If-Match")).toBe(savedSearch.etag);
    const compareURL = new URL(requests[3].url);
    expect(compareURL.searchParams.getAll("template")).toEqual(["one", "two"]);
    expect(requests[4]).toMatchObject({
      url: "http://localhost:8080/api/v1/campaign-templates/recent",
      method: "DELETE",
    });
  });

  it("accepts facet arrays and count maps and fails legacy provider images closed", () => {
    expect(facetOptions(["minimal", "editorial", "minimal"])).toEqual([
      "editorial",
      "minimal",
    ]);
    expect(facetOptions({ ecommerce: 12, media: 7 })).toEqual([
      "ecommerce",
      "media",
    ]);
    expect(campaignTemplateThumbnailUrl({ id: "a/b" })).toBeUndefined();
    expect(
      campaignTemplateThumbnailUrl({
        id: "a/b",
        thumbnail_url: "https://cdn.example.test/preview.png",
      }),
    ).toBeUndefined();
    expect(
      campaignTemplateThumbnailUrl({ id: "a/b", thumbnail_url: "   " }),
    ).toBeUndefined();
  });

  it("selects only sanitized previews under the exact configured asset base", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL",
      "https://assets.postwave.test/hosted",
    );
    const template: CampaignTemplateSummary = {
      id: "rge-1",
      name: "Digest",
      subject: "Digest",
      tags: [],
      thumbnail_url:
        "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com/emails/source.png",
      preview_assets: [
        {
          variant: "desktop",
          url: "https://assets.postwave.test/hosted/campaign-template-previews/desktop.png",
          mime_type: "image/png",
          width: 680,
          height: 2400,
          size_bytes: 120_000,
          status: "ready",
        },
        {
          variant: "card",
          url: "https://assets.postwave.test/hosted/campaign-template-previews/card.webp",
          mime_type: "image/webp",
          width: 680,
          height: 2400,
          size_bytes: 80_000,
          status: "source_missing",
        },
      ],
    };

    expect(campaignTemplateThumbnailUrl(template)).toBe(
      "https://assets.postwave.test/hosted/campaign-template-previews/card.webp",
    );
    expect(campaignTemplatePreviewUrl(template)).toBe(
      "https://assets.postwave.test/hosted/campaign-template-previews/desktop.png",
    );
    expect(campaignTemplatePreviewUrl(template, ["mobile"])).toBeUndefined();
    expect(
      campaignTemplateHostedPreviewAssets(template).map((asset) => ({
        variant: asset.variant,
        url: asset.url,
        status: asset.status,
      })),
    ).toEqual([
      {
        variant: "desktop",
        url: "https://assets.postwave.test/hosted/campaign-template-previews/desktop.png",
        status: "ready",
      },
      {
        variant: "card",
        url: "https://assets.postwave.test/hosted/campaign-template-previews/card.webp",
        status: "source_missing",
      },
    ]);
    expect(
      campaignTemplatePreviewUrl({
        ...template,
        preview_assets: [
          {
            ...template.preview_assets![0],
            url: "https://evil.test/hosted/stolen.png",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      campaignTemplatePreviewUrl({
        ...template,
        preview_assets: [
          {
            ...template.preview_assets![0],
            url: "https://assets.postwave.test/outside/preview.png",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("keeps pending references bookmarkable while adaptation fails closed", () => {
    const pending = {
      id: "rge-1",
      name: "Reference",
      subject: "Reference",
      tags: [],
      template_kind: "reference",
      review_status: "pending",
      source_license_status: "personal-use-unreviewed",
      thumbnail_url: "https://cdn.example.test/reference.png",
      capabilities: {
        can_preview: true,
        has_mobile_preview: true,
      },
      design_metadata: {
        stored_html_bytes: 1_024,
        has_mobile_preview: true,
      },
    } satisfies CampaignTemplateSummary;

    expect(campaignTemplateCapabilities(pending)).toMatchObject({
      can_preview: true,
      can_adapt: false,
      can_favorite: false,
      has_mobile_preview: true,
    });
    expect(campaignTemplateCapabilityLabel(pending)).toBe("Visual inspiration");
    expect(campaignTemplateActionReason(pending)).toMatch(/awaiting review/i);

    expect(
      campaignTemplateCapabilities({
        ...pending,
        capabilities: { can_adapt: true, can_favorite: true },
      }),
    ).toMatchObject({ can_adapt: true, can_favorite: true });
  });

  it("does not advertise provider screenshots as renderable previews", () => {
    const providerOnly = {
      id: "rge-provider-only",
      name: "Provider-only reference",
      subject: "Reference",
      tags: [],
      template_kind: "reference",
      thumbnail_url: "https://provider.example.test/desktop.png",
      source_metadata: {
        desktop_screenshot: "https://provider.example.test/desktop.png",
        mobile_screenshot: "https://provider.example.test/mobile.png",
      },
    } satisfies CampaignTemplateSummary;

    expect(campaignTemplateCapabilities(providerOnly)).toMatchObject({
      can_preview: false,
      has_desktop_preview: false,
      has_mobile_preview: false,
    });
  });

  it("treats every redacted reference as visual inspiration", () => {
    expect(
      isVisualOnlyCampaignTemplate({
        id: "reference-with-governed-source",
        name: "Governed reference",
        subject: "Reference",
        tags: [],
        template_kind: "reference",
        capabilities: {
          has_source_html: true,
          has_source_mjml: true,
          can_adapt: true,
        },
      }),
    ).toBe(true);
    expect(
      isVisualOnlyCampaignTemplate({
        id: "editable",
        name: "Editable",
        subject: "Editable",
        tags: [],
        template_kind: "editable",
      }),
    ).toBe(false);
  });

  it("exports source only with explicit capability on an owned editable row", () => {
    const trusted: CampaignTemplate = {
      id: "owned-editable",
      tenant_id: "tenant-1",
      name: "Owned",
      subject: "Owned",
      tags: [],
      template_kind: "editable",
      body_html: "<p>Owned HTML</p>",
      body_mjml: "<mjml />",
      capabilities: {
        has_source_html: true,
        has_source_mjml: true,
      },
    };

    expect(campaignTemplateExportableSource(trusted)).toEqual({
      html: true,
      mjml: true,
    });
    expect(
      campaignTemplateExportableSource({
        ...trusted,
        tenant_id: undefined,
        source: "platform",
      }),
    ).toEqual({ html: false, mjml: false });
    expect(
      campaignTemplateExportableSource({
        ...trusted,
        template_kind: "reference",
      }),
    ).toEqual({ html: false, mjml: false });
    expect(
      campaignTemplateExportableSource({
        ...trusted,
        capabilities: undefined,
      }),
    ).toEqual({ html: false, mjml: false });
  });

  it("starts generation through the durable design endpoint with a stable caller key", async () => {
    const queued = designDraft();
    const fetchMock = vi.fn(async () =>
      Response.json(queued, {
        status: 202,
        headers: { "Retry-After": "2" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createCampaignTemplateDesign(
        {
          mode: "generate",
          brief: "Weekly signal",
          reference_template_ids: ["018f4f51-1a2b-7c3d-8e4f-111111111111"],
        },
        { idempotencyKey: "same-key-on-retry" },
      ),
    ).resolves.toMatchObject({ status: "queued" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/campaign-template-designs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "same-key-on-retry",
        }),
        body: expect.not.stringContaining("body_html"),
      }),
    );
  });

  it("lists a bounded actor-scoped recovery page without client identity input", async () => {
    const summary = {
      id: "018f4f51-1a2b-7c3d-8e4f-123456789abc",
      mode: "generate",
      status: "ready",
      current_revision: 1,
      attempt_count: 1,
      capabilities: {
        can_refine: true,
        can_retry: false,
        can_save: true,
        can_create_campaign: true,
        can_archive: true,
      },
      recommended_action: "review_campaign_template_design",
      expires_at: "2099-01-01T00:00:00Z",
      created_at: "2026-07-30T00:00:00Z",
      updated_at: "2026-07-30T00:01:00Z",
    };
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({ items: [summary], next_cursor: "opaque-next" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listCampaignTemplateDesigns({ limit: 500, cursor: "opaque" }),
    ).resolves.toEqual({
      items: [summary],
      next_cursor: "opaque-next",
    });
    const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(request.pathname).toBe("/api/v1/campaign-template-designs");
    expect(request.searchParams.get("limit")).toBe("50");
    expect(request.searchParams.get("cursor")).toBe("opaque");
    expect(request.searchParams.has("tenant_id")).toBe(false);
    expect(request.searchParams.has("actor_id")).toBe(false);
  });

  it("polls with Retry-After/exponential backoff until an immutable revision is ready", async () => {
    vi.useFakeTimers();
    const ready = designDraft({
      status: "ready",
      current_revision: 1,
      retry_after_seconds: 0,
      capabilities: {
        can_refine: true,
        can_retry: false,
        can_save: true,
        can_create_campaign: true,
        can_archive: true,
      },
      revision: {
        id: "revision-1",
        draft_id: "018f4f51-1a2b-7c3d-8e4f-123456789abc",
        revision: 1,
        operation: "initial",
        output: {
          name: "Signal",
          subject: "Weekly signal",
          body_html: "<p>Reviewed</p>",
          unresolved_variables: [],
          reference_template_ids: [],
          warnings: [],
        },
        output_hash: "a".repeat(64),
        validation: { status: "pass", checks: [] },
        warnings: [],
        created_at: "2026-07-29T00:00:01Z",
      },
    });
    const responses = [
      new Response(JSON.stringify(designDraft()), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "2",
        },
      }),
      Response.json(
        designDraft({ status: "generating", retry_after_seconds: 1 }),
      ),
      Response.json(ready),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const updates: string[] = [];

    const result = waitForCampaignTemplateDesign(ready.id, {
      initialPollMs: 250,
      maxPollMs: 4_000,
      onUpdate: (draft) => updates.push(draft.status),
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      status: "ready",
      revision: { revision: 1, output_hash: "a".repeat(64) },
    });
    expect(updates).toEqual(["queued", "generating", "ready"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails terminally when a queued design has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(designDraft({ expires_at: "2020-01-01T00:00:00Z" })),
      ),
    );

    await expect(
      waitForCampaignTemplateDesign("expired", { timeoutMs: 1_000 }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CampaignTemplateDesignWaitError>>({
        code: "design_expired",
      }),
    );
  });

  it("cancels polling without issuing another request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () =>
      Response.json(designDraft({ retry_after_seconds: 30 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = waitForCampaignTemplateDesign("design-1", {
      signal: controller.signal,
      onUpdate: () => controller.abort(),
    });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("commits only the exact reviewed revision/hash for save and campaign creation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { id: "saved-1", name: "Saved", subject: "Signal", tags: [] },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { id: "campaign-1", name: "Signal campaign", subject: "Signal" },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const commit = { revision: 3, output_hash: "b".repeat(64) };

    await saveCampaignTemplateDesign(
      "design-1",
      { ...commit, slug: "saved", name: "Saved" },
      { idempotencyKey: "save-key" },
    );
    await refineCampaignTemplateDesign(
      "design-1",
      { instructions: "Shorter hero", base_revision: 3 },
      { idempotencyKey: "refine-key" },
    ).catch(() => undefined);
    // The mocked second response is consumed by refine; use a fresh response
    // for the campaign commit below.
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { id: "campaign-1", name: "Signal campaign", subject: "Signal" },
        { status: 201 },
      ),
    );
    await createCampaignFromTemplateDesign(
      "design-1",
      { ...commit, name: "Signal campaign" },
      { idempotencyKey: "campaign-key" },
    );

    const saveBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const refineBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    const campaignBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:8080/api/v1/campaign-template-designs/design-1/save",
      "http://localhost:8080/api/v1/campaign-template-designs/design-1/refine",
      "http://localhost:8080/api/v1/campaign-template-designs/design-1/create-campaign",
    ]);
    expect(saveBody).toEqual({ ...commit, slug: "saved", name: "Saved" });
    expect(refineBody).toEqual({
      instructions: "Shorter hero",
      base_revision: 3,
    });
    expect(campaignBody).toEqual({ ...commit, name: "Signal campaign" });
    expect(JSON.stringify([saveBody, campaignBody])).not.toContain("body_html");
  });

  it("requires and forwards the caller's stable archive retry key", async () => {
    const fetchMock = vi.fn<
      (request: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => Response.json(designDraft({ status: "archived" })));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await archiveCampaignTemplateDesign("design-1", {
      idempotencyKey: "stable-archive-attempt-key",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:8080/api/v1/campaign-template-designs/design-1/archive",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.signal?.aborted).toBe(false);
    expect(new Headers(request.headers).get("Idempotency-Key")).toBe(
      "stable-archive-attempt-key",
    );
  });
});

// WEBASSET-01: the gallery renders these captures into ~250px 4/5 cards while
// the server accepts blobs up to 16384px / 10 MiB, and the URL validator made
// a CDN-resized rendition impossible by rejecting any non-empty query string.
describe("campaign template card thumbnails", () => {
  const asset = (
    variant: "desktop" | "card" | "mobile",
    width: number,
    url: string,
  ) => ({
    variant,
    url,
    mime_type: "image/webp" as const,
    width,
    height: Math.round(width * 2.4),
    size_bytes: width * 400,
    status: "ready" as const,
  });

  const base = "https://assets.postwave.test/hosted";

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL", base);
  });

  it("prefers the smallest capture, never falling back to desktop over mobile", () => {
    const template = {
      id: "rge-2",
      preview_assets: [
        asset("desktop", 1280, `${base}/p/desktop.webp`),
        asset("mobile", 390, `${base}/p/mobile.webp`),
      ],
    };

    expect(campaignTemplateThumbnailUrl(template)).toBe(
      `${base}/p/mobile.webp`,
    );
    // The detail surface still wants the widest capture.
    expect(campaignTemplatePreviewUrl(template)).toBe(`${base}/p/desktop.webp`);
  });

  it("exposes intrinsic dimensions and a width-descriptor srcSet", () => {
    const source = campaignTemplateThumbnailSource({
      id: "rge-3",
      preview_assets: [
        asset("desktop", 1280, `${base}/p/desktop.webp`),
        asset("card", 640, `${base}/p/card.webp`),
        asset("mobile", 390, `${base}/p/mobile.webp`),
      ],
    });

    expect(source?.src).toBe(`${base}/p/card.webp`);
    expect(source?.width).toBe(640);
    expect(source?.height).toBe(1536);
    expect(source?.srcSet).toBe(
      `${base}/p/mobile.webp 390w, ${base}/p/card.webp 640w, ${base}/p/desktop.webp 1280w`,
    );
  });

  it("omits srcSet when only one variant is hosted", () => {
    const source = campaignTemplateThumbnailSource({
      id: "rge-4",
      preview_assets: [asset("card", 640, `${base}/p/card.webp`)],
    });

    expect(source?.src).toBe(`${base}/p/card.webp`);
    expect(source?.srcSet).toBeUndefined();
    expect(campaignTemplateThumbnailSource({ id: "rge-5" })).toBeUndefined();
  });

  it("admits CDN resize directives but nothing else in the query", () => {
    const resized = {
      id: "rge-6",
      preview_assets: [
        {
          ...asset("card", 640, `${base}/p/card.webp?w=320&fm=webp&q=70`),
        },
      ],
    };
    expect(campaignTemplateThumbnailUrl(resized)).toBe(
      `${base}/p/card.webp?w=320&fm=webp&q=70`,
    );

    for (const query of [
      "?redirect=https://evil.test",
      "?w=320&redirect=1",
      "?w=" + "9".repeat(32),
      "?w=../../etc/passwd",
    ]) {
      expect(
        campaignTemplateThumbnailUrl({
          id: "rge-7",
          preview_assets: [asset("card", 640, `${base}/p/card.webp${query}`)],
        }),
      ).toBeUndefined();
    }
  });
});
