// SPDX-License-Identifier: MIT
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PostwaveClient } from "@postwave/sdk";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { capResponse } from "../lib/security.js";
import { compactCampaignTemplateSearch } from "../lib/campaign-template-format.js";
import { eventsStreamTemplate } from "./events.js";

const RESOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const CAMPAIGN_TEMPLATE_PAGE_SIZE = 100;

interface StaticResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: () => Promise<unknown>;
}

interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  /** RegExp matching the URI; capture groups are passed as args. */
  pattern: RegExp;
  read: (match: RegExpMatchArray) => Promise<unknown>;
}

export function buildResources(client: PostwaveClient): {
  staticResources: StaticResource[];
  templates: ResourceTemplate[];
} {
  const staticResources: StaticResource[] = [
    {
      uri: "moosewave://voice-profile",
      name: "Voice profile",
      description: "Current tenant's voice fingerprint JSON (~3KB).",
      mimeType: "application/json",
      read: async () => client.voiceProfile.get(),
    },
    {
      uri: "moosewave://recent-migrations",
      name: "Recent migrations",
      description: "The last 10 migration jobs for this tenant.",
      mimeType: "application/json",
      read: async () => client.migrations.listSources(),
    },
    {
      uri: "moosewave://recent-campaigns",
      name: "Recent campaigns",
      description: "The last 10 campaigns with placement summary.",
      mimeType: "application/json",
      read: async () =>
        (
          client as unknown as {
            request: <T>(m: string, p: string, opts?: unknown) => Promise<T>;
          }
        ).request("GET", "/api/v1/campaigns", {
          query: { per_page: 10 },
        } as never),
    },
    {
      uri: "moosewave://templates",
      name: "Sequence templates",
      description: "The 50-template library used by sequence_generate.",
      mimeType: "application/json",
      read: async () => client.templates.list(),
    },
    {
      uri: "moosewave://campaign-templates",
      name: "Visual campaign templates",
      description:
        "Compact page 1 (up to 100 rows) of the visual newsletter design library, not the entire catalog. Follow next_page_resource_uri for every additional page, or use campaign_template_search; fetch an item resource only after selection.",
      mimeType: "application/json",
      read: async () =>
        readCampaignTemplateCatalogPage(
          client,
          1,
          "moosewave://campaign-templates",
        ),
    },
    {
      uri: "moosewave://sequences",
      name: "Active sequences",
      description: "Active sequences for the current tenant.",
      mimeType: "application/json",
      read: async () => client.sequences.list(),
    },
  ];

  const templates: ResourceTemplate[] = [
    {
      uriTemplate: "moosewave://campaign-assurance/{campaign_id}",
      name: "Campaign Assurance receipt",
      description:
        "Latest applicable Campaign Assurance receipt for a campaign, with explicit deterministic, modeled, and controlled-observation provenance.",
      mimeType: "application/json",
      pattern: /^moosewave:\/\/campaign-assurance\/([^/?#]+)$/,
      read: async (match) => {
        const campaignId = safeResourceId(match[1] ?? "");
        if (!campaignId) throw new Error("missing campaign_id");
        return client.campaignAssurance.getLatest(campaignId);
      },
    },
    {
      uriTemplate: "moosewave://inbox-reality/{campaign_id}",
      name: "Inbox Reality report",
      description: "Full Inbox Reality report for a specific campaign.",
      mimeType: "application/json",
      pattern: /^moosewave:\/\/inbox-reality\/([^/?#]+)$/,
      read: async (match) => {
        const campaignId = safeResourceId(match[1] ?? "");
        if (!campaignId) throw new Error("missing campaign_id");
        return client.inboxReality.getCampaignReport(campaignId);
      },
    },
    {
      uriTemplate: "moosewave://campaign-templates/pages/{page}",
      name: "Visual campaign template catalog page",
      description:
        "One compact 100-row page of the visual newsletter catalog. Start with moosewave://campaign-templates, then follow next_page_resource_uri until has_more is false.",
      mimeType: "application/json",
      pattern: /^moosewave:\/\/campaign-templates\/pages\/([^/?#]+)$/,
      read: async (match) => {
        const page = safeCatalogPage(match[1] ?? "");
        if (!page) throw new Error("invalid campaign-template catalog page");
        return readCampaignTemplateCatalogPage(
          client,
          page,
          campaignTemplatePageUri(page),
        );
      },
    },
    {
      uriTemplate: "moosewave://campaign-templates/{template_id}",
      name: "Visual campaign template",
      description:
        "One visual campaign template with design metadata, provenance, variables, and editable MJML/HTML when available.",
      mimeType: "application/json",
      pattern: /^moosewave:\/\/campaign-templates\/([^/?#]+)$/,
      read: async (match) => {
        const templateId = safeResourceId(match[1] ?? "");
        if (!templateId) throw new Error("missing template_id");
        return client.campaignTemplates.get(templateId);
      },
    },
    eventsStreamTemplate(client),
  ];

  return { staticResources, templates };
}

export function registerResources(
  server: Server,
  client: PostwaveClient,
): void {
  const { staticResources, templates } = buildResources(client);

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: staticResources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: templates.map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const stat = staticResources.find((r) => r.uri === uri);
    if (stat) {
      const value = await stat.read();
      const capped = capResponse(value);
      const text =
        typeof capped.data === "string"
          ? capped.data
          : JSON.stringify(capped.data, null, 2);
      return {
        contents: [
          {
            uri,
            mimeType: stat.mimeType,
            text,
          },
        ],
      };
    }
    for (const t of templates) {
      const m = uri.match(t.pattern);
      if (m) {
        const value = await t.read(m);
        const capped = capResponse(value);
        const text =
          typeof capped.data === "string"
            ? capped.data
            : JSON.stringify(capped.data, null, 2);
        return {
          contents: [{ uri, mimeType: t.mimeType, text }],
        };
      }
    }
    throw new Error(`unknown resource: ${uri}`);
  });
}

async function readCampaignTemplateCatalogPage(
  client: PostwaveClient,
  requestedPage: number,
  requestedUri: string,
): Promise<Record<string, unknown>> {
  const compact = compactCampaignTemplateSearch(
    await client.campaignTemplates.search({
      page: requestedPage,
      per_page: CAMPAIGN_TEMPLATE_PAGE_SIZE,
    }),
  );
  const page = compact.page ?? requestedPage;
  const nextPage = compact.next_page;
  return {
    ...compact,
    page,
    per_page: compact.per_page ?? CAMPAIGN_TEMPLATE_PAGE_SIZE,
    page_resource_uri: requestedUri,
    ...(page > 1
      ? { previous_page_resource_uri: campaignTemplatePageUri(page - 1) }
      : {}),
    ...(nextPage !== undefined
      ? { next_page_resource_uri: campaignTemplatePageUri(nextPage) }
      : {}),
  };
}

function campaignTemplatePageUri(page: number): string {
  return page === 1
    ? "moosewave://campaign-templates"
    : `moosewave://campaign-templates/pages/${page}`;
}

function safeCatalogPage(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const page = Number(raw);
  return Number.isSafeInteger(page) ? page : null;
}

export function safeResourceId(raw: string): string | null {
  if (!raw || raw.length > 512 || /[\u0000-\u001f\u007f\\]/.test(raw)) {
    return null;
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    decoded !== decoded.trim() ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    !RESOURCE_ID_RE.test(decoded)
  ) {
    return null;
  }
  return decoded;
}
