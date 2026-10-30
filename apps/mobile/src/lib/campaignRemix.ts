/**
 * lib/campaignRemix.ts — cross-channel derivatives of the campaign body.
 *
 * POST /api/v1/campaigns/{id}/remix (apps/api/internal/content_remix/
 * content_remix.go:57, write:campaigns → editor) derives web-teaser / SMS /
 * social / podcast assets from the body, synchronously and template-driven
 * server-side. The response is {campaign_id, assets: [{channel, title, body,
 * source, created_at}], generated_at}; the phone renders exactly what came
 * back with copy-per-channel — sharing is the one job a phone does best.
 */

/** Mirrors normalizeChannels() defaults in content_remix.go. */
export const REMIX_CHANNELS: readonly { id: string; label: string }[] = [
  { id: "web_teaser", label: "Web teaser" },
  { id: "sms", label: "SMS" },
  { id: "social", label: "Social" },
  { id: "podcast_outline", label: "Podcast outline" },
];

export function remixChannelLabel(id: string): string {
  return REMIX_CHANNELS.find((c) => c.id === id)?.label ?? id;
}

export interface RemixAssetRow {
  key: string;
  channel: string;
  label: string;
  title: string;
  body: string;
}

export function readRemixAssets(data: unknown): RemixAssetRow[] {
  if (!data || typeof data !== "object") return [];
  const assets = (data as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return [];
  const out: RemixAssetRow[] = [];
  for (const [index, item] of assets.entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const body = typeof row.body === "string" ? row.body.trim() : "";
    if (!body) continue;
    const channel = typeof row.channel === "string" ? row.channel : "";
    out.push({
      key: `${index}:${channel}`,
      channel,
      label: remixChannelLabel(channel),
      title: typeof row.title === "string" ? row.title : "",
      body,
    });
  }
  return out;
}
