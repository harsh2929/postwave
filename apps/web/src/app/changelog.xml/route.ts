// SPDX-License-Identifier: AGPL-3.0-only
import { publicSiteOrigin } from "@/lib/site-url";
import {
  AGENT_INTERACTIVE_RELEASE_HOLD_CODE,
  MCP_RELEASE_HOLD_CODE,
} from "@/lib/mcp-release-status";

export const runtime = "nodejs";

const SITE_URL = publicSiteOrigin();

type Entry = {
  id: string;
  title: string;
  /** ISO 8601 date — Atom requires a fully-qualified timestamp. */
  updated: string;
  summary: string;
};

const ENTRIES: Entry[] = [
  {
    id: "v0.4.0",
    title: "v0.4.0 — historical source milestone",
    updated: "2026-06-20T00:00:00Z",
    summary:
      `Source snapshot added marketing pages and recorded 22 native agent definitions; it was not an installed/deployed runtime claim. Current holds: ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE}, ${MCP_RELEASE_HOLD_CODE}.`,
  },
  {
    id: "v0.3.1",
    title: "v0.3.1 — agent source implementation milestone",
    updated: "2026-06-19T00:00:00Z",
    summary:
      `Candidate session, token/cost, scope-filter, and tracing code landed in source; it did not establish a supported runtime. Current hold: ${AGENT_INTERACTIVE_RELEASE_HOLD_CODE}.`,
  },
  {
    id: "v0.3.0",
    title: "v0.3.0 — growth channels",
    updated: "2026-06-16T00:00:00Z",
    summary:
      "Paid-audience sync, multi-provider commerce, conversion attribution, SMS sending, sender registration, and mobile push ship as first-class channels.",
  },
  {
    id: "v0.2.1",
    title: "v0.2.1 — Gemini model migration",
    updated: "2026-05-11T00:00:00Z",
    summary:
      "AI Diagnostician and Voice AI move to Google Gemini behind the existing interfaces, prompts, and evaluation cases.",
  },
  {
    id: "v0.0.4",
    title: "v0.0.4 — launch readiness",
    updated: "2026-04-30T00:00:00Z",
    summary:
      "Documentation, public APIs, comparison content, legal drafts, billing plumbing, and infrastructure reach external-review readiness.",
  },
];

const FEED_UPDATED = ENTRIES[0]?.updated ?? new Date().toISOString();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderFeed(): string {
  const entryXml = ENTRIES.map((e) => {
    const url = `${SITE_URL}/changelog#${encodeURIComponent(e.id)}`;
    return `  <entry>
    <id>${escapeXml(`tag:moosewave.com,2026:changelog/${e.id}`)}</id>
    <title>${escapeXml(e.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(url)}" />
    <updated>${e.updated}</updated>
    <summary type="text">${escapeXml(e.summary)}</summary>
  </entry>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(`${SITE_URL}/changelog`)}</id>
  <title>Moosewave Changelog</title>
  <subtitle>Dated source milestones, artifact notes, and current release holds.</subtitle>
  <link rel="alternate" type="text/html" href="${escapeXml(`${SITE_URL}/changelog`)}" />
  <link rel="self" type="application/atom+xml" href="${escapeXml(`${SITE_URL}/changelog.xml`)}" />
  <updated>${FEED_UPDATED}</updated>
  <author>
    <name>Moosewave</name>
    <email>hello@moosewave.com</email>
  </author>
${entryXml}
</feed>
`;
}

export function GET(): Response {
  return new Response(renderFeed(), {
    status: 200,
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
    },
  });
}
