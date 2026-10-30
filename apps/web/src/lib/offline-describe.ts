// SPDX-License-Identifier: AGPL-3.0-only
//
// Human-readable label for a queued offline mutation (SETA-022). The offline
// queue only stores `METHOD /path`; this maps that to an operator-legible
// action like "Update subscriber" so a user knows what a queued change does
// before retrying or discarding it. Pure + dependency-free for node tests.

const VERB_LABEL: Record<string, string> = {
  POST: "Create",
  PUT: "Update",
  PATCH: "Update",
  DELETE: "Delete",
};

// Singular nouns for the API resource segment (`/api/v1/<resource>/…`).
const RESOURCE_NOUN: Record<string, string> = {
  subscribers: "subscriber",
  segments: "segment",
  forms: "form",
  campaigns: "campaign",
  topics: "topic",
  templates: "template",
  sequences: "sequence",
  flows: "flow",
  webhooks: "webhook",
};

interface DescribeInput {
  method: string;
  path: string;
}

/**
 * Turn `PATCH /api/v1/subscribers/abc123` into `Update subscriber (abc123)`.
 * Falls back gracefully for unknown resources or malformed paths.
 */
export function describeOfflineMutation({ method, path }: DescribeInput): string {
  const verb = VERB_LABEL[method.toUpperCase()] ?? method.toUpperCase();
  const clean = path.split("?")[0] ?? path;
  const match = clean.match(/\/api\/v1\/([a-z][a-z0-9-]*)(?:\/([^/]+))?/i);
  if (!match) return `${verb} request`;
  const resourceSegment = match[1].toLowerCase();
  const noun = RESOURCE_NOUN[resourceSegment] ?? resourceSegment.replace(/-/g, " ");
  const id = match[2];
  const idHint = id ? ` (${id.length > 8 ? `${id.slice(0, 8)}…` : id})` : "";
  return `${verb} ${noun}${idHint}`;
}
