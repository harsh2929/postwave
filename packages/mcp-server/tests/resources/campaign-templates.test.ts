// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { buildResources } from "../../src/resources/index.js";

function makeClient() {
  const campaignTemplates = {
    search: vi.fn().mockResolvedValue({
      items: [
        {
          id: "tpl_1",
          name: "Weekly",
          subject: "News",
          body_html: "<p>do not include</p>",
          body_mjml: "<mjml />",
        },
      ],
      total: 3_194,
      page: 1,
      per_page: 100,
      next_cursor: "2",
    }),
    get: vi.fn().mockResolvedValue({
      id: "tpl_1",
      name: "Weekly",
      body_mjml: "<mjml />",
    }),
  };
  return {
    client: {
      campaignTemplates,
      events: { stream: async function* () {} },
    },
    campaignTemplates,
  };
}

describe("campaign-template MCP resources", () => {
  it("exposes a compact static visual-template catalog", async () => {
    const { client, campaignTemplates } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { staticResources } = buildResources(client as any);
    const catalog = staticResources.find(
      (resource) => resource.uri === "moosewave://campaign-templates",
    )!;

    const result = (await catalog.read()) as {
      items: Array<Record<string, unknown>>;
      next_page: number;
      next_page_resource_uri: string;
    };

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      page: 1,
      per_page: 100,
    });
    expect(result.items[0]).toMatchObject({
      id: "tpl_1",
      resource_uri: "moosewave://campaign-templates/tpl_1",
    });
    expect(result.items[0]).not.toHaveProperty("body_html");
    expect(result.items[0]).not.toHaveProperty("body_mjml");
    expect(result.next_page).toBe(2);
    expect(result.next_page_resource_uri).toBe(
      "moosewave://campaign-templates/pages/2",
    );
  });

  it("exposes subsequent catalog pages as a resource template", async () => {
    const { client, campaignTemplates } = makeClient();
    campaignTemplates.search.mockResolvedValueOnce({
      items: [{ id: "tpl_3101", name: "Last page" }],
      total: 3_194,
      page: 32,
      per_page: 100,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { templates } = buildResources(client as any);
    const pageResource = templates.find(
      (resource) =>
        resource.uriTemplate === "moosewave://campaign-templates/pages/{page}",
    )!;
    const uri = "moosewave://campaign-templates/pages/32";
    const match = uri.match(pageResource.pattern)!;

    const result = (await pageResource.read(match)) as Record<string, unknown>;

    expect(campaignTemplates.search).toHaveBeenCalledWith({
      page: 32,
      per_page: 100,
    });
    expect(result).toMatchObject({
      page: 32,
      per_page: 100,
      total: 3_194,
      has_more: false,
      page_resource_uri: uri,
      previous_page_resource_uri: "moosewave://campaign-templates/pages/31",
    });
    expect(result).not.toHaveProperty("next_page");
    expect(result).not.toHaveProperty("next_page_resource_uri");
  });

  it("rejects invalid catalog page resource values", async () => {
    const { client, campaignTemplates } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { templates } = buildResources(client as any);
    const pageResource = templates.find(
      (resource) =>
        resource.uriTemplate === "moosewave://campaign-templates/pages/{page}",
    )!;
    const match = "moosewave://campaign-templates/pages/0".match(
      pageResource.pattern,
    )!;

    await expect(pageResource.read(match)).rejects.toThrow(
      "invalid campaign-template catalog page",
    );
    expect(campaignTemplates.search).not.toHaveBeenCalled();
  });

  it("fetches full editable source through the item template resource", async () => {
    const { client, campaignTemplates } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { templates } = buildResources(client as any);
    const item = templates.find(
      (resource) =>
        resource.uriTemplate === "moosewave://campaign-templates/{template_id}",
    )!;
    const match = "moosewave://campaign-templates/tpl%5F1".match(item.pattern)!;

    await expect(item.read(match)).resolves.toMatchObject({
      body_mjml: "<mjml />",
    });
    expect(campaignTemplates.get).toHaveBeenCalledWith("tpl_1");
  });

  it("rejects malformed or path-like template IDs", async () => {
    const { client, campaignTemplates } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { templates } = buildResources(client as any);
    const item = templates.find(
      (resource) =>
        resource.uriTemplate === "moosewave://campaign-templates/{template_id}",
    )!;
    const match = "moosewave://campaign-templates/tpl%2F1".match(item.pattern)!;

    await expect(item.read(match)).rejects.toThrow("missing template_id");
    expect(campaignTemplates.get).not.toHaveBeenCalled();
  });
});
