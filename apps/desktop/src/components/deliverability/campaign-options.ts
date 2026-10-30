/**
 * campaign-options — pure normalization for the campaign pickers used
 * by the ISP-breakdown, placement-report, and diagnostician cards.
 *
 * The canonical campaigns handler returns a top-level array. Older gateway
 * adapters used `items | results | data` envelopes, so this boundary accepts
 * those documented compatibility shapes as well and rejects everything else.
 */

import type { Campaign, CampaignsResponse } from "../../lib/api-client";

export interface CampaignOption {
  /** Stringified id — campaign ids are number|string on the wire. */
  id: string;
  label: string;
}

const MAX_CAMPAIGNS = 10_000;
const MAX_TEXT = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.length <= MAX_TEXT)
  );
}

function parseCampaigns(
  value: unknown,
  requireEnvelope = false,
): Campaign[] | null {
  if (Array.isArray(value)) return parseCampaignArray(value);
  if (!isRecord(value)) return null;
  const candidate =
    "items" in value
      ? value.items
      : "results" in value
        ? value.results
        : "data" in value
          ? value.data
          : requireEnvelope
            ? null
            : [];
  if (!Array.isArray(candidate)) return null;
  return parseCampaignArray(candidate);
}

function parseCampaignArray(candidate: unknown[]): Campaign[] | null {
  if (candidate.length > MAX_CAMPAIGNS) return null;
  if (
    !candidate.every(
      (campaign) =>
        isRecord(campaign) &&
        (campaign.id === undefined ||
          (typeof campaign.id === "string" &&
            campaign.id.length > 0 &&
            campaign.id.length <= 128) ||
          (typeof campaign.id === "number" &&
            Number.isSafeInteger(campaign.id) &&
            campaign.id >= 0)) &&
        isOptionalText(campaign.name) &&
        isOptionalText(campaign.subject) &&
        isOptionalText(campaign.status),
    )
  ) {
    return null;
  }
  return candidate as Campaign[];
}

/** Extracts the campaign array from whichever envelope key is set. */
export function campaignsFromResponse(
  data: CampaignsResponse | null | undefined,
): Campaign[] {
  return parseCampaigns(data) ?? [];
}

/**
 * Builds picker options. Campaigns without an id can't be queried by
 * the per-campaign endpoints and are dropped. Label preference:
 * name → subject → "Campaign {id}"; the status is appended so an
 * operator can tell drafts from sent campaigns inside the select.
 */
export function toCampaignOptions(
  data: CampaignsResponse | null | undefined,
): CampaignOption[] {
  const out: CampaignOption[] = [];
  for (const c of campaignsFromResponse(data)) {
    if (c.id == null || String(c.id).length === 0) continue;
    const base =
      (c.name && c.name.trim()) ||
      (c.subject && c.subject.trim()) ||
      `Campaign ${String(c.id)}`;
    const label = c.status ? `${base} · ${c.status}` : base;
    out.push({ id: String(c.id), label });
  }
  return out;
}

/** Strict picker boundary: malformed successful envelopes are errors, not empty. */
export function parseCampaignOptions(value: unknown): CampaignOption[] | null {
  const campaigns = parseCampaigns(value, true);
  if (!campaigns) return null;
  return toCampaignOptions({ items: campaigns });
}
