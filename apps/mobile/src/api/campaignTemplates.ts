/**
 * api/campaignTemplates.ts — transport for the campaign-template library.
 *
 * Every route below was read off the chi mount in
 * `apps/api/internal/server/campaign_sending.go::MountCampaignTemplateRoutes`
 * (lines 34-51), cross-checked against the handlers themselves, not against
 * openapi.json:
 *
 *   GET  /api/v1/campaign-templates/search   viewer  → SearchResponse
 *   GET  /api/v1/campaign-templates/goals    viewer  → []{goal,count}
 *   GET  /api/v1/campaign-templates/{id}     viewer  → Template
 *   POST /api/v1/campaign-templates/{id}/clone            editor → Template (201)
 *   POST /api/v1/campaign-templates/{id}/create-campaign  editor → Campaign (201)
 *
 * THE ROLE SPLIT IS THE REASON THE SCREEN IS SHAPED THE WAY IT IS, AND IT WAS
 * READ OFF THE MIDDLEWARE, NOT THE MANIFEST. Every route above is mounted
 * behind `apikeys.RequireScope`, which on the SESSION path (what this app uses)
 * resolves the role from the scope: `read:campaigns` is in `readOnlyScopes`
 * (middleware.go:332) so every authenticated dashboard user passes, while
 * `write:campaigns` is not — it goes through `requireAdminRoleForScopes` →
 * `sessionRoleAllowsScopes`, which admits owner, admin, and (via
 * `editorWriteScopes`, middleware.go:291) editor. So reading is viewer-and-up
 * and both verbs are editor-and-up. A viewer can browse the whole library and
 * would otherwise discover the boundary only as a 403 after a confirm — which
 * is why the screen gates on role rather than on the round trip.
 *
 * (`storedGrantsCoverScopes` can additionally admit a CUSTOM role granted
 * write:campaigns in roles_permissions. That is additive and unknowable from
 * the phone, so the screen's gate is the conservative one: it can under-offer
 * for a custom role, never over-offer.)
 *
 * WHY /search AND NOT THE LEGACY LIST. `GET /campaign-templates` still exists
 * but answers a bare array capped at 50 with paging expressed only in `X-Page`
 * response headers, and it advertises its own replacement
 * (`Link: </api/v1/campaign-templates/search>; rel="successor-version"`,
 * campaigntemplates.go:1162). `/search` is the one that carries `total`,
 * `next_cursor` and server-side matching across name, subject, description,
 * source brand and tags — none of which a client-side filter over one page can
 * do for a workspace with a real library.
 *
 * NOT HERE, ON PURPOSE: POST /campaign-templates, PATCH /{id}, DELETE /{id},
 * /import, /generate, /adapt, /from-generated-design. Authoring rich email is
 * not a phone job; see the header of app/(tabs)/templates.tsx.
 *
 * Parsing lives in lib/templateCatalog so it is unit-testable in the node
 * vitest environment; this module is only URLs and envelopes.
 */
import {
  parseGoalCounts,
  parseTemplate,
  parseTemplateCatalogPage,
  type MobileTemplate,
  type TemplateCatalogPage,
  type TemplateGoalCount,
} from "@/lib/templateCatalog";

import { checkedApiResult, rawRequest } from "./request";

/**
 * `defaultCatalogPageSize` server-side (catalog.go:23). Sent explicitly so a
 * change to the server default cannot silently resize the phone's pages.
 */
export const TEMPLATE_PAGE_SIZE = 24;

const BASE = "/api/v1/campaign-templates";

export interface TemplateCatalogQuery {
  /** Free text — matched server-side against name/subject/description/brand/tags. */
  query?: string;
  /** A canonical goal, or null for "no filter". Anything else 400s. */
  goal?: string | null;
  /** platform | mine | team, or null for no ownership filter (catalog.go). */
  source?: string | null;
  /** `favorited=1` — the per-user favourites join. */
  favorited?: boolean;
  /**
   * ALWAYS sent (lib/templateDiscovery.shelfQuery): the server's empty
   * default mixes archived rows into the browse shelf
   * (campaigntemplates.go:684 returns "" → no lifecycle WHERE at all).
   */
  archived?: "active" | "archived";
  /** name | most_used; null for the server's recommended default. */
  sort?: string | null;
  page?: number;
}

export function templateSearchPath(input: TemplateCatalogQuery): string {
  const params = new URLSearchParams();
  const query = (input.query ?? "").trim();
  // `listsearch.ReadQuery` reads `query` first and falls back to `q`; sending
  // the canonical name keeps mobile aligned with desktop's requests.
  if (query) params.set("query", query);
  if (input.goal) params.set("goal", input.goal);
  if (input.source) params.set("source", input.source);
  if (input.favorited) params.set("favorited", "1");
  if (input.archived) params.set("archived", input.archived);
  if (input.sort) params.set("sort", input.sort);
  params.set("page", String(Math.max(1, Math.trunc(input.page ?? 1))));
  params.set("per_page", String(TEMPLATE_PAGE_SIZE));
  return `${BASE}/search?${params.toString()}`;
}

export function templatePath(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export async function fetchTemplateCatalog(
  input: TemplateCatalogQuery,
): Promise<TemplateCatalogPage> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", templateSearchPath(input)),
  );
  return parseTemplateCatalogPage(res.data);
}

export async function fetchTemplateGoals(): Promise<TemplateGoalCount[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", `${BASE}/goals`),
  );
  return parseGoalCounts(res.data);
}

/**
 * The single-template read — the only one that carries `body_html` /
 * `body_mjml`. The catalogue projection replaces both with `''`
 * (catalog.go:182), so "does this design actually contain an email" is a
 * question only this call can answer.
 */
export async function fetchTemplate(
  id: string,
): Promise<MobileTemplate | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", templatePath(id)),
  );
  // "detail" is what makes `bodyLoaded` true. This is one of only two responses
  // whose body fields carry a real answer — the catalogue selects them as ''.
  return parseTemplate(res.data, "detail");
}

/**
 * Duplicate a template into a tenant-owned copy.
 *
 * Sent as a BARE POST with no body. `Deps.Clone` decodes with
 * `AllowEmptyBody`, and an omitted slug is derived as
 * `<source>-copy-<8 hex>` — the only variant that cannot collide with an
 * existing row and trip the 409 `slug_conflict` this endpoint returns. The name
 * the server derives is previewed locally by `cloneNameSuggestion`.
 */
export async function cloneTemplate(
  id: string,
): Promise<MobileTemplate | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", `${templatePath(id)}/clone`),
  );
  // Also body-bearing: Repo.Clone reads the source through Get (full row) and
  // hands it to Create, whose INSERT carries body_html/body_mjml through.
  return parseTemplate(res.data, "detail");
}

/**
 * The reversible lifecycle pair (desktop parity: TemplateDetailSlideover):
 *
 *   PATCH /api/v1/campaign-templates/{id}/archive   editor
 *   PATCH /api/v1/campaign-templates/{id}/restore   editor
 *
 * Both demand a STRONG `If-Match` entity tag — requireTemplateIfMatch
 * (lifecycle.go:68) 428s on a missing header and 412s on `W/`-prefixed,
 * `*`, or unquoted values. The tag comes off the single-template read's
 * BODY (`Template.ETag`, campaigntemplates.go:97), which the detail sheet
 * has always fetched; the caller fails closed here rather than sending a
 * header the server will refuse.
 *
 * This is NOT the deliberately-absent DELETE: archive is a one-tap
 * reversible act (`archived_at` timestamp; restore clears it), which is why
 * it belongs on a phone while destroying a design does not.
 */
async function setTemplateArchived(
  id: string,
  etag: string,
  verb: "archive" | "restore",
): Promise<MobileTemplate | null> {
  if (!etag.startsWith('"') || !etag.endsWith('"') || etag.length < 2) {
    throw new Error(
      "Reload this template to get its current version before changing it.",
    );
  }
  const res = await checkedApiResult(
    rawRequest<unknown>("PATCH", `${templatePath(id)}/${verb}`, undefined, {
      headers: { "If-Match": etag },
    }),
  );
  return parseTemplate(res.data, "detail");
}

export function archiveTemplate(
  id: string,
  etag: string,
): Promise<MobileTemplate | null> {
  return setTemplateArchived(id, etag, "archive");
}

export function restoreTemplate(
  id: string,
  etag: string,
): Promise<MobileTemplate | null> {
  return setTemplateArchived(id, etag, "restore");
}

/**
 * POST /api/v1/campaign-templates/{id}/favorite   — and its SEPARATE
 * /unfavorite twin. There is no single toggle route: the two verbs are
 * distinct paths (server/campaign_sending.go:50-51), so the caller has to know
 * which direction it is going.
 *
 * MOUNTED WITH `read`, NOT `write` — a VIEWER may favourite a design. But
 * `toggleFavorite` (campaigntemplates/extras.go:519) additionally demands
 * `middleware.UserFromContext` and 401s with `no_user` without it: favourites
 * are per-USER rows in template_favorites, so this route is unusable from an
 * API key and works only on the session path the app uses.
 */
export async function setTemplateFavorite(
  id: string,
  favorited: boolean,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `${templatePath(id)}/${favorited ? "favorite" : "unfavorite"}`,
    ),
  );
}

/** The subset of the created campaign this screen needs to hand off. */
export interface CreatedCampaign {
  id: string;
  name: string;
  status: string;
}

/**
 * Build a draft campaign from a template.
 *
 * The body is `{}` rather than omitted: `CreateCampaignFromTemplate` decodes
 * with the strict `DecodeJSON` (no `AllowEmptyBody`), unlike clone. Nothing
 * else is sent — the template id comes from the path, and `segment_id` /
 * `list_id` are left unset because choosing an audience is a decision this
 * screen has no business making silently. The handler also calls `RecordUse`
 * on success, so the library's "popular" ordering reflects the phone too.
 */
export async function createCampaignFromTemplate(
  id: string,
): Promise<CreatedCampaign | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", `${templatePath(id)}/create-campaign`, {}),
  );
  const row =
    res.data && typeof res.data === "object" && !Array.isArray(res.data)
      ? (res.data as Record<string, unknown>)
      : {};
  const campaignId =
    typeof row["id"] === "string"
      ? row["id"].trim()
      : typeof row["id"] === "number"
        ? String(row["id"])
        : "";
  if (!campaignId) return null;
  return {
    id: campaignId,
    name: typeof row["name"] === "string" ? row["name"] : "",
    status: typeof row["status"] === "string" ? row["status"] : "draft",
  };
}
