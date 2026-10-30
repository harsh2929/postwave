// SPDX-License-Identifier: MIT
import { PostwaveClient } from "@postwave/sdk";
import { describe, expect, it, vi } from "vitest";

import { campaignTemplateTools } from "../../src/tools/campaign-templates.js";

function makeClient() {
  const campaignTemplates = {
    search: vi.fn().mockResolvedValue({
      items: [
        {
          id: "tpl_1",
          slug: "editorial-weekly",
          name: "Editorial weekly",
          subject: "This week",
          body_html: "<p>large source</p>",
          body_mjml: "<mjml>large source</mjml>",
          variables: [{ key: "title" }],
          source_provider: "reallygoodemails",
          source_url: "https://example.com/email/1",
          quality_score: 0.94,
          source_metadata: { raw_capture: "large metadata" },
          design_metadata: { extracted_dom: "large metadata" },
          capabilities: {
            can_preview: true,
            can_favorite: true,
            can_adapt: true,
            can_edit_directly: false,
            can_create_campaign: false,
            has_source_html: false,
            has_source_mjml: false,
            has_desktop_preview: true,
            has_mobile_preview: false,
            preview_kind: "screenshot",
          },
          recommended_action: "campaign_template_adapt",
          warnings: [
            {
              code: "visual_reference_only",
              message: "The source layout is visual inspiration.",
            },
          ],
          tags: ["editorial"],
        },
      ],
      total: 3_194,
      page: 1,
      per_page: 25,
      next_cursor: "2",
    }),
    compare: vi.fn().mockResolvedValue({
      items: [
        {
          requested_identifier: "tpl_1",
          matched_by: "id",
          template: { id: "tpl_1" },
        },
      ],
      unavailable_identifiers: ["weekly"],
    }),
    favorite: vi.fn().mockResolvedValue({ ok: true, favorited: true }),
    unfavorite: vi.fn().mockResolvedValue({ ok: true, favorited: false }),
    recordView: vi.fn().mockResolvedValue({
      template: { id: "tpl_1" },
      view_count: 1,
    }),
    recent: vi.fn().mockResolvedValue({ items: [] }),
    clearRecent: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
    listCollections: vi.fn().mockResolvedValue({ items: [] }),
    getCollection: vi.fn().mockResolvedValue({ id: "collection_1" }),
    createCollection: vi.fn().mockResolvedValue({ id: "collection_1" }),
    updateCollection: vi.fn().mockResolvedValue({ id: "collection_1" }),
    replaceCollectionItems: vi.fn().mockResolvedValue({ id: "collection_1" }),
    deleteCollection: vi.fn().mockResolvedValue({ ok: true, deleted: true }),
    listSavedSearches: vi.fn().mockResolvedValue({
      items: [
        {
          id: "search_1",
          obsolete_filters: [{ field: "tags", value: "retired-topic" }],
        },
      ],
    }),
    getSavedSearch: vi.fn().mockResolvedValue({
      id: "search_1",
      obsolete_filters: [{ field: "tags", value: "retired-topic" }],
    }),
    createSavedSearch: vi.fn().mockResolvedValue({ id: "search_1" }),
    updateSavedSearch: vi.fn().mockResolvedValue({ id: "search_1" }),
    savedSearchResults: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    deleteSavedSearch: vi.fn().mockResolvedValue({ ok: true, deleted: true }),
    get: vi.fn().mockResolvedValue({ id: "tpl_1", body_mjml: "<mjml />" }),
    listRevisions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getRevision: vi.fn().mockResolvedValue({
      version: 2,
      transition: "update",
      snapshot: { id: "tpl_1" },
    }),
    create: vi.fn().mockResolvedValue({ id: "tpl_new" }),
    update: vi.fn().mockResolvedValue({ id: "tpl_1", subject: "Updated" }),
    clone: vi.fn().mockResolvedValue({ id: "tpl_copy" }),
    archive: vi.fn().mockResolvedValue({
      id: "tpl_1",
      archived_at: "2026-07-29T00:00:00Z",
    }),
    restore: vi.fn().mockResolvedValue({ id: "tpl_1", archived_at: undefined }),
    delete: vi.fn().mockResolvedValue({
      id: "tpl_1",
      archived_at: "2026-07-29T00:00:00Z",
    }),
    adapt: vi.fn().mockResolvedValue({ body_mjml: "<mjml />" }),
    generate: vi.fn().mockResolvedValue({ body_mjml: "<mjml />" }),
    listDesigns: vi.fn().mockResolvedValue({
      items: [
        {
          id: "design_1",
          mode: "generate",
          status: "ready",
          current_revision: 2,
          attempt_count: 1,
          capabilities: {
            can_refine: true,
            can_retry: false,
            can_save: true,
            can_create_campaign: true,
            can_archive: true,
          },
          recommended_action: "review_campaign_template_design",
          expires_at: "2026-08-06T00:00:00Z",
          created_at: "2026-07-30T00:00:00Z",
          updated_at: "2026-07-30T00:01:00Z",
        },
      ],
      next_cursor: "actor-bound-next",
    }),
    getDesign: vi.fn().mockResolvedValue({ id: "design_1", status: "ready" }),
    listDesignRevisions: vi.fn().mockResolvedValue({ items: [] }),
    refineDesign: vi
      .fn()
      .mockResolvedValue({ id: "design_1", status: "queued" }),
    retryDesign: vi
      .fn()
      .mockResolvedValue({ id: "design_1", status: "queued" }),
    saveDesign: vi.fn().mockResolvedValue({ id: "tpl_saved" }),
    createCampaignFromDesign: vi
      .fn()
      .mockResolvedValue({ id: "cmp_design_1", status: "draft" }),
    archiveDesign: vi
      .fn()
      .mockResolvedValue({ id: "design_1", status: "archived" }),
    createCampaign: vi.fn().mockResolvedValue({ id: "cmp_1", status: "draft" }),
  };
  return { client: { campaignTemplates }, campaignTemplates };
}

function tool(name: string) {
  const made = makeClient();
  const definition = campaignTemplateTools(made.client as any).find(
    (entry) => entry.name === name,
  )!;
  return { ...made, definition };
}

describe("campaignTemplateTools", () => {
  it("exposes the explicit review-then-save visual-template operations", () => {
    const { client } = makeClient();
    const names = campaignTemplateTools(client as any).map(
      (entry) => entry.name,
    );

    expect(names).toEqual([
      "campaign_template_search",
      "campaign_template_compare",
      "campaign_template_favorite",
      "campaign_template_unfavorite",
      "campaign_template_recent_record",
      "campaign_template_recent_list",
      "campaign_template_recent_clear",
      "campaign_template_collection_list",
      "campaign_template_collection_get",
      "campaign_template_collection_create",
      "campaign_template_collection_update",
      "campaign_template_collection_replace_items",
      "campaign_template_collection_delete",
      "campaign_template_saved_search_list",
      "campaign_template_saved_search_get",
      "campaign_template_saved_search_create",
      "campaign_template_saved_search_update",
      "campaign_template_saved_search_results",
      "campaign_template_saved_search_delete",
      "campaign_template_get",
      "campaign_template_revisions",
      "campaign_template_revision_get",
      "campaign_template_create",
      "campaign_template_update",
      "campaign_template_change_preview",
      "campaign_template_change_apply",
      "campaign_template_clone",
      "campaign_template_archive",
      "campaign_template_restore",
      "campaign_template_delete",
      "campaign_template_adapt",
      "campaign_template_generate",
      "campaign_template_design_list",
      "campaign_template_design_get",
      "campaign_template_design_revisions",
      "campaign_template_design_refine",
      "campaign_template_design_retry",
      "campaign_template_save",
      "campaign_template_design_create_campaign",
      "campaign_template_design_archive",
      "campaign_create_from_template",
    ]);
  });

  it("returns compact search rows with a URI instead of full source", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_search");

    const result = (await definition.handler({
      q: "editorial",
      goal: "newsletter",
      tags: ["weekly"],
      page: 1,
      per_page: 25,
    })) as {
      items: Array<Record<string, unknown>>;
      has_more: boolean;
      next_page: number;
      next_cursor: string;
    };

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      q: "editorial",
      goal: "newsletter",
      tags: ["weekly"],
      page: 1,
      per_page: 25,
    });
    expect(result.items[0]).toMatchObject({
      id: "tpl_1",
      name: "Editorial weekly",
      resource_uri: "moosewave://campaign-templates/tpl_1",
      source_provider: "reallygoodemails",
      quality_score: 0.94,
      recommended_action: "campaign_template_adapt",
      capabilities: expect.objectContaining({
        can_adapt: true,
        preview_kind: "screenshot",
      }),
    });
    expect(result.items[0]).not.toHaveProperty("body_html");
    expect(result.items[0]).not.toHaveProperty("body_mjml");
    expect(result.items[0]).not.toHaveProperty("variables");
    expect(result.items[0]).not.toHaveProperty("source_metadata");
    expect(result.items[0]).not.toHaveProperty("design_metadata");
    expect(result.has_more).toBe(true);
    expect(result.next_page).toBe(2);
    expect(result.next_cursor).toBe("2");
  });

  it("previews and applies only the reviewed exact source change", async () => {
    const { client, campaignTemplates } = makeClient();
    const source = "<mjml><mj-body><mj-text>Before</mj-text></mj-body></mjml>";
    const etag = '"campaign-template:tpl_1:v3"';
    campaignTemplates.get.mockResolvedValue({
      id: "tpl_1",
      etag,
      template_kind: "editable",
      capabilities: { can_edit_directly: true },
      body_mjml: source,
    });
    const definitions = campaignTemplateTools(client as any);
    const preview = definitions.find((entry) => entry.name === "campaign_template_change_preview")!;
    const apply = definitions.find((entry) => entry.name === "campaign_template_change_apply")!;
    const input = {
      template_id: "tpl_1",
      if_match: etag,
      format: "mjml",
      find: "Before",
      replace: "After",
    };
    const review = (await preview.handler(input)) as { preview_hash: string };
    expect(review.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(campaignTemplates.update).not.toHaveBeenCalled();
    await expect(apply.handler({ ...input, preview_hash: "0".repeat(64) })).rejects.toThrow(
      /Preview hash mismatch/,
    );
    expect(campaignTemplates.update).not.toHaveBeenCalled();
    await apply.handler({ ...input, preview_hash: review.preview_hash });
    expect(campaignTemplates.update).toHaveBeenCalledWith(
      "tpl_1",
      { body_mjml: source.replace("Before", "After") },
      etag,
    );

    campaignTemplates.get.mockResolvedValueOnce({
      id: "tpl_1",
      etag: '"campaign-template:tpl_1:v4"',
      body_mjml: source,
    });
    await expect(apply.handler({ ...input, preview_hash: review.preview_hash })).rejects.toThrow(
      /Template changed/,
    );
    expect(campaignTemplates.update).toHaveBeenCalledTimes(1);
  });

  it("rejects ambiguous exact edits and reference templates", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_change_preview");
    const input = {
      template_id: "tpl_1",
      if_match: '"campaign-template:tpl_1:v3"',
      format: "html",
      find: "Old",
      replace: "New",
    };
    campaignTemplates.get.mockResolvedValueOnce({
      id: "tpl_1",
      etag: input.if_match,
      body_html: "<p>Old</p><p>Old</p>",
    });
    await expect(definition.handler(input)).rejects.toThrow(/more than once/);
    campaignTemplates.get.mockResolvedValueOnce({
      id: "tpl_1",
      etag: input.if_match,
      body_html: "<p>aaaa</p>",
    });
    await expect(definition.handler({ ...input, find: "aaa" })).rejects.toThrow(/more than once/);
    campaignTemplates.get.mockResolvedValueOnce({
      id: "tpl_1",
      etag: input.if_match,
      body_html: "<p>Old</p>",
      template_kind: "reference",
    });
    await expect(definition.handler(input)).rejects.toThrow(/not directly editable/);
  });

  it("forwards the Aura provider filter through MCP without exposing source bodies", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_search");
    campaignTemplates.search.mockResolvedValueOnce({
      items: [
        {
          id: "aura_1",
          name: "Aura visual reference",
          source_provider: "aura_build",
          body_html: "",
          body_mjml: "",
          capabilities: { can_adapt: true, can_edit_directly: false },
          recommended_action: "campaign_template_adapt",
        },
      ],
      total: 7_863,
      page: 1,
      per_page: 24,
    });

    const result = (await definition.handler({
      provider: "aura_build",
      kind: "reference",
      goal: "newsletter",
    })) as { items: Array<Record<string, unknown>> };

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      provider: "aura_build",
      kind: "reference",
      goal: "newsletter",
    });
    expect(result.items[0]).toMatchObject({
      id: "aura_1",
      source_provider: "aura_build",
      recommended_action: "campaign_template_adapt",
    });
    expect(result.items[0]).not.toHaveProperty("body_html");
    expect(result.items[0]).not.toHaveProperty("body_mjml");
  });

  it("continues with next_cursor and gives an explicit next page", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_search");
    campaignTemplates.search.mockResolvedValueOnce({
      items: [{ id: "tpl_1601", name: "Page seventeen" }],
      total: 3_194,
      page: 17,
      per_page: 100,
      next_cursor: "18",
    });

    const result = (await definition.handler({
      goal: "newsletter",
      cursor: "eyJ2IjoxLCJwIjoxN30",
      per_page: 100,
    })) as Record<string, unknown>;

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      goal: "newsletter",
      cursor: "eyJ2IjoxLCJwIjoxN30",
      per_page: 100,
    });
    expect(result).toMatchObject({
      page: 17,
      per_page: 100,
      total: 3_194,
      has_more: true,
      next_page: 18,
      next_cursor: "18",
    });
  });

  it("uses an explicit page instead of cursor when both are supplied", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_search");

    await definition.handler({
      page: 9,
      cursor: "eyJ2IjoxLCJwIjoxN30",
      per_page: 100,
    });

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      page: 9,
      per_page: 100,
    });
  });

  it("forwards get, history, concurrency-safe mutations, clone, and deprecated safe archive", async () => {
    const get = tool("campaign_template_get");
    await get.definition.handler({ template_id: "tpl_1" });
    expect(get.campaignTemplates.get).toHaveBeenCalledWith("tpl_1");

    const revisions = tool("campaign_template_revisions");
    await revisions.definition.handler({
      template_id: "tpl_1",
      page: 2,
      per_page: 50,
    });
    expect(revisions.campaignTemplates.listRevisions).toHaveBeenCalledWith(
      "tpl_1",
      { page: 2, per_page: 50 },
    );

    const revision = tool("campaign_template_revision_get");
    await revision.definition.handler({ template_id: "tpl_1", version: 2 });
    expect(revision.campaignTemplates.getRevision).toHaveBeenCalledWith(
      "tpl_1",
      2,
    );

    const create = tool("campaign_template_create");
    await create.definition.handler({
      slug: "weekly-brief",
      name: "Weekly brief",
      subject: "This week",
      body_mjml: "<mjml />",
    });
    expect(create.campaignTemplates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "weekly-brief",
        body_mjml: "<mjml />",
      }),
    );

    const update = tool("campaign_template_update");
    await update.definition.handler({
      template_id: "tpl_1",
      if_match: '"campaign-template:tpl_1:v1"',
      patch: { subject: "Updated" },
    });
    expect(update.campaignTemplates.update).toHaveBeenCalledWith(
      "tpl_1",
      { subject: "Updated" },
      '"campaign-template:tpl_1:v1"',
    );

    const clone = tool("campaign_template_clone");
    await clone.definition.handler({
      template_id: "tpl_1",
      name: "Copy",
      slug: "copy",
    });
    expect(clone.campaignTemplates.clone).toHaveBeenCalledWith("tpl_1", {
      name: "Copy",
      slug: "copy",
    });

    const archive = tool("campaign_template_archive");
    await archive.definition.handler({
      template_id: "tpl_1",
      if_match: '"campaign-template:tpl_1:v2"',
    });
    expect(archive.campaignTemplates.archive).toHaveBeenCalledWith(
      "tpl_1",
      '"campaign-template:tpl_1:v2"',
    );

    const restore = tool("campaign_template_restore");
    await restore.definition.handler({
      template_id: "tpl_1",
      if_match: '"campaign-template:tpl_1:v3"',
    });
    expect(restore.campaignTemplates.restore).toHaveBeenCalledWith(
      "tpl_1",
      '"campaign-template:tpl_1:v3"',
    );

    const del = tool("campaign_template_delete");
    await expect(
      del.definition.handler({
        template_id: "tpl_1",
        if_match: '"campaign-template:tpl_1:v4"',
      }),
    ).resolves.toMatchObject({
      id: "tpl_1",
      archived_at: "2026-07-29T00:00:00Z",
    });
    expect(del.campaignTemplates.delete).toHaveBeenCalledWith(
      "tpl_1",
      '"campaign-template:tpl_1:v4"',
    );
  });

  it("forwards compare, favorites, recents, ordered collections, and saved searches", async () => {
    const compare = tool("campaign_template_compare");
    await expect(
      compare.definition.handler({ templates: ["tpl_1", "weekly"] }),
    ).resolves.toMatchObject({
      items: [{ requested_identifier: "tpl_1" }],
      unavailable_identifiers: ["weekly"],
    });
    expect(compare.campaignTemplates.compare).toHaveBeenCalledWith([
      "tpl_1",
      "weekly",
    ]);

    const favorite = tool("campaign_template_favorite");
    await favorite.definition.handler({ template_id: "tpl_1" });
    expect(favorite.campaignTemplates.favorite).toHaveBeenCalledWith("tpl_1");

    const unfavorite = tool("campaign_template_unfavorite");
    await unfavorite.definition.handler({ template_id: "tpl_1" });
    expect(unfavorite.campaignTemplates.unfavorite).toHaveBeenCalledWith(
      "tpl_1",
    );

    const recent = tool("campaign_template_recent_record");
    await recent.definition.handler({ template_id: "tpl_1" });
    expect(recent.campaignTemplates.recordView).toHaveBeenCalledWith("tpl_1");

    const createCollection = tool("campaign_template_collection_create");
    await createCollection.definition.handler({
      idempotency_key: "collection-create-key",
      name: "Editorial ideas",
      template_ids: ["tpl_1"],
    });
    expect(
      createCollection.campaignTemplates.createCollection,
    ).toHaveBeenCalledWith(
      {
        name: "Editorial ideas",
        template_ids: ["tpl_1"],
      },
      "collection-create-key",
    );

    const collectionETag = '"campaign-template-collection:collection_1:v3"';
    const updateCollection = tool("campaign_template_collection_update");
    await updateCollection.definition.handler({
      collection_id: "collection_1",
      if_match: collectionETag,
      name: "Better editorial ideas",
    });
    expect(
      updateCollection.campaignTemplates.updateCollection,
    ).toHaveBeenCalledWith(
      "collection_1",
      { name: "Better editorial ideas" },
      collectionETag,
    );

    const replace = tool("campaign_template_collection_replace_items");
    await replace.definition.handler({
      collection_id: "collection_1",
      if_match: collectionETag,
      template_ids: ["tpl_2", "tpl_1"],
    });
    expect(
      replace.campaignTemplates.replaceCollectionItems,
    ).toHaveBeenCalledWith("collection_1", ["tpl_2", "tpl_1"], collectionETag);

    const deleteCollection = tool("campaign_template_collection_delete");
    await deleteCollection.definition.handler({
      collection_id: "collection_1",
      if_match: collectionETag,
    });
    expect(
      deleteCollection.campaignTemplates.deleteCollection,
    ).toHaveBeenCalledWith("collection_1", collectionETag);

    const listSearches = tool("campaign_template_saved_search_list");
    await expect(listSearches.definition.handler({})).resolves.toMatchObject({
      items: [
        {
          id: "search_1",
          obsolete_filters: [{ field: "tags", value: "retired-topic" }],
        },
      ],
    });

    const save = tool("campaign_template_saved_search_create");
    await save.definition.handler({
      idempotency_key: "saved-search-create-key",
      name: "Favorite newsletters",
      filters: {
        goal: "newsletter",
        favorited: true,
        sort: "most_used",
      },
    });
    expect(save.campaignTemplates.createSavedSearch).toHaveBeenCalledWith(
      {
        name: "Favorite newsletters",
        filters: {
          goal: "newsletter",
          favorited: true,
          sort: "most_used",
        },
      },
      "saved-search-create-key",
    );

    const savedSearchETag = '"campaign-template-saved-search:search_1:v5"';
    const updateSearch = tool("campaign_template_saved_search_update");
    await updateSearch.definition.handler({
      saved_search_id: "search_1",
      if_match: savedSearchETag,
      name: "Favorite editorial newsletters",
    });
    expect(
      updateSearch.campaignTemplates.updateSavedSearch,
    ).toHaveBeenCalledWith(
      "search_1",
      { name: "Favorite editorial newsletters" },
      savedSearchETag,
    );

    const run = tool("campaign_template_saved_search_results");
    await run.definition.handler({
      saved_search_id: "search_1",
      cursor: "eyJ2IjoxLCJwIjoyfQ",
      per_page: 50,
    });
    expect(run.campaignTemplates.savedSearchResults).toHaveBeenCalledWith(
      "search_1",
      { cursor: "eyJ2IjoxLCJwIjoyfQ", per_page: 50 },
    );

    const deleteSearch = tool("campaign_template_saved_search_delete");
    await deleteSearch.definition.handler({
      saved_search_id: "search_1",
      if_match: savedSearchETag,
    });
    expect(
      deleteSearch.campaignTemplates.deleteSavedSearch,
    ).toHaveBeenCalledWith("search_1", savedSearchETag);
  });

  it("requires discovery create identities and exact mutation ETags", () => {
    expect(tool("campaign_template_compare").definition.description).toContain(
      "unavailable_identifiers",
    );
    for (const name of [
      "campaign_template_saved_search_list",
      "campaign_template_saved_search_get",
      "campaign_template_saved_search_update",
    ]) {
      expect(tool(name).definition.description).toContain("obsolete_filters");
    }
    expect(
      tool("campaign_template_compare").definition.schema.safeParse({
        templates: ["one"],
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_compare").definition.schema.safeParse({
        templates: ["weekly-newsletter", "WEEKLY-NEWSLETTER"],
      }).success,
    ).toBe(false);
    expect(
      tool(
        "campaign_template_collection_replace_items",
      ).definition.schema.safeParse({
        collection_id: "collection_1",
        if_match: '"campaign-template-collection:collection_1:v1"',
        template_ids: ["tpl_1", "tpl_1"],
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_collection_update").definition.schema.safeParse({
        collection_id: "collection_1",
        if_match: '"campaign-template-collection:collection_1:v1"',
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_collection_update").definition.schema.safeParse({
        collection_id: "collection_1",
        if_match: 'W/"campaign-template-collection:collection_1:v1"',
        name: "Unsafe",
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_collection_delete").definition.schema.safeParse({
        collection_id: "collection_1",
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_saved_search_create").definition.schema.safeParse(
        {
          idempotency_key: "saved-search-invalid-filter",
          name: "x",
          filters: { cursor: "must-not-be-saved" },
        },
      ).success,
    ).toBe(false);
    expect(
      tool("campaign_template_saved_search_create").definition.schema.safeParse(
        {
          idempotency_key: "saved-search-reference-filter",
          name: "References",
          filters: {
            provider: "reallygoodemails",
            kind: "reference",
          },
        },
      ).success,
    ).toBe(true);
    expect(
      tool("campaign_template_saved_search_create").definition.schema.safeParse(
        {
          name: "Missing create identity",
          filters: {},
        },
      ).success,
    ).toBe(false);
    expect(
      tool("campaign_template_saved_search_update").definition.schema.safeParse(
        {
          saved_search_id: "search_1",
          if_match: '"campaign-template-collection:search_1:v1"',
          name: "Cross-resource token",
        },
      ).success,
    ).toBe(false);
    expect(
      tool("campaign_template_saved_search_delete").definition.schema.safeParse(
        {
          saved_search_id: "search_1",
          if_match: '"campaign-template-saved-search:search_1:v1"',
        },
      ).success,
    ).toBe(true);

    expect(
      tool("campaign_template_collection_create").definition.annotations
        ?.idempotentHint,
    ).toBe(true);
    expect(
      tool("campaign_template_collection_delete").definition.annotations
        ?.idempotentHint,
    ).toBe(false);
    expect(
      tool("campaign_template_saved_search_delete").definition.annotations
        ?.idempotentHint,
    ).toBe(false);
  });

  it("requires exact strong etags and bounds lifecycle history inputs", () => {
    const update = tool("campaign_template_update").definition.schema;
    expect(
      update.safeParse({
        template_id: "tpl_1",
        patch: { subject: "Updated" },
      }).success,
    ).toBe(false);
    expect(
      update.safeParse({
        template_id: "tpl_1",
        if_match: 'W/"campaign-template:tpl_1:v1"',
        patch: { subject: "Updated" },
      }).success,
    ).toBe(false);
    expect(
      update.safeParse({
        template_id: "tpl_1",
        if_match: "*",
        patch: { subject: "Updated" },
      }).success,
    ).toBe(false);
    expect(
      update.safeParse({
        template_id: "tpl_1",
        if_match: '"campaign-template:tpl_1:v1"',
        patch: {},
      }).success,
    ).toBe(false);
    expect(
      update.safeParse({
        template_id: "tpl_1",
        if_match: '"campaign-template:tpl_1:v1"',
        patch: { source_provider: "forged" },
      }).success,
    ).toBe(false);
    expect(
      update.safeParse({
        template_id: "tpl_1",
        if_match: '"campaign-template:tpl_1:v1"',
        patch: { subject: "Updated" },
      }).success,
    ).toBe(true);

    expect(
      tool("campaign_template_archive").definition.schema.safeParse({
        template_id: "tpl_1",
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_restore").definition.schema.safeParse({
        template_id: "tpl_1",
        if_match: '"campaign-template:tpl_1:v2"',
      }).success,
    ).toBe(true);
    expect(
      tool("campaign_template_revisions").definition.schema.safeParse({
        template_id: "tpl_1",
        per_page: 51,
      }).success,
    ).toBe(false);
    expect(
      tool("campaign_template_revision_get").definition.schema.safeParse({
        template_id: "tpl_1",
        version: 0,
      }).success,
    ).toBe(false);
  });

  it("forwards adaptation without duplicating template_id in the body", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_adapt");

    await definition.handler({
      idempotency_key: "adapt-tpl-1-blue-v1",
      template_id: "tpl_1",
      instructions: "Use our blue brand",
      tone: "conversational",
      subject: "A warmer update",
      brand: { primary_color: "#123456" },
      reference_template_ids: ["tpl_2", "tpl_3"],
    });

    expect(campaignTemplates.adapt).toHaveBeenCalledWith(
      "tpl_1",
      {
        instructions: "Use our blue brand",
        tone: "conversational",
        subject: "A warmer update",
        brand: { primary_color: "#123456" },
        reference_template_ids: ["tpl_2", "tpl_3"],
      },
      { idempotencyKey: "adapt-tpl-1-blue-v1" },
    );
  });

  it("forwards generation, durable review/refine/save, and draft creation", async () => {
    const generate = tool("campaign_template_generate");
    await generate.definition.handler({
      idempotency_key: "generate-ai-weekly-v1",
      brief: "A B2B AI roundup",
      kind: "newsletter",
      tone: "analytical",
      category: "editorial",
      subject: "AI weekly",
      preview_text: "Five developments worth knowing",
      audience: "AI leaders",
      industry: "technology",
      style: "minimal",
      layout: "digest",
      brand: { primary_color: "#123456" },
      content: { stories: ["one", "two"] },
      variables: { issue: 12 },
      reference_template_ids: ["tpl_1", "tpl_2", "tpl_3"],
    });
    expect(generate.campaignTemplates.generate).toHaveBeenCalledWith(
      {
        brief: "A B2B AI roundup",
        kind: "newsletter",
        tone: "analytical",
        category: "editorial",
        subject: "AI weekly",
        preview_text: "Five developments worth knowing",
        audience: "AI leaders",
        industry: "technology",
        style: "minimal",
        layout: "digest",
        brand: { primary_color: "#123456" },
        content: { stories: ["one", "two"] },
        variables: { issue: 12 },
        reference_template_ids: ["tpl_1", "tpl_2", "tpl_3"],
      },
      { idempotencyKey: "generate-ai-weekly-v1" },
    );

    const listDesigns = tool("campaign_template_design_list");
    await expect(
      listDesigns.definition.handler({
        limit: 50,
        cursor: "actor-bound-current",
      }),
    ).resolves.toMatchObject({
      items: [
        {
          id: "design_1",
          recommended_action: "review_campaign_template_design",
        },
      ],
      next_cursor: "actor-bound-next",
    });
    expect(listDesigns.campaignTemplates.listDesigns).toHaveBeenCalledWith({
      limit: 50,
      cursor: "actor-bound-current",
    });

    const get = tool("campaign_template_design_get");
    await get.definition.handler({ design_id: "design_1" });
    expect(get.campaignTemplates.getDesign).toHaveBeenCalledWith("design_1");

    const revisions = tool("campaign_template_design_revisions");
    await revisions.definition.handler({ design_id: "design_1" });
    expect(
      revisions.campaignTemplates.listDesignRevisions,
    ).toHaveBeenCalledWith("design_1");

    const refine = tool("campaign_template_design_refine");
    await refine.definition.handler({
      idempotency_key: "refine-design-1-r1-cards",
      design_id: "design_1",
      instructions: "Tighten the story cards",
      base_revision: 1,
    });
    expect(refine.campaignTemplates.refineDesign).toHaveBeenCalledWith(
      "design_1",
      {
        instructions: "Tighten the story cards",
        base_revision: 1,
      },
      { idempotencyKey: "refine-design-1-r1-cards" },
    );

    const retry = tool("campaign_template_design_retry");
    await retry.definition.handler({
      idempotency_key: "retry-design-1-attempt-2",
      design_id: "design_1",
    });
    expect(retry.campaignTemplates.retryDesign).toHaveBeenCalledWith(
      "design_1",
      { idempotencyKey: "retry-design-1-attempt-2" },
    );

    const save = tool("campaign_template_save");
    await save.definition.handler({
      idempotency_key: "save-design-1-r2",
      design_id: "design_1",
      slug: "ai-weekly-12",
      revision: 2,
      output_hash: "a".repeat(64),
    });
    expect(save.campaignTemplates.saveDesign).toHaveBeenCalledWith(
      "design_1",
      {
        slug: "ai-weekly-12",
        revision: 2,
        output_hash: "a".repeat(64),
      },
      { idempotencyKey: "save-design-1-r2" },
    );

    const fromDesign = tool("campaign_template_design_create_campaign");
    await fromDesign.definition.handler({
      idempotency_key: "campaign-design-1-r2",
      design_id: "design_1",
      revision: 2,
      output_hash: "a".repeat(64),
      list_id: "00042",
    });
    expect(
      fromDesign.campaignTemplates.createCampaignFromDesign,
    ).toHaveBeenCalledWith(
      "design_1",
      {
        revision: 2,
        output_hash: "a".repeat(64),
        list_id: "00042",
      },
      {
        idempotencyKey: "campaign-design-1-r2",
      },
    );

    const archive = tool("campaign_template_design_archive");
    await archive.definition.handler({
      idempotency_key: "archive-design-2",
      design_id: "design_2",
    });
    expect(archive.campaignTemplates.archiveDesign).toHaveBeenCalledWith(
      "design_2",
      { idempotencyKey: "archive-design-2" },
    );

    const draft = tool("campaign_create_from_template");
    await draft.definition.handler({
      template_id: "tpl_1",
      name: "AI weekly",
      variables: { issue: 12 },
      list_id: "00042",
    });
    expect(draft.campaignTemplates.createCampaign).toHaveBeenCalledWith({
      template_id: "tpl_1",
      name: "AI weekly",
      variables: { issue: 12 },
      list_id: "00042",
    });
  });

  it("validates slugs, pagination, goals, and reference count", () => {
    const create = tool("campaign_template_create").definition;
    expect(
      create.schema.safeParse({
        slug: "Not Valid",
        name: "x",
        subject: "x",
      }).success,
    ).toBe(false);
    expect(
      create.schema.safeParse({
        slug: "weekly",
        name: "Weekly",
        subject: "Weekly",
        template_kind: "reference",
        source_provider: "reallygoodemails",
        review_status: "approved",
      }).success,
    ).toBe(false);

    const search = tool("campaign_template_search").definition;
    expect(search.schema.safeParse({ per_page: 101 }).success).toBe(false);
    expect(
      search.schema.safeParse({ cursor: "eyJ2IjoxLCJwIjoyfQ" }).success,
    ).toBe(true);
    expect(search.schema.safeParse({ cursor: "0" }).success).toBe(false);
    expect(search.schema.safeParse({ cursor: "2.5" }).success).toBe(false);
    expect(search.schema.safeParse({ cursor: "opaque" }).success).toBe(false);
    expect(search.schema.safeParse({ goal: "not-a-goal" }).success).toBe(false);
    expect(
      search.schema.safeParse({ source: "reallygoodemails" }).success,
    ).toBe(true);

    const generate = tool("campaign_template_generate").definition;
    expect(
      generate.schema.safeParse({
        idempotency_key: "generate-validation",
        brief: "x",
        reference_template_ids: ["a", "b", "c", "d"],
      }).success,
    ).toBe(false);
    expect(
      generate.schema.safeParse({
        idempotency_key: "generate-validation",
        brief: "x",
        kind: "transactional",
      }).success,
    ).toBe(false);
    expect(
      generate.schema.safeParse({
        idempotency_key: "generate-validation",
        brief: "x",
        variables: ["not", "a", "map"],
      }).success,
    ).toBe(false);

    const adapt = tool("campaign_template_adapt").definition;
    expect(
      adapt.schema.safeParse({
        idempotency_key: "adapt-validation",
        template_id: "tpl_1",
        reference_template_ids: ["a", "b", "c"],
      }).success,
    ).toBe(false);
    expect(
      adapt.schema.safeParse({
        idempotency_key: "adapt-validation",
        template_id: "tpl_1",
        subject: "x".repeat(2_001),
      }).success,
    ).toBe(false);

    const draft = tool("campaign_create_from_template").definition;
    expect(
      draft.schema.safeParse({ template_id: "tpl_1", list_id: 42 }).success,
    ).toBe(true);
    expect(
      draft.schema.safeParse({ template_id: "tpl_1", list_id: "00042" })
        .success,
    ).toBe(true);
    expect(
      draft.schema.safeParse({ template_id: "tpl_1", list_id: "not-digits" })
        .success,
    ).toBe(false);
    expect(
      draft.schema.safeParse({ template_id: "tpl_1", list_id: "0" }).success,
    ).toBe(false);
  });

  it("matches REST authoring and durable-design size boundaries", () => {
    const create = tool("campaign_template_create").definition.schema;
    const baseCreate = {
      slug: "bounded",
      name: "Bounded",
      subject: "x".repeat(998),
    };
    expect(create.safeParse(baseCreate).success).toBe(true);
    expect(
      create.safeParse({ slug: "subject-optional", name: "Subject optional" })
        .success,
    ).toBe(true);
    expect(
      create.safeParse({ ...baseCreate, subject: "x".repeat(999) }).success,
    ).toBe(false);
    expect(
      create.safeParse({
        ...baseCreate,
        preview_text: "x".repeat(500),
        body_html: "x".repeat(1_048_576),
        variables: Array.from({ length: 100 }, (_, i) => ({ key: `v${i}` })),
      }).success,
    ).toBe(true);
    expect(
      create.safeParse({
        ...baseCreate,
        body_html: "x".repeat(1_048_577),
      }).success,
    ).toBe(false);
    expect(
      create.safeParse({
        ...baseCreate,
        variables: Array.from({ length: 101 }, (_, i) => ({ key: `v${i}` })),
      }).success,
    ).toBe(false);

    const update = tool("campaign_template_update").definition.schema;
    const updateEnvelope = {
      template_id: "tpl_1",
      if_match: '"campaign-template:tpl_1:v1"',
    };
    expect(
      update.safeParse({
        ...updateEnvelope,
        patch: { preview_text: "x".repeat(500) },
      }).success,
    ).toBe(true);
    expect(
      update.safeParse({
        ...updateEnvelope,
        patch: { preview_text: "x".repeat(501) },
      }).success,
    ).toBe(false);

    const adapt = tool("campaign_template_adapt").definition.schema;
    expect(
      adapt.safeParse({
        idempotency_key: "adapt-boundary",
        template_id: "tpl_1",
        instructions: "x".repeat(4_000),
      }).success,
    ).toBe(true);
    expect(
      adapt.safeParse({
        idempotency_key: "adapt-boundary",
        template_id: "tpl_1",
        instructions: "x".repeat(4_001),
      }).success,
    ).toBe(false);

    const generate = tool("campaign_template_generate").definition.schema;
    expect(
      generate.safeParse({
        idempotency_key: "generate-boundary",
        brief: "x".repeat(8_000),
        audience: "x".repeat(1_500),
      }).success,
    ).toBe(true);
    expect(
      generate.safeParse({
        idempotency_key: "generate-boundary",
        brief: "x".repeat(8_001),
      }).success,
    ).toBe(false);
    expect(
      generate.safeParse({
        idempotency_key: "generate-boundary",
        brief: "x",
        audience: "x".repeat(1_501),
      }).success,
    ).toBe(false);
  });

  it("matches the design recovery list REST limits and opaque cursor bounds", () => {
    const schema = tool("campaign_template_design_list").definition.schema;

    expect(schema.safeParse({}).success).toBe(true);
    expect(
      schema.safeParse({ limit: 1, cursor: "x".repeat(1_024) }).success,
    ).toBe(true);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ cursor: ` ${"x".repeat(16)}` }).success).toBe(
      false,
    );
    expect(schema.safeParse({ cursor: "😀".repeat(257) }).success).toBe(false);
    expect(schema.safeParse({ cursor: "x".repeat(1_025) }).success).toBe(false);
  });

  it("requires a bounded control-free replay key for every durable design mutation", () => {
    const validInputs: Record<string, Record<string, unknown>> = {
      campaign_template_adapt: {
        idempotency_key: "adapt-template-1-v1",
        template_id: "tpl_1",
      },
      campaign_template_generate: {
        idempotency_key: "generate-weekly-v1",
        brief: "Weekly digest",
      },
      campaign_template_design_refine: {
        idempotency_key: "refine-design-1-r1",
        design_id: "design_1",
        base_revision: 1,
        instructions: "Shorter hero",
      },
      campaign_template_design_retry: {
        idempotency_key: "retry-design-1-v1",
        design_id: "design_1",
      },
      campaign_template_save: {
        idempotency_key: "save-design-1-r1",
        design_id: "design_1",
        slug: "weekly",
        revision: 1,
        output_hash: "a".repeat(64),
      },
      campaign_template_design_create_campaign: {
        idempotency_key: "campaign-design-1-r1",
        design_id: "design_1",
        revision: 1,
        output_hash: "a".repeat(64),
      },
      campaign_template_design_archive: {
        idempotency_key: "archive-design-1",
        design_id: "design_1",
      },
    };

    for (const [name, input] of Object.entries(validInputs)) {
      const schema = tool(name).definition.schema;
      expect(schema.safeParse(input).success, name).toBe(true);
      const withoutKey = { ...input };
      delete withoutKey.idempotency_key;
      expect(schema.safeParse(withoutKey).success, `${name} missing key`).toBe(
        false,
      );
      expect(
        schema.safeParse({ ...input, idempotency_key: "bad\nkey" }).success,
        `${name} control key`,
      ).toBe(false);
      expect(
        schema.safeParse({ ...input, idempotency_key: "x".repeat(256) })
          .success,
        `${name} oversized key`,
      ).toBe(false);
    }
  });

  it("marks lifecycle reads and mutations correctly and declares campaign scopes", () => {
    const { client } = makeClient();
    const tools = campaignTemplateTools(client as any);
    const byName = new Map(tools.map((entry) => [entry.name, entry]));

    expect(
      byName.get("campaign_template_search")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(byName.get("campaign_template_get")?.annotations?.readOnlyHint).toBe(
      true,
    );
    expect(
      byName.get("campaign_template_revisions")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("campaign_template_revision_get")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("campaign_template_design_list")?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("campaign_template_archive")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(
      byName.get("campaign_template_restore")?.annotations?.destructiveHint,
    ).toBe(false);
    expect(
      byName.get("campaign_template_delete")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(
      byName.get("campaign_template_create")?.annotations?.destructiveHint,
    ).toBe(false);
    expect(
      byName.get("campaign_template_favorite")?.annotations?.idempotentHint,
    ).toBe(true);
    for (const name of [
      "campaign_template_adapt",
      "campaign_template_generate",
      "campaign_template_design_refine",
      "campaign_template_design_retry",
      "campaign_template_save",
      "campaign_template_design_create_campaign",
      "campaign_template_design_archive",
    ]) {
      expect(byName.get(name)?.annotations?.idempotentHint, name).toBe(true);
    }
    expect(byName.get("campaign_template_search")?.requiredScopes).toEqual([
      "read:campaigns",
    ]);
    expect(byName.get("campaign_template_design_list")?.requiredScopes).toEqual(
      ["read:campaigns"],
    );
    expect(byName.get("campaign_template_generate")?.requiredScopes).toEqual([
      "write:campaigns",
    ]);
    expect(byName.get("campaign_template_revisions")?.requiredScopes).toEqual([
      "read:campaigns",
    ]);
    expect(byName.get("campaign_template_archive")?.requiredScopes).toEqual([
      "write:campaigns",
    ]);
    expect(
      byName.get("campaign_template_delete")?.description.toLowerCase(),
    ).toContain("never permanently deletes");
  });

  it("preserves typed SDK failures while attaching the MCP tool name", async () => {
    const { definition, campaignTemplates } = tool("campaign_template_get");
    const failure = Object.assign(new Error("backend unavailable"), {
      name: "ServerError",
      status: 503,
      code: "generator_unavailable",
      requestId: "req_123",
    });
    campaignTemplates.get.mockRejectedValueOnce(failure);

    await expect(
      definition.handler({ template_id: "tpl_1" }),
    ).rejects.toMatchObject({
      message: "backend unavailable",
      status: 503,
      code: "generator_unavailable",
      requestId: "req_123",
      tool: "campaign_template_get",
    });
  });
});

// The API resolves a template by ID or slug for reads and draft creation
// (TMPL item 4), so an agent can use the slug a search row or a doc gave it.
// Driven through the real SDK client: the exact request that leaves MCP.
describe("campaign template tools resolve a slug", () => {
  function realClientTools() {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const payload = url.endsWith("/from-template")
        ? { id: "cmp_1", status: "draft" }
        : { id: "0b5f0c1e-5d7a-4f55-9d0e-8c1f7a3e2b10", slug: "newsletter-one-link" };
      return new Response(JSON.stringify(payload), {
        status: url.endsWith("/from-template") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_test_key",
      baseUrl: "https://api.example.test",
      fetch: fetchImpl as unknown as typeof fetch,
      retries: 0,
    });
    const tools = campaignTemplateTools(client);
    const find = (name: string) => tools.find((entry) => entry.name === name)!;
    return { requests, find };
  }

  it("fetches a template by its slug", async () => {
    const { requests, find } = realClientTools();
    const get = find("campaign_template_get");
    const input = get.schema.parse({ template_id: "newsletter-one-link" });
    await get.handler(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/v1/campaign-templates/newsletter-one-link",
    );
  });

  it("creates a draft from a template slug", async () => {
    const { requests, find } = realClientTools();
    const create = find("campaign_create_from_template");
    const input = create.schema.parse({
      template_id: "newsletter-one-link",
      name: "September digest",
    });
    await create.handler(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/api/v1/campaigns/from-template",
    );
    expect(requests[0]!.body).toMatchObject({
      template_id: "newsletter-one-link",
      name: "September digest",
    });
  });

  it("tells agents the slug is accepted", () => {
    const { find } = realClientTools();
    for (const name of ["campaign_template_get", "campaign_create_from_template"]) {
      const definition = find(name);
      expect(definition.description).toMatch(/ID or slug/);
      const shape = (definition.schema as unknown as {
        shape: Record<string, { description?: string }>;
      }).shape;
      expect(shape.template_id?.description).toMatch(/slug/);
    }
  });
});
