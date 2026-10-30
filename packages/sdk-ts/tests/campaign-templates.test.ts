import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CampaignTemplatesResource", () => {
  it("keeps visual templates separate from voice templates", () => {
    const pw = new PostwaveClient({ apiKey: "k", fetch: vi.fn() });

    expect(pw.campaignTemplates).toBeDefined();
    expect(pw.templates).toBeDefined();
    expect(pw.campaignTemplates).not.toBe(pw.templates);
  });

  it("types partial compare availability and authoritative saved-search drift", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/campaign-templates/compare")) {
        return json({
          items: [
            {
              requested_identifier: "template-1",
              matched_by: "id",
              template: { id: "template-1" },
            },
          ],
          unavailable_identifiers: ["removed-template"],
        });
      }
      return json({
        items: [
          {
            id: "saved-search-1",
            name: "Editorial",
            filters: { tags: ["retired-topic"] },
            obsolete_filters: [{ field: "tags", value: "retired-topic" }],
            created_at: "2026-07-30T00:00:00Z",
            updated_at: "2026-07-30T00:00:00Z",
            version: 3,
            etag: '"campaign-template-saved-search:saved-search-1:v3"',
          },
        ],
      });
    });
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    const comparison = await pw.campaignTemplates.compare([
      "template-1",
      "removed-template",
    ]);
    const searches = await pw.campaignTemplates.listSavedSearches();

    expect(comparison.items[0]?.requested_identifier).toBe("template-1");
    expect(comparison.unavailable_identifiers).toEqual(["removed-template"]);
    expect(searches.items[0]?.obsolete_filters).toEqual([
      { field: "tags", value: "retired-topic" },
    ]);
  });

  it("routes search filters and serializes tags compactly", async () => {
    const fetch = vi.fn(async () =>
      json({ items: [], total: 0, page: 2, per_page: 25 }),
    );
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    await pw.campaignTemplates.search({
      q: "editorial ai",
      goal: "newsletter",
      source: "platform",
      style: "minimal",
      layout: "digest",
      industry: "technology",
      tags: ["weekly", "data"],
      featured: true,
      favorited: false,
      page: 2,
      per_page: 25,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaign-templates/search?q=editorial+ai&goal=newsletter&source=platform&style=minimal&layout=digest&industry=technology&tags=weekly%2Cdata&featured=true&favorited=false&page=2&per_page=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("forwards stable cursors, server sort, and discovery-state operations", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ items: [], ok: true });
    });
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    await pw.campaignTemplates.search({
      sort: "most_used",
      cursor: "eyJ2IjoxLCJwIjoyfQ",
      per_page: 50,
    });
    await pw.campaignTemplates.compare(["tpl_1", "weekly"]);
    await pw.campaignTemplates.favorite("tpl/1");
    await pw.campaignTemplates.unfavorite("tpl/1");
    await pw.campaignTemplates.recordView("tpl/1");
    await pw.campaignTemplates.recent(12);
    await pw.campaignTemplates.clearRecent("tpl/1");
    await pw.campaignTemplates.createCollection(
      {
        name: "Ideas",
        template_ids: ["tpl_2", "tpl_1"],
      },
      "collection-create-attempt-1",
    );
    await pw.campaignTemplates.replaceCollectionItems(
      "collection/1",
      ["tpl_1"],
      '"campaign-template-collection:collection/1:v1"',
    );
    await pw.campaignTemplates.createSavedSearch(
      {
        name: "Favorites",
        filters: { favorited: true, sort: "name" },
      },
      "saved-search-create-attempt-1",
    );
    await pw.campaignTemplates.savedSearchResults("search/1", {
      cursor: "eyJ2IjoxLCJwIjoyfQ",
      per_page: 24,
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/search?sort=most_used&cursor=eyJ2IjoxLCJwIjoyfQ&per_page=50",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/compare?templates=tpl_1%2Cweekly",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2F1/favorite",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2F1/unfavorite",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2F1/view",
        method: "POST",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/recent?limit=12",
        method: "GET",
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/recent/tpl%2F1",
        method: "DELETE",
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-collections",
        method: "POST",
        body: { name: "Ideas", template_ids: ["tpl_2", "tpl_1"] },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-collections/collection%2F1/items",
        method: "PUT",
        body: { template_ids: ["tpl_1"] },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-saved-searches",
        method: "POST",
        body: {
          name: "Favorites",
          filters: { favorited: true, sort: "name" },
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-saved-searches/search%2F1/results?cursor=eyJ2IjoxLCJwIjoyfQ&per_page=24",
        method: "GET",
      },
    ]);
  });

  it("forwards caller-held create identities and exact discovery ETags", async () => {
    const seen: Array<{
      idempotencyKey: string | null;
      ifMatch: string | null;
      method?: string;
      path: string;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        idempotencyKey: headers.get("Idempotency-Key"),
        ifMatch: headers.get("If-Match"),
        method: init?.method,
        path: new URL(url).pathname,
      });
      return json({ ok: true, deleted: true });
    });
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });
    const collectionETag = '"campaign-template-collection:collection-1:v7"';
    const savedSearchETag =
      '"campaign-template-saved-search:saved-search-1:v4"';

    await pw.campaignTemplates.createCollection(
      { name: "Ideas" },
      "collection-create-key",
    );
    await pw.campaignTemplates.updateCollection(
      "collection-1",
      { name: "Better ideas" },
      collectionETag,
    );
    await pw.campaignTemplates.replaceCollectionItems(
      "collection-1",
      ["template-1"],
      collectionETag,
    );
    await pw.campaignTemplates.deleteCollection("collection-1", collectionETag);
    await pw.campaignTemplates.createSavedSearch(
      { name: "Favorites", filters: { favorited: true } },
      "saved-search-create-key",
    );
    await pw.campaignTemplates.updateSavedSearch(
      "saved-search-1",
      { name: "Favorite newsletters" },
      savedSearchETag,
    );
    await pw.campaignTemplates.deleteSavedSearch(
      "saved-search-1",
      savedSearchETag,
    );

    expect(seen).toEqual([
      {
        idempotencyKey: "collection-create-key",
        ifMatch: null,
        method: "POST",
        path: "/api/v1/campaign-template-collections",
      },
      {
        idempotencyKey: expect.any(String),
        ifMatch: collectionETag,
        method: "PATCH",
        path: "/api/v1/campaign-template-collections/collection-1",
      },
      {
        idempotencyKey: null,
        ifMatch: collectionETag,
        method: "PUT",
        path: "/api/v1/campaign-template-collections/collection-1/items",
      },
      {
        idempotencyKey: expect.any(String),
        ifMatch: collectionETag,
        method: "DELETE",
        path: "/api/v1/campaign-template-collections/collection-1",
      },
      {
        idempotencyKey: "saved-search-create-key",
        ifMatch: null,
        method: "POST",
        path: "/api/v1/campaign-template-saved-searches",
      },
      {
        idempotencyKey: expect.any(String),
        ifMatch: savedSearchETag,
        method: "PATCH",
        path: "/api/v1/campaign-template-saved-searches/saved-search-1",
      },
      {
        idempotencyKey: expect.any(String),
        ifMatch: savedSearchETag,
        method: "DELETE",
        path: "/api/v1/campaign-template-saved-searches/saved-search-1",
      },
    ]);
  });

  it("rejects unsafe discovery identities and cross-resource ETags before fetch", () => {
    const fetch = vi.fn();
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    expect(() =>
      pw.campaignTemplates.createCollection({ name: "Ideas" }, "invalid\nkey"),
    ).toThrow(/idempotencyKey/);
    expect(() =>
      pw.campaignTemplates.updateCollection(
        "collection-1",
        { name: "Unsafe" },
        '"campaign-template-saved-search:collection-1:v1"',
      ),
    ).toThrow(/exact current campaign-template-collection etag/);
    expect(() =>
      pw.campaignTemplates.deleteSavedSearch(
        "saved-search-1",
        '"campaign-template-saved-search:another-search:v1"',
      ),
    ).toThrow(/exact current campaign-template-saved-search etag/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes concurrency-safe lifecycle and revision calls with encoded template IDs", async () => {
    const seen: Array<{
      url: string;
      method?: string;
      body?: unknown;
      ifMatch: string | null;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: new Headers(init?.headers).get("If-Match"),
      });
      return json({ ok: true, id: "tpl_1" });
    });
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });
    const etag1 = '"campaign-template:tpl_1:v1"';
    const etag2 = '"campaign-template:tpl_1:v2"';
    const etag3 = '"campaign-template:tpl_1:v3"';
    const etag4 = '"campaign-template:tpl_1:v4"';

    await pw.campaignTemplates.get("tpl/a b");
    await pw.campaignTemplates.create({
      slug: "weekly-brief",
      name: "Weekly brief",
      subject: "This week",
      body_mjml: "<mjml />",
    });
    await pw.campaignTemplates.update(
      "tpl/a b",
      { subject: "Next week" },
      etag1,
    );
    await pw.campaignTemplates.archive("tpl/a b", etag2);
    await pw.campaignTemplates.restore("tpl/a b", etag3);
    await pw.campaignTemplates.listRevisions("tpl/a b", {
      page: 2,
      per_page: 50,
    });
    await pw.campaignTemplates.getRevision("tpl/a b", 4);
    await pw.campaignTemplates.clone("tpl/a b", {
      name: "My weekly brief",
      slug: "my-weekly-brief",
    });
    await pw.campaignTemplates.delete("tpl/a b", etag4);

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b",
        method: "GET",
        body: undefined,
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates",
        method: "POST",
        body: {
          slug: "weekly-brief",
          name: "Weekly brief",
          subject: "This week",
          body_mjml: "<mjml />",
        },
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b",
        method: "PATCH",
        body: { subject: "Next week" },
        ifMatch: etag1,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b/archive",
        method: "PATCH",
        body: undefined,
        ifMatch: etag2,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b/restore",
        method: "PATCH",
        body: undefined,
        ifMatch: etag3,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b/revisions?page=2&per_page=50",
        method: "GET",
        body: undefined,
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b/revisions/4",
        method: "GET",
        body: undefined,
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b/clone",
        method: "POST",
        body: { name: "My weekly brief", slug: "my-weekly-brief" },
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-templates/tpl%2Fa%20b",
        method: "DELETE",
        body: undefined,
        ifMatch: etag4,
      },
    ]);
  });

  it("rejects weak/wildcard concurrency tokens and invalid revision paths", () => {
    const pw = new PostwaveClient({ apiKey: "k", fetch: vi.fn(), retries: 0 });

    expect(() =>
      pw.campaignTemplates.update("tpl_1", { subject: "No" }, 'W/"v1"'),
    ).toThrow(/exact strong etag/);
    expect(() => pw.campaignTemplates.archive("tpl_1", "*")).toThrow(
      /exact strong etag/,
    );
    expect(() => pw.campaignTemplates.restore("tpl_1", "")).toThrow(
      /exact strong etag/,
    );
    expect(() => pw.campaignTemplates.getRevision("tpl_1", 0)).toThrow(
      /positive safe integer/,
    );
  });

  it("lists compact actor-bound design recovery pages with an opaque cursor", async () => {
    const fetch = vi.fn(async () =>
      json({
        items: [
          {
            id: "design-1",
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
    );
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    const page = await pw.campaignTemplates.listDesigns({
      limit: 50,
      cursor: "actor-bound-current",
    });

    expect(page.items[0]?.recommended_action).toBe(
      "review_campaign_template_design",
    );
    expect(page.next_cursor).toBe("actor-bound-next");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaign-template-designs?limit=50&cursor=actor-bound-current",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("enforces the design recovery list REST bounds before network I/O", async () => {
    const fetch = vi.fn(async () => json({ items: [] }));
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    for (const limit of [0, 51, 1.5, Number.NaN]) {
      expect(() => pw.campaignTemplates.listDesigns({ limit })).toThrow(
        /integer between 1 and 50/,
      );
    }
    for (const cursor of [
      ` ${"x".repeat(16)}`,
      `${"x".repeat(16)} `,
      "😀".repeat(257),
      "x".repeat(1_025),
    ]) {
      expect(() => pw.campaignTemplates.listDesigns({ cursor })).toThrow(
        /at most 1024 UTF-8 bytes/,
      );
    }

    await expect(
      pw.campaignTemplates.listDesigns({
        limit: 1,
        cursor: "x".repeat(1_024),
      }),
    ).resolves.toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("routes every durable design mutation with its caller-stable idempotency key", async () => {
    const seen: Array<{
      url: string;
      method?: string;
      body?: unknown;
      idempotencyKey: string | null;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      return json({ id: "result_1" });
    });
    const pw = new PostwaveClient({ apiKey: "k", fetch, retries: 0 });

    await pw.campaignTemplates.adapt(
      "tpl/1",
      {
        instructions: "Make it warmer",
        tone: "conversational",
        subject: "A warmer weekly update",
        brand: { primary_color: "#112233" },
        content: { lead: "Welcome back" },
        variables: { issue_number: 12 },
        reference_template_ids: ["tpl_2", "tpl_3"],
      },
      { idempotencyKey: "adapt-key" },
    );
    await pw.campaignTemplates.generate(
      {
        brief: "A concise weekly AI digest",
        kind: "newsletter",
        tone: "analytical",
        category: "editorial",
        subject: "AI weekly",
        preview_text: "Five developments worth knowing",
        audience: "AI engineering leaders",
        industry: "technology",
        style: "minimal",
        layout: "digest",
        brand: { primary_color: "#112233" },
        content: { stories: ["one", "two"] },
        variables: { issue_number: 12 },
        reference_template_ids: ["tpl_1", "tpl_2", "tpl_3"],
      },
      { idempotencyKey: "generate-key" },
    );
    await pw.campaignTemplates.refineDesign(
      "design/1",
      {
        instructions: "Make the story cards more compact",
        base_revision: 1,
      },
      { idempotencyKey: "refine-key" },
    );
    await pw.campaignTemplates.retryDesign("design/1", {
      idempotencyKey: "retry-key",
    });
    await pw.campaignTemplates.saveDesign(
      "design/1",
      {
        slug: "ai-weekly-12",
        revision: 2,
        output_hash: "a".repeat(64),
      },
      { idempotencyKey: "save-key" },
    );
    await pw.campaignTemplates.createCampaignFromDesign(
      "design/2",
      {
        revision: 1,
        output_hash: "b".repeat(64),
        list_id: "00042",
      },
      { idempotencyKey: "campaign-key" },
    );
    await pw.campaignTemplates.archiveDesign("design/3", {
      idempotencyKey: "archive-key",
    });
    await pw.campaignTemplates.createCampaign({
      template_id: "tpl_1",
      name: "AI weekly #12",
      variables: { issue_number: 12 },
      list_id: "00042",
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs",
        method: "POST",
        idempotencyKey: "adapt-key",
        body: {
          instructions: "Make it warmer",
          tone: "conversational",
          subject: "A warmer weekly update",
          brand: { primary_color: "#112233" },
          content: { lead: "Welcome back" },
          variables: { issue_number: 12 },
          reference_template_ids: ["tpl_2", "tpl_3"],
          mode: "adapt",
          source_template_id: "tpl/1",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs",
        method: "POST",
        idempotencyKey: "generate-key",
        body: {
          brief: "A concise weekly AI digest",
          kind: "newsletter",
          tone: "analytical",
          category: "editorial",
          subject: "AI weekly",
          preview_text: "Five developments worth knowing",
          audience: "AI engineering leaders",
          industry: "technology",
          style: "minimal",
          layout: "digest",
          brand: { primary_color: "#112233" },
          content: { stories: ["one", "two"] },
          variables: { issue_number: 12 },
          reference_template_ids: ["tpl_1", "tpl_2", "tpl_3"],
          mode: "generate",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs/design%2F1/refine",
        method: "POST",
        idempotencyKey: "refine-key",
        body: {
          instructions: "Make the story cards more compact",
          base_revision: 1,
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs/design%2F1/retry",
        method: "POST",
        idempotencyKey: "retry-key",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs/design%2F1/save",
        method: "POST",
        idempotencyKey: "save-key",
        body: {
          slug: "ai-weekly-12",
          revision: 2,
          output_hash: "a".repeat(64),
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs/design%2F2/create-campaign",
        method: "POST",
        idempotencyKey: "campaign-key",
        body: {
          revision: 1,
          output_hash: "b".repeat(64),
          list_id: "00042",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/campaign-template-designs/design%2F3/archive",
        method: "POST",
        idempotencyKey: "archive-key",
        body: {},
      },
      {
        url: "https://api.moosewave.com/api/v1/campaigns/from-template",
        method: "POST",
        idempotencyKey: expect.any(String),
        body: {
          template_id: "tpl_1",
          name: "AI weekly #12",
          variables: { issue_number: 12 },
          list_id: "00042",
        },
      },
    ]);
  });
});
