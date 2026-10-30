/**
 * lib/campaignUtm.ts — reading the link tagging that will be applied to a
 * campaign's links, before it sends.
 *
 * THE FINDING THIS CORRECTS ITSELF. The gap was filed as "no UTM template
 * APPLICATION on mobile — applying a saved template across the body's links is
 * a one-tap action". The API does not work that way, and building what the
 * finding describes would have produced a control that does nothing:
 *
 *   GET  /api/v1/utm-templates                 read:reports
 *        → { templates: Template[], count }    — the DEFAULT (campaign_id "")
 *          plus every per-campaign OVERRIDE, all in one list.
 *   POST /api/v1/utm-templates/campaign/{id}   ADMIN
 *        body { utm_source, utm_medium, utm_campaign, utm_term, utm_content }
 *        — an UPSERT of the five values, NOT a template id. There is no
 *          "apply template X to campaign Y" verb anywhere in
 *          apps/api/internal/utm_tagging/utm_tagging.go.
 *   POST /api/v1/utm-templates/preview         read:reports
 *        body { url, campaign_id } → { original, rewritten, template }
 *
 * So what a phone can honestly offer is the LAST CHECK BEFORE SEND: show which
 * tagging actually resolves for this campaign (its own override if it has one,
 * otherwise the workspace default), let anyone preview a real link through it,
 * and let an ADMIN copy the workspace default down onto this campaign as its
 * override — which is the closest true thing to "apply the saved template".
 *
 * Pure and import-free: node-testable.
 */

export interface UtmTemplate {
  id: string;
  /** Empty string on the default row — the Go projection COALESCEs to "". */
  campaignId: string;
  isDefault: boolean;
  source: string;
  medium: string;
  campaign: string;
  term: string;
  content: string;
  enabled: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `{ templates: [...] }` → mobile rows. */
export function parseUtmTemplates(raw: unknown): UtmTemplate[] {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { templates?: unknown }).templates)
      ? ((raw as { templates: unknown[] }).templates ?? [])
      : Array.isArray(raw)
        ? raw
        : [];
  const out: UtmTemplate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id).trim();
    if (!id) continue;
    const campaignId = str(row.campaign_id).trim();
    out.push({
      id,
      campaignId,
      // Recomputed rather than trusted: `is_default` is derived server-side
      // from the same empty campaign_id, and a disagreement between the two
      // would silently pick the wrong row as "the default".
      isDefault: campaignId === "",
      source: str(row.utm_source),
      medium: str(row.utm_medium),
      campaign: str(row.utm_campaign),
      term: str(row.utm_term),
      content: str(row.utm_content),
      enabled: row.enabled === true,
    });
  }
  return out;
}

export interface UtmResolution {
  /** The row that will actually tag this campaign's links, or null. */
  effective: UtmTemplate | null;
  /** The workspace default, whether or not it is the effective one. */
  fallback: UtmTemplate | null;
  /** True when the campaign carries its own override row. */
  overridden: boolean;
  /** One sentence stating what will happen to this campaign's links. */
  summary: string;
}

/**
 * Which template wins for one campaign.
 *
 * Mirrors `Resolve` in utm_tagging.go: a campaign-scoped row takes precedence
 * over the tenant default. `enabled=false` is treated as NO TAGGING, because
 * that is what the server's Apply does — showing the values of a disabled row
 * as "what will be added" is the exact false-confidence this card exists to
 * remove.
 */
export function resolveCampaignUtm(
  templates: readonly UtmTemplate[],
  campaignId: string,
): UtmResolution {
  const fallback = templates.find((t) => t.isDefault) ?? null;
  const override = templates.find((t) => t.campaignId === campaignId) ?? null;
  const effective = override ?? fallback;
  if (!effective || !effective.enabled) {
    return {
      effective: null,
      fallback,
      overridden: override !== null,
      summary:
        override && !override.enabled
          ? "Link tagging is switched OFF for this campaign, so its links go out exactly as written."
          : fallback && !fallback.enabled
            ? "This workspace's link tagging is switched off, so links go out exactly as written."
            : "No UTM tagging is configured, so this campaign's links go out exactly as written.",
    };
  }
  return {
    effective,
    fallback,
    overridden: override !== null,
    summary: override
      ? "This campaign has its own tagging, which overrides the workspace default."
      : "This campaign uses the workspace default tagging.",
  };
}

export interface UtmParamRow {
  key: string;
  label: string;
  value: string;
}

/**
 * The five parameters as display rows. An unset one is kept with an em-dash
 * rather than hidden: "utm_term is not set" is information, and a card that
 * silently drops three of five rows reads as if only two exist.
 */
export function utmParamRows(template: UtmTemplate | null): UtmParamRow[] {
  const pick = (value: string) => (value.trim() === "" ? "—" : value);
  return [
    { key: "source", label: "utm_source", value: pick(template?.source ?? "") },
    { key: "medium", label: "utm_medium", value: pick(template?.medium ?? "") },
    {
      key: "campaign",
      label: "utm_campaign",
      value: pick(template?.campaign ?? ""),
    },
    { key: "term", label: "utm_term", value: pick(template?.term ?? "") },
    {
      key: "content",
      label: "utm_content",
      value: pick(template?.content ?? ""),
    },
  ];
}

/** The upsert body that copies the workspace default onto one campaign. */
export function utmOverrideBody(fallback: UtmTemplate): {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
} {
  return {
    utm_source: fallback.source,
    utm_medium: fallback.medium,
    utm_campaign: fallback.campaign,
    utm_term: fallback.term,
    utm_content: fallback.content,
  };
}

/**
 * Client-side mirror of `validatePreviewURL` (utm_tagging.go:323) so the
 * preview field explains itself instead of round-tripping to a 422.
 */
export function utmPreviewProblem(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;
  if (url.length > 2048) return "That URL is too long to preview.";
  if (!/^https?:\/\//i.test(url)) {
    return "Enter a full link starting with http:// or https://.";
  }
  const rest = url.replace(/^https?:\/\//i, "");
  const host = rest.split(/[/?#]/)[0] ?? "";
  if (host === "") return "That link has no domain.";
  return null;
}
