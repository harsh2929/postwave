/**
 * lib/campaignPreviewAs.ts — reading the two endpoints that tell an operator
 * what ONE recipient will actually receive.
 *
 *   GET  /api/v1/campaigns/{id}/regions     — which conditional regions exist
 *   POST /api/v1/campaigns/{id}/preview-as  — the body resolved for a person
 *
 * WHY BOTH. The mobile preview is `htmlToText(body_html)`, which strips the
 * conditional markup and flattens EVERY branch into one blob. That is not a
 * lossy preview, it is a misleading one: the operator reads three mutually
 * exclusive paragraphs as if a recipient would see all three. Listing the
 * regions says "this body has branches, here they are"; preview-as resolves
 * them for a real subscriber. Neither alone answers the question.
 *
 * Import-free apart from lib/campaignBody (itself import-free), so the parsing
 * and the failure classification stay testable in the node vitest environment.
 */
import { htmlToText } from "@/lib/campaignBody";

/** One conditional block, as parsed by the gateway (campaigns/compose.go). */
export interface CampaignRegion {
  key?: string;
  true_branch?: string;
  false_branch?: string;
  has_else?: boolean;
  children?: CampaignRegion[];
}

export interface CampaignRegionsResponse {
  campaign_id?: string;
  /** "body_html" or "plain_text" — which field the regions were parsed from. */
  source?: string;
  regions?: CampaignRegion[];
}

/** A flattened region, ready to render as one row. */
export interface CampaignRegionRow {
  /** Stable across renders: the key plus its path position. */
  id: string;
  key: string;
  /** Nesting level; 0 is top-level. */
  depth: number;
  /** True when the region has an explicit {{else}} branch. */
  hasElse: boolean;
  /** First line of the true branch, as plain text. Empty when there is none. */
  sample: string;
}

/** How much of a branch is scanned for the one-line sample. */
const SAMPLE_SCAN_LIMIT = 400;
const SAMPLE_MAX_CHARS = 90;

function branchSample(branch: string | undefined): string {
  const raw = (branch ?? "").trim();
  if (!raw) return "";
  const text = htmlToText(raw, SAMPLE_SCAN_LIMIT).split("\n")[0]?.trim() ?? "";
  return text.length > SAMPLE_MAX_CHARS
    ? `${text.slice(0, SAMPLE_MAX_CHARS)}…`
    : text;
}

/**
 * Depth-first flatten, preserving document order.
 *
 * Nesting is real in these bodies (the parser surfaces `children`), and a flat
 * list that loses it would show a region conditional on another region as if
 * it were independent — which is exactly the confusion this surface exists to
 * remove. Bounded by `maxRows` so a generated body with hundreds of regions
 * cannot turn a sheet into an unbounded list.
 */
export function campaignRegionRows(
  response: CampaignRegionsResponse | null | undefined,
  maxRows = 40,
): CampaignRegionRow[] {
  const out: CampaignRegionRow[] = [];
  const walk = (
    regions: CampaignRegion[] | undefined,
    depth: number,
    path: string,
  ): void => {
    for (const [index, region] of (regions ?? []).entries()) {
      if (out.length >= maxRows) return;
      const key = (region?.key ?? "").trim();
      if (!key) continue;
      const id = `${path}${index}:${key}`;
      out.push({
        id,
        key,
        depth,
        hasElse: region.has_else === true,
        sample: branchSample(region.true_branch),
      });
      walk(region.children, depth + 1, `${id}/`);
    }
  };
  walk(response?.regions, 0, "");
  return out;
}

/**
 * The caption under the region list. States what the plain-text preview is
 * doing wrong, in the one place the operator can see the regions it merged.
 */
export function campaignRegionsSummary(
  rows: readonly CampaignRegionRow[],
): string {
  if (rows.length === 0) {
    return "This campaign has no conditional regions — every recipient receives the same body.";
  }
  const noun = rows.length === 1 ? "region" : "regions";
  return `${rows.length} conditional ${noun}. The plain-text preview merges every branch at once; preview as a subscriber below to resolve them.`;
}

export interface CampaignPreviewAsResponse {
  subscriber_email?: string;
  body_html?: string;
  /** Region keys that fell back to the default branch. */
  unresolved_regions?: string[];
}

/**
 * The rendered preview: the resolved body as plain text plus the honesty note.
 *
 * `unresolved_regions` is the field that stops this being a lie. The gateway
 * resolves what it can from the subscriber's own fields and falls back to the
 * default branch for anything it cannot evaluate (segment membership, for
 * instance) — so a preview with unresolved regions is an APPROXIMATION, and
 * the operator has to be told which parts.
 */
export function campaignPreviewAsReading(
  response: CampaignPreviewAsResponse | null | undefined,
): { email: string; text: string; caveat: string | null } {
  const email = (response?.subscriber_email ?? "").trim();
  const text = htmlToText(response?.body_html ?? "");
  const unresolved = (Array.isArray(response?.unresolved_regions) ? response?.unresolved_regions : []).filter(
    (key): key is string => typeof key === "string" && key.trim().length > 0,
  );
  if (unresolved.length === 0) {
    return { email, text, caveat: null };
  }
  const noun = unresolved.length === 1 ? "region" : "regions";
  return {
    email,
    text,
    caveat: `${unresolved.length} ${noun} couldn't be resolved from this subscriber's fields and fell back to the default branch: ${unresolved.join(", ")}. What they actually receive may differ.`,
  };
}

/**
 * Failure copy. The two 404s mean different things and must not collapse: one
 * says the campaign is gone, the other says the address you typed isn't in
 * this workspace — and only the second is worth retyping.
 */
export function campaignPreviewAsProblem(
  status: number,
  code: string | undefined,
  message: string,
): string {
  if (code === "subscriber_not_found") {
    return "No subscriber in this workspace has that address. Check the spelling, or pick someone from the subscribers list.";
  }
  if (code === "not_found" || (status === 404 && !code)) {
    return "This campaign no longer exists.";
  }
  if (code === "missing_subscriber" || status === 400) {
    return "Enter the email address of a subscriber to preview as.";
  }
  if (status === 403) {
    return "You don't have permission to preview this campaign.";
  }
  if (status === 405 || status === 501) {
    return "Preview-as-subscriber isn't available on this workspace yet.";
  }
  const trimmed = message.trim();
  return trimmed
    ? `Couldn't render the preview: ${trimmed}`
    : "Couldn't render the preview.";
}
