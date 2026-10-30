import { describe, expect, it } from "vitest";

import {
  decodeCampaignTemplate,
  decodeCampaignTemplateRevision,
  decodeCampaignTemplateRevisionPage,
  decodeSavedBlock,
  decodeSavedBlockDeleteReceipt,
  decodeSavedBlocks,
  decodeTemplateGoalCounts,
  decodeTemplateSearchResponse,
  decodeTemplateStats,
  decodeTemplateRegions,
} from "../../components/templates/template-runtime";

const template = {
  id: "template-1",
  slug: "welcome-one",
  name: "Welcome one",
  subject: "Hello",
  template_kind: "editable",
  review_status: "approved",
  goal: "welcome",
  tags: [],
  variables: [],
};

describe("Templates runtime response boundaries", () => {
  it("accepts a complete compact catalog response", () => {
    expect(
      decodeTemplateSearchResponse({
        items: [template],
        page: 1,
        per_page: 24,
        total: 1,
        facets: {
          goals: [{ value: "welcome", count: 1 }],
          categories: [],
          providers: [],
          industries: [],
          styles: [],
          layouts: [],
        },
      }),
    ).toMatchObject({ items: [template], page: 1, per_page: 24, total: 1 });
  });

  it("rejects malformed records and fail-open governance enums", () => {
    expect(decodeCampaignTemplate({ ...template, name: null })).toBeNull();
    expect(
      decodeCampaignTemplate({ ...template, review_status: "self-approved" }),
    ).toBeNull();
    expect(
      decodeCampaignTemplate({ ...template, template_kind: "trusted" }),
    ).toBeNull();
    expect(
      decodeCampaignTemplate({ ...template, quality_score: 1.4 }),
    ).toBeNull();
    expect(decodeCampaignTemplate({ ...template, usage_count: -1 })).toBeNull();
    expect(
      decodeTemplateSearchResponse({
        items: [{ ...template, id: 42 }],
        page: 1,
        per_page: 24,
        total: 1,
      }),
    ).toBeNull();
  });

  it("requires bounded finite catalog metadata", () => {
    expect(
      decodeTemplateSearchResponse({
        items: [template],
        page: 0,
        per_page: 24,
        total: 1,
      }),
    ).toBeNull();
    expect(
      decodeTemplateSearchResponse({
        items: [template],
        page: 1.5,
        per_page: 24,
        total: 1,
        facets: {
          goals: [],
          categories: [],
          providers: [],
          industries: [],
          styles: [],
          layouts: [],
        },
      }),
    ).toBeNull();
    expect(
      decodeTemplateSearchResponse({
        items: [template],
        page: 1,
        per_page: 24,
        total: 1,
        facets: {
          goals: [{ value: "welcome", count: Number.NaN }],
          categories: [],
          providers: [],
          industries: [],
          styles: [],
          layouts: [],
        },
      }),
    ).toBeNull();
    expect(
      decodeTemplateSearchResponse({
        items: [template],
        page: 1,
        per_page: 24,
        total: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it("validates supporting stats and goal-count contracts", () => {
    expect(
      decodeTemplateStats({
        total: 2,
        mine: 1,
        featured: 1,
        favorites: 0,
        used_last_30d: 7,
      }),
    ).not.toBeNull();
    expect(
      decodeTemplateStats({
        total: -1,
        mine: 1,
        featured: 1,
        favorites: 0,
        used_last_30d: 7,
      }),
    ).toBeNull();
    expect(decodeTemplateGoalCounts([{ goal: "welcome", count: 1 }])).toEqual([
      { goal: "welcome", count: 1 },
    ]);
    expect(
      decodeTemplateGoalCounts([{ goal: "invented", count: 1 }]),
    ).toBeNull();
    expect(
      decodeTemplateGoalCounts([{ goal: "welcome", count: 1.25 }]),
    ).toBeNull();
  });

  it("rejects malformed saved blocks instead of presenting an empty library", () => {
    const block = {
      id: "11111111-1111-4111-8111-111111111111",
      tenant_id: "22222222-2222-4222-8222-222222222222",
      name: "Footer",
      kind: "section",
      body_html: "<p>Footer</p>",
      body_json: {},
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
      version: 1,
    };
    expect(decodeSavedBlock(block)).toMatchObject(block);
    expect(decodeSavedBlocks({ items: [block], total: 1 })).toHaveLength(1);
    expect(
      decodeSavedBlocks({ items: [{ id: "block-1", kind: "unknown" }] }),
    ).toBeNull();
    expect(decodeSavedBlock({ ...block, updated_at: "not-a-date" })).toBeNull();
  });

  it("binds a saved-block delete receipt to the exact id and next version", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      decodeSavedBlockDeleteReceipt({ ok: true, id, version: 5 }, id, 4),
    ).toBe(true);
    expect(
      decodeSavedBlockDeleteReceipt({ ok: true, id, version: 4 }, id, 4),
    ).toBe(false);
    expect(
      decodeSavedBlockDeleteReceipt(
        {
          ok: true,
          id: "33333333-3333-4333-8333-333333333333",
          version: 5,
        },
        id,
        4,
      ),
    ).toBe(false);
  });

  it("rejects malformed parsed-region success payloads", () => {
    expect(
      decodeTemplateRegions({
        regions: [
          {
            name: "hero",
            default_html: "<h1>Hello</h1>",
            position: 12,
            length: 14,
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      decodeTemplateRegions({
        regions: [{ name: "hero", default_html: "", position: -1, length: 2 }],
      }),
    ).toBeNull();
  });

  it("validates hosted preview assets and strong lifecycle versions", () => {
    const governed = {
      ...template,
      version: 3,
      etag: '"campaign-template:template-1:v3"',
      archived_at: "2026-07-29T12:00:00.000Z",
      preview_assets: [
        {
          variant: "desktop",
          url: "https://assets.postwave.test/hosted/desktop.png",
          mime_type: "image/png",
          width: 1200,
          height: 2400,
          size_bytes: 80_000,
          status: "ready",
        },
      ],
    };
    expect(decodeCampaignTemplate(governed)).toMatchObject(governed);
    expect(
      decodeCampaignTemplate({ ...governed, etag: 'W/"weak"' }),
    ).toBeNull();
    expect(
      decodeCampaignTemplate({
        ...governed,
        etag: undefined,
        capabilities: {
          can_preview: true,
          can_favorite: true,
          can_adapt: false,
          can_use_directly: true,
          can_create_campaign: true,
          can_edit_directly: true,
          can_clone: true,
          can_delete: true,
          can_archive: true,
          can_restore: false,
          has_source_html: true,
          has_source_mjml: false,
          has_desktop_preview: true,
          has_mobile_preview: false,
        },
      }),
    ).toBeNull();
    expect(
      decodeCampaignTemplate({
        ...governed,
        preview_assets: [{ ...governed.preview_assets[0], width: 0 }],
      }),
    ).toBeNull();
  });

  it("validates immutable revision summaries and snapshots", () => {
    const summary = {
      version: 3,
      etag: '"campaign-template:template-1:v3"',
      transition: "archived",
      name: "Welcome one",
      subject: "Hello",
      archived_at: "2026-07-29T12:00:00.000Z",
      snapshot_time: "2026-07-29T12:00:00.000Z",
    };
    expect(
      decodeCampaignTemplateRevisionPage({
        items: [summary],
        page: 1,
        per_page: 20,
        total: 1,
      }),
    ).toMatchObject({ items: [summary], total: 1 });
    expect(
      decodeCampaignTemplateRevision({
        ...summary,
        snapshot: {
          ...template,
          version: 3,
          etag: '"campaign-template:template-1:v3"',
        },
      }),
    ).toMatchObject({ version: 3, snapshot: template });
    expect(
      decodeCampaignTemplateRevisionPage({
        items: [{ ...summary, snapshot_time: "not-a-date" }],
        page: 1,
        per_page: 20,
        total: 1,
      }),
    ).toBeNull();
  });
});
