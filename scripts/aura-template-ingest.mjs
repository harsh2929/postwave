#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  POSTWAVE_CREATE_PAYLOAD_FIELDS,
  importCatalogBundleToPostwave,
  importCatalogToPostwave,
  stripHtml,
  validateCatalog,
  writeCatalogBundle,
} from "./rge-newsletter-ingest.mjs";

export const AURA_BASE_URL = "https://www.aura.build";
export const AURA_BROWSE_URL = `${AURA_BASE_URL}/browse/components`;
export const AURA_REST_URL = "https://hoirqrkdgbmvpwutwuwj.supabase.co/rest/v1";
export const AURA_SOURCE_PROVIDER = "aura_build";
export const DEFAULT_OUTPUT_PATH =
  "scripts/fixtures/aura-template-catalog.json";
export const DEFAULT_FULL_OUTPUT_PATH =
  "scripts/fixtures/aura-template-catalog-full.json.gz";

const AURA_SUPABASE_PROJECT_REF = "hoirqrkdgbmvpwutwuwj";
const AURA_PRIMARY_PREVIEW_HOST = "hoirqrkdgbmvpwutwuwj.supabase.co";
const AURA_LEGACY_PREVIEW_HOST = "hoirqrkdgbmvpwutwuwj-all.supabase.co";
const AURA_PREVIEW_HOSTS = new Set([
  AURA_PRIMARY_PREVIEW_HOST,
  AURA_LEGACY_PREVIEW_HOST,
]);
const AURA_PREVIEW_PATH_PREFIXES = [
  "/storage/v1/object/public/preview-images/",
  "/storage/v1/object/public/chat-thumbnails/",
];
const AURA_HTML_TABLE = "shared_code";
const AURA_REACT_TABLE = "shared_react_projects";
const AURA_PROFILE_TABLE = "public_author_profiles";
const CATALOG_SCHEMA_VERSION =
  "postwave.campaign-template-reference-catalog.v1";
const EMPTY_CONTENT_HASH = `sha256:${createHash("sha256")
  .update("")
  .digest("hex")}`;
const DEFAULT_USER_AGENT =
  "PostwaveAuraCatalog/1.0 (+https://github.com/postwave/postwave; public-metadata-reference-ingest)";
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_CATALOG_TEMPLATES = 10_000;
const MAX_RESPONSE_BYTES = 12_000_000;
const MAX_SCRIPT_BYTES = 4_000_000;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 25;
const POSTWAVE_SLUG_MAX_LENGTH = 80;
const SOURCE_SELECTS = Object.freeze({
  html: [
    "id",
    "slug",
    "title",
    "description",
    "tags",
    "user_id",
    "username",
    "image_url",
    "views",
    "forks",
    "created_at",
    "updated_at",
    "featured_at",
    "category",
    "featured",
    "premium",
    "private",
    "share_source_code",
    "price",
    "purchase_url",
  ].join(","),
  react: [
    "id",
    "source_project_id",
    "user_id",
    "slug",
    "title",
    "description",
    "template_type",
    "preview_images",
    "image_url",
    "category",
    "tags",
    "private",
    "share_source_code",
    "featured",
    "featured_at",
    "premium",
    "price",
    "purchase_url",
    "view_count",
    "fork_count",
    "published_at",
    "created_at",
    "updated_at",
  ].join(","),
});
const INDUSTRY_TAGS = new Set([
  "automotive",
  "education",
  "entertainment",
  "fashion",
  "finance",
  "financial",
  "food",
  "health",
  "non-profit",
  "real-estate",
  "retail",
  "saas",
  "sports",
  "technology",
  "travel",
]);

function clampInteger(value, { name, minimum, maximum }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function cleanText(value) {
  return stripHtml(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
}

function truncateUtf8(value, maximumBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const selected = [];
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffixBytes > maximumBytes) break;
    selected.push(character);
    bytes += characterBytes;
  }
  return `${selected.join("").trimEnd()}${suffix}`;
}

function normalizeToken(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function asHttpsUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Aura preview URLs are user-controlled database fields. Keep the catalog and
 * preview worker on the same narrow provider-bound allowlist rather than
 * accepting an arbitrary HTTPS thumbnail.
 */
export function allowedAuraPreviewUrl(value) {
  const httpsUrl = asHttpsUrl(value);
  if (!httpsUrl) return null;
  const parsed = new URL(httpsUrl);
  if (!AURA_PREVIEW_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (
    !AURA_PREVIEW_PATH_PREFIXES.some((prefix) =>
      parsed.pathname.startsWith(prefix),
    ) ||
    !/\.(?:png|jpe?g)$/i.test(parsed.pathname)
  ) {
    return null;
  }
  const queryEntries = [...parsed.searchParams.entries()];
  if (
    queryEntries.length > 1 ||
    (queryEntries.length === 1 &&
      (queryEntries[0][0] !== "t" || !/^\d{1,20}$/.test(queryEntries[0][1])))
  ) {
    return null;
  }
  return parsed.href;
}

function publicPurchaseUrl(value) {
  return asHttpsUrl(value);
}

function makeAuraPostwaveSlug(sourceKind, sourceId, sourceSlug) {
  const token = normalizeToken(sourceSlug) || "web-design-reference";
  const digest = createHash("sha256")
    .update(`${sourceKind}:${sourceId}`)
    .digest("hex")
    .slice(0, 10);
  const suffix = `-${digest}`;
  const prefix = `aura-${sourceKind}-`;
  const available = POSTWAVE_SLUG_MAX_LENGTH - prefix.length - suffix.length;
  const shortened = token.slice(0, available).replace(/-+$/g, "");
  return `${prefix}${shortened || "reference"}${suffix}`;
}

function normalizeSourceTags(value) {
  if (!Array.isArray(value)) return [];
  const tags = [];
  const seen = new Set();
  for (const item of value) {
    const name = cleanText(item);
    const slug = normalizeToken(name);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    tags.push({ slug, name: truncateUtf8(name, 100) });
  }
  return tags.slice(0, 30);
}

function accessTier(row) {
  if (
    row?.price !== null &&
    row?.price !== undefined &&
    String(row?.purchase_url ?? "").trim().length > 0
  ) {
    return "creator-paid";
  }
  if (row?.premium === true) return "aura-pro";
  return "free";
}

function creatorFor(row, authorProfiles) {
  const author = authorProfiles?.get(String(row?.user_id ?? ""));
  const username = cleanText(row?.username);
  const usernameIsIdentifier =
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(username) || /^\d+$/.test(username);
  const name =
    cleanText(author?.full_name) ||
    (!usernameIsIdentifier ? username : "") ||
    "Aura creator";
  return {
    id: String(row?.user_id ?? "").trim() || null,
    name: truncateUtf8(name, 200),
    slug: cleanText(author?.slug) || null,
  };
}

function normalizedPreviewImages(row) {
  const previews = {};
  if (row?.preview_images && typeof row.preview_images === "object") {
    for (const key of ["image_320w", "image_800w", "image_1600w"]) {
      const url = allowedAuraPreviewUrl(row.preview_images[key]);
      if (url) previews[key] = url;
    }
  }
  const primary =
    allowedAuraPreviewUrl(row?.image_url) ||
    previews.image_800w ||
    previews.image_1600w ||
    previews.image_320w ||
    "";
  return { primary, variants: previews };
}

function inferStyle(sourceTags) {
  const tags = new Set(sourceTags.map((tag) => tag.slug));
  for (const style of [
    "dark",
    "minimal",
    "colorful",
    "futuristic",
    "editorial",
    "clean",
  ]) {
    if (tags.has(style)) return style;
  }
  return "web-design-reference";
}

function inferIndustry(sourceTags) {
  return sourceTags.find((tag) => INDUSTRY_TAGS.has(tag.slug))?.slug ?? "";
}

function inferLayout(row, sourceTags) {
  const tags = new Set(sourceTags.map((tag) => tag.slug));
  if (tags.has("landing-page")) return "landing-page-reference";
  const category = normalizeToken(row?.category);
  if (category === "mobile") return "mobile-web-reference";
  if (category === "animation") return "animated-web-reference";
  return "web-reference";
}

function makeCatalogTags(sourceKind, tier, row, sourceTags) {
  const tokens = [
    "source-aura",
    "web-design-reference",
    "requires-email-adaptation",
    `aura-${sourceKind}`,
    `access-${tier}`,
    normalizeToken(row?.category),
    ...sourceTags.map((tag) => tag.slug),
  ];
  return [...new Set(tokens.filter(Boolean))].slice(0, 40);
}

function metadataQuality(row, preview, sourceTags) {
  let score = 0.55;
  if (cleanText(row?.description)) score += 0.05;
  if (preview.primary) score += 0.15;
  if (sourceTags.length > 0) score += 0.05;
  if (Number(row?.views ?? row?.view_count) >= 50) score += 0.05;
  if (row?.share_source_code !== false) score += 0.05;
  return Math.min(0.9, Number(score.toFixed(2)));
}

export function normalizeAuraReference(
  sourceKind,
  row,
  { capturedAt = new Date().toISOString(), authorProfiles = new Map() } = {},
) {
  if (!["html", "react"].includes(sourceKind)) {
    throw new Error(`Unsupported Aura source kind: ${sourceKind}`);
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("Aura source row must be an object");
  }
  const sourceId = String(row.id ?? "").trim();
  const sourceSlug = String(row.slug ?? "").trim();
  if (!sourceId) throw new Error("Aura source row is missing id");
  if (!sourceSlug)
    throw new Error(`Aura ${sourceKind}:${sourceId} is missing slug`);
  if (row.featured !== true || row.private === true) {
    throw new Error(
      `Aura ${sourceKind}:${sourceId} is not a public featured template`,
    );
  }

  const title =
    cleanText(row.title) || cleanText(sourceSlug) || "Aura design reference";
  const description = cleanText(row.description);
  const sourceTags = normalizeSourceTags(row.tags);
  const preview = normalizedPreviewImages(row);
  const tier = accessTier(row);
  const creator = creatorFor(row, authorProfiles);
  const canonicalUrl = `${AURA_BASE_URL}/templates/${encodeURIComponent(sourceSlug)}`;
  const sourceExternalId = `${sourceKind}:${sourceId}`;
  const sourceTemplateType =
    sourceKind === "react" ? cleanText(row.template_type) || "react" : "html";
  const views = Math.max(0, Number(row.views ?? row.view_count) || 0);
  const forks = Math.max(0, Number(row.forks ?? row.fork_count) || 0);
  const price = Number(row.price);
  const purchaseUrl = publicPurchaseUrl(row.purchase_url);
  const auraVisibility =
    views >= 50 ? "default-all-grid" : "public-featured-below-grid-threshold";
  const auraPulseEligible = views >= (tier === "creator-paid" ? 1_000 : 50);
  const warnings = [
    "web-layout-requires-email-adaptation",
    "source-html-not-collected",
  ];
  if (tier !== "free") warnings.push("source-access-restricted");
  if (row.share_source_code === false) warnings.push("source-remix-disabled");
  if (!preview.primary) warnings.push("missing-allowlisted-preview");
  const qualityScore = metadataQuality(row, preview, sourceTags);
  const sourceMetadata = {
    source_slug: `${sourceKind}:${sourceSlug}`,
    canonical_slug: sourceSlug,
    collection_url: AURA_BROWSE_URL,
    source_artifact_type: "web_template",
    source_template_type: sourceTemplateType,
    creator,
    access_tier: tier,
    premium: row.premium === true,
    share_source_code: row.share_source_code !== false,
    ...(Number.isFinite(price) && price > 0 ? { price_usd: price } : {}),
    ...(purchaseUrl ? { purchase_url: purchaseUrl } : {}),
    preview_images: preview.variants,
    views,
    forks,
    aura_visibility: auraVisibility,
    aura_pulse_eligible: auraPulseEligible,
    source_created_at: row.created_at ?? null,
    source_updated_at: row.updated_at ?? null,
    source_published_at: row.published_at ?? null,
    source_featured_at: row.featured_at ?? null,
    source_project_id:
      sourceKind === "react" ? (row.source_project_id ?? null) : null,
    source_html_disposition: "not-collected-web-source",
    email_compatibility: "requires-original-email-rebuild",
  };

  return {
    catalog_id: `aura:${sourceExternalId}`,
    slug: makeAuraPostwaveSlug(sourceKind, sourceId, sourceSlug),
    name: truncateUtf8(`${creator.name} — ${title}`, 200),
    description: truncateUtf8(
      description ||
        `Aura web-template reference by ${creator.name}; requires an original email-safe adaptation.`,
      1_000,
    ),
    category: "newsletter",
    goal: "newsletter",
    subject: truncateUtf8(title, 998),
    preview_text: truncateUtf8(description, 300),
    body_html: "",
    body_mjml: "",
    variables: [],
    tags: makeCatalogTags(sourceKind, tier, row, sourceTags),
    template_kind: "reference",
    source_provider: AURA_SOURCE_PROVIDER,
    source_external_id: sourceExternalId,
    source_url: canonicalUrl,
    source_brand: creator.name,
    thumbnail_url: preview.primary,
    source_captured_at: capturedAt,
    source_license_status: "personal-use-unreviewed",
    source_metadata: sourceMetadata,
    industry: inferIndustry(sourceTags),
    style: inferStyle(sourceTags),
    layout: inferLayout(row, sourceTags),
    design_metadata: {
      source_format: preview.primary ? "screenshot" : "metadata",
      source_artifact_type: "web_template",
      source_template_type: sourceTemplateType,
      email_compatibility: "not-email-html",
      source_code_collected: false,
      source_category: cleanText(row.category),
      source_tags: sourceTags,
      access_tier: tier,
      views,
      forks,
      aura_visibility: auraVisibility,
      aura_pulse_eligible: auraPulseEligible,
      classification_method: "aura-public-metadata-v1-pending-review",
      quality_score: qualityScore,
      quality_warnings: warnings,
    },
    review_status: "pending",
    quality_score: qualityScore,
    content_hash: EMPTY_CONTENT_HASH,
    reference_template_ids: [],
    generation_metadata: {},
    adaptation_policy: {
      intended_use: "design_reference",
      requires_original_email_rebuild: true,
      requires_brand_replacement: true,
      requires_content_rewrite: true,
      requires_link_review: true,
      requires_asset_review: true,
      send_ready: false,
    },
    previews: {
      desktop: preview.primary ? { url: preview.primary } : null,
      mobile: null,
      card: preview.primary ? { url: preview.primary } : null,
    },
    provenance: {
      provider: AURA_SOURCE_PROVIDER,
      source_id: sourceExternalId,
      source_slug: `${sourceKind}:${sourceSlug}`,
      source_url: canonicalUrl,
      collection_url: AURA_BROWSE_URL,
      source_artifact_type: "web_template",
      source_template_type: sourceTemplateType,
      creator,
      access_tier: tier,
      captured_at: capturedAt,
      rights_status: "personal-use-unreviewed",
    },
  };
}

function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

async function responseTextBounded(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`Response exceeded ${maximumBytes} bytes`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maximumBytes) {
    throw new Error(`Response exceeded ${maximumBytes} bytes`);
  }
  return buffer.toString("utf8");
}

async function fetchTextWithRetry(
  url,
  {
    fetchImpl = globalThis.fetch,
    headers = {},
    retries = 3,
    timeoutMs = 20_000,
    baseDelayMs = 400,
    maximumBytes = MAX_RESPONSE_BYTES,
    onRetry = () => {},
    sleepImpl = (milliseconds) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          ...headers,
        },
        signal: controller.signal,
      });
      const text = await responseTextBounded(response, maximumBytes);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        error.status = response.status;
        error.retryable = RETRYABLE_STATUS_CODES.has(response.status);
        error.retryAfterMs = retryAfterMilliseconds(
          response.headers.get("retry-after"),
        );
        throw error;
      }
      return { response, text };
    } catch (error) {
      lastError = error;
      const retryable =
        timedOut ||
        error?.retryable === true ||
        error?.name === "AbortError" ||
        error?.name === "TimeoutError" ||
        error instanceof TypeError;
      if (!retryable || attempt >= retries) throw error;
      const delayMs = Math.min(
        30_000,
        Math.max(baseDelayMs * 2 ** attempt, error.retryAfterMs || 0),
      );
      onRetry({ attempt: attempt + 1, delayMs, error, url });
      await sleepImpl(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function validAuraPublicAnonKey(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return (
      payload?.iss === "supabase" &&
      payload?.ref === AURA_SUPABASE_PROJECT_REF &&
      payload?.role === "anon"
    );
  } catch {
    return false;
  }
}

export async function discoverAuraPublicAnonKey({
  fetchImpl = globalThis.fetch,
  retries = 3,
  timeoutMs = 20_000,
  baseDelayMs = 400,
  sleepImpl,
} = {}) {
  const retryOptions = {
    fetchImpl,
    retries,
    timeoutMs,
    baseDelayMs,
    ...(sleepImpl ? { sleepImpl } : {}),
  };
  const { text: page } = await fetchTextWithRetry(AURA_BROWSE_URL, {
    ...retryOptions,
    headers: { Accept: "text/html" },
    maximumBytes: 1_000_000,
  });
  const scripts = [];
  for (const match of page.matchAll(
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  )) {
    const scriptUrl = new URL(match[1], AURA_BASE_URL);
    if (
      scriptUrl.origin !== AURA_BASE_URL ||
      !scriptUrl.pathname.startsWith("/assets/") ||
      !scriptUrl.pathname.endsWith(".js")
    ) {
      continue;
    }
    scripts.push(scriptUrl.href);
  }
  if (scripts.length === 0) {
    throw new Error(
      "Aura page did not expose a same-origin application script",
    );
  }

  const candidates = new Set();
  for (const scriptUrl of [...new Set(scripts)]) {
    const { text: script } = await fetchTextWithRetry(scriptUrl, {
      ...retryOptions,
      headers: { Accept: "application/javascript,text/javascript" },
      maximumBytes: MAX_SCRIPT_BYTES,
    });
    for (const token of script.match(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    ) ?? []) {
      if (validAuraPublicAnonKey(token)) candidates.add(token);
    }
  }
  if (candidates.size !== 1) {
    throw new Error(
      `Expected one Aura public anonymous client key, found ${candidates.size}`,
    );
  }
  return [...candidates][0];
}

function parseContentRange(value) {
  if (String(value ?? "") === "*/0") {
    return { start: 0, end: -1, total: 0 };
  }
  const match = String(value ?? "").match(/^(\d+)-(\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid or missing Content-Range: ${value}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isInteger) || end < start) {
    throw new Error(`Invalid Content-Range: ${value}`);
  }
  return { start, end, total };
}

async function fetchAuraJson(
  url,
  {
    anonKey,
    range,
    fetchImpl,
    retries,
    timeoutMs,
    baseDelayMs,
    sleepImpl,
    preferCount = false,
  },
) {
  if (!validAuraPublicAnonKey(anonKey)) {
    throw new Error("Aura client key must be the public anonymous project key");
  }
  const { response, text } = await fetchTextWithRetry(url, {
    fetchImpl,
    retries,
    timeoutMs,
    baseDelayMs,
    ...(sleepImpl ? { sleepImpl } : {}),
    headers: {
      Accept: "application/json",
      apikey: anonKey,
      ...(range ? { Range: range } : {}),
      ...(preferCount ? { Prefer: "count=exact" } : {}),
    },
  });
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Aura JSON response: ${error.message}`);
  }
  if (!Array.isArray(data)) {
    throw new TypeError("Aura public catalog response must be an array");
  }
  return { data, response };
}

function auraTableUrl(sourceKind) {
  const table = sourceKind === "html" ? AURA_HTML_TABLE : AURA_REACT_TABLE;
  const url = new URL(`${AURA_REST_URL}/${table}`);
  url.searchParams.set("select", SOURCE_SELECTS[sourceKind]);
  url.searchParams.set("featured", "eq.true");
  if (sourceKind === "html") {
    url.searchParams.append("or", "(private.is.null,private.eq.false)");
  } else {
    url.searchParams.set("private", "eq.false");
  }
  url.searchParams.set("order", "featured_at.desc.nullslast,id.asc");
  return url;
}

async function fetchAuraSourceRows(
  sourceKind,
  {
    collectAll,
    targetCount,
    pageSize,
    maxPages,
    anonKey,
    fetchImpl,
    retries,
    timeoutMs,
    baseDelayMs,
    sleepImpl,
    logger,
  },
) {
  const rows = [];
  let total = null;
  let pagesFetched = 0;
  const wanted = collectAll ? Number.POSITIVE_INFINITY : targetCount;
  while (rows.length < wanted && (total === null || rows.length < total)) {
    if (pagesFetched >= maxPages) {
      throw new Error(
        `Aura ${sourceKind} pagination exceeded the ${maxPages}-page safety bound`,
      );
    }
    const remaining = Number.isFinite(wanted) ? wanted - rows.length : pageSize;
    const limit = Math.min(pageSize, remaining);
    const start = rows.length;
    const end = start + limit - 1;
    const url = auraTableUrl(sourceKind);
    logger.info?.(
      `Fetching Aura ${sourceKind} templates ${start + 1}-${end + 1}`,
    );
    const { data, response } = await fetchAuraJson(url, {
      anonKey,
      range: `${start}-${end}`,
      preferCount: true,
      fetchImpl,
      retries,
      timeoutMs,
      baseDelayMs,
      sleepImpl,
    });
    pagesFetched += 1;
    const range = parseContentRange(response.headers.get("content-range"));
    if (range.start !== start || range.total < data.length) {
      throw new Error(`Aura ${sourceKind} returned an inconsistent range`);
    }
    if (total !== null && range.total !== total) {
      throw new Error(
        `Aura ${sourceKind} inventory changed during capture (${total} to ${range.total})`,
      );
    }
    total = range.total;
    rows.push(...data);
    if (data.length === 0 || data.length < limit) break;
  }
  const identities = new Set(rows.map((row) => String(row?.id ?? "")));
  if (identities.size !== rows.length || identities.has("")) {
    throw new Error(`Aura ${sourceKind} returned duplicate or missing IDs`);
  }
  if (collectAll && rows.length !== total) {
    throw new Error(
      `Aura ${sourceKind} capture stopped at ${rows.length} of ${total}`,
    );
  }
  return { rows, total, pagesFetched };
}

async function fetchAuthorProfiles(
  userIds,
  { anonKey, fetchImpl, retries, timeoutMs, baseDelayMs, sleepImpl },
) {
  const ids = [...new Set(userIds)]
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))
    .sort();
  const profiles = new Map();
  for (let index = 0; index < ids.length; index += 75) {
    const batch = ids.slice(index, index + 75);
    const url = new URL(`${AURA_REST_URL}/${AURA_PROFILE_TABLE}`);
    url.searchParams.set("select", "id,full_name,slug");
    url.searchParams.set("id", `in.(${batch.join(",")})`);
    const { data } = await fetchAuraJson(url, {
      anonKey,
      fetchImpl,
      retries,
      timeoutMs,
      baseDelayMs,
      sleepImpl,
    });
    for (const profile of data) {
      if (profile?.id) profiles.set(String(profile.id), profile);
    }
  }
  return profiles;
}

function sourceTimestamp(row) {
  const timestamp = Date.parse(
    row?.featured_at ?? row?.published_at ?? row?.created_at ?? 0,
  );
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sourceViews(row) {
  return Number(row?.views ?? row?.view_count) || 0;
}

function mergeSourceRows(htmlRows, reactRows, targetCount) {
  return [
    ...htmlRows.map((row) => ({ sourceKind: "html", row })),
    ...reactRows.map((row) => ({ sourceKind: "react", row })),
  ]
    .sort(
      (left, right) =>
        sourceTimestamp(right.row) - sourceTimestamp(left.row) ||
        sourceViews(right.row) - sourceViews(left.row) ||
        `${left.sourceKind}:${left.row.id}`.localeCompare(
          `${right.sourceKind}:${right.row.id}`,
        ),
    )
    .slice(0, targetCount ?? Number.POSITIVE_INFINITY);
}

function countBy(items, keyForItem) {
  const counts = {};
  for (const item of items) {
    const key = keyForItem(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function catalogEnvelope({
  capturedAt,
  collectAll,
  targetCount,
  pageSize,
  maxPages,
  retries,
  timeoutMs,
  htmlCapture,
  reactCapture,
  templates,
}) {
  const sourceTotal = htmlCapture.total + reactCapture.total;
  const accessTiers = countBy(
    templates,
    (template) => template.source_metadata.access_tier,
  );
  const sourceKinds = countBy(
    templates,
    (template) => template.source_metadata.source_template_type,
  );
  const previewCounts = {
    allowlisted: templates.filter((template) => template.thumbnail_url).length,
    legacy_host: templates.filter((template) => {
      try {
        return (
          new URL(template.thumbnail_url).hostname === AURA_LEGACY_PREVIEW_HOST
        );
      } catch {
        return false;
      }
    }).length,
    metadata_only: templates.filter((template) => !template.thumbnail_url)
      .length,
  };
  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    generated_at: capturedAt,
    source: {
      provider: AURA_SOURCE_PROVIDER,
      collection_url: AURA_BROWSE_URL,
      public_api_origin: AURA_REST_URL,
      source_tables: [AURA_HTML_TABLE, AURA_REACT_TABLE],
      category: "web-design-reference",
      filters: {
        featured: true,
        private: false,
        minimum_views: null,
        access_tiers: ["free", "aura-pro", "creator-paid"],
      },
      sort: "featured_at",
      order: "desc",
      capture_scope:
        "Public featured Aura HTML and React template metadata plus allowlisted preview URLs; source code and webpage HTML are not collected.",
    },
    harvest: {
      requested_count: collectAll ? "all" : targetCount,
      mode: collectAll ? "exhaustive" : "target",
      complete: true,
      pagination_exhausted: collectAll,
      template_count: templates.length,
      source_total_at_capture: sourceTotal,
      pages_fetched: htmlCapture.pagesFetched + reactCapture.pagesFetched,
      summaries_fetched: htmlCapture.rows.length + reactCapture.rows.length,
      source_counts: {
        html: htmlCapture.total,
        react: reactCapture.total,
      },
      retained_counts: {
        html: templates.filter((template) =>
          template.source_external_id.startsWith("html:"),
        ).length,
        react: templates.filter((template) =>
          template.source_external_id.startsWith("react:"),
        ).length,
      },
      access_tiers: accessTiers,
      source_template_types: sourceKinds,
      aura_visibility: countBy(
        templates,
        (template) => template.source_metadata.aura_visibility,
      ),
      aura_pulse_eligible: templates.filter(
        (template) => template.source_metadata.aura_pulse_eligible === true,
      ).length,
      previews: previewCounts,
      source_code_collected: 0,
      detail_failures: [],
      quality_rejections: [],
      quality_warnings: [],
      bounds: {
        page_size: pageSize,
        max_pages_per_source: maxPages,
        retries,
        timeout_ms: timeoutMs,
        maximum_catalog_templates: MAX_CATALOG_TEMPLATES,
      },
    },
    import_contract: {
      target: "POST /api/v1/campaign-templates/import",
      payload_fields: [...POSTWAVE_CREATE_PAYLOAD_FIELDS],
      cli: {
        flag: "--postwave-api-url <api-base-or-import-endpoint>",
        token_env: "POSTWAVE_API_TOKEN",
      },
      projection:
        "Imports are idempotent on source_provider + source_external_id. Catalog-only adaptation_policy, previews, and provenance remain evidence in the artifact while their persisted equivalents use source_metadata/design_metadata.",
    },
    templates,
  };
}

export async function ingestAuraTemplateCatalog({
  targetCount = 50,
  collectAll = false,
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  retries = 3,
  timeoutMs = 20_000,
  baseDelayMs = 400,
  capturedAt = new Date().toISOString(),
  anonKey = "",
  fetchImpl = globalThis.fetch,
  sleepImpl,
  logger = console,
} = {}) {
  const target = collectAll
    ? null
    : clampInteger(targetCount, {
        name: "targetCount",
        minimum: 1,
        maximum: MAX_CATALOG_TEMPLATES,
      });
  const perPage = clampInteger(pageSize, {
    name: "pageSize",
    minimum: 1,
    maximum: 1_000,
  });
  const pageLimit = clampInteger(maxPages, {
    name: "maxPages",
    minimum: 1,
    maximum: 1_000,
  });
  const retryLimit = clampInteger(retries, {
    name: "retries",
    minimum: 0,
    maximum: 10,
  });
  const timeout = clampInteger(timeoutMs, {
    name: "timeoutMs",
    minimum: 100,
    maximum: 120_000,
  });
  const publicAnonKey = anonKey
    ? (() => {
        if (!validAuraPublicAnonKey(anonKey)) {
          throw new Error(
            "AURA_PUBLIC_ANON_KEY is not Aura's public anonymous project key",
          );
        }
        return anonKey;
      })()
    : await discoverAuraPublicAnonKey({
        fetchImpl,
        retries: retryLimit,
        timeoutMs: timeout,
        baseDelayMs,
        sleepImpl,
      });
  const sharedOptions = {
    collectAll,
    targetCount: target,
    pageSize: perPage,
    maxPages: pageLimit,
    anonKey: publicAnonKey,
    fetchImpl,
    retries: retryLimit,
    timeoutMs: timeout,
    baseDelayMs,
    sleepImpl,
    logger,
  };
  const [htmlCapture, reactCapture] = await Promise.all([
    fetchAuraSourceRows("html", sharedOptions),
    fetchAuraSourceRows("react", sharedOptions),
  ]);
  const sourceTotal = htmlCapture.total + reactCapture.total;
  if (sourceTotal > MAX_CATALOG_TEMPLATES) {
    throw new Error(
      `Aura public template inventory ${sourceTotal} exceeds the ${MAX_CATALOG_TEMPLATES} catalog safety bound`,
    );
  }
  const selected = mergeSourceRows(htmlCapture.rows, reactCapture.rows, target);
  if (!collectAll && selected.length < target) {
    throw new Error(
      `Aura only returned ${selected.length} of ${target} requested templates`,
    );
  }
  const authorProfiles = await fetchAuthorProfiles(
    selected.map(({ row }) => String(row.user_id ?? "")).filter(Boolean),
    {
      anonKey: publicAnonKey,
      fetchImpl,
      retries: retryLimit,
      timeoutMs: timeout,
      baseDelayMs,
      sleepImpl,
    },
  );
  const templates = selected.map(({ sourceKind, row }) =>
    normalizeAuraReference(sourceKind, row, {
      capturedAt,
      authorProfiles,
    }),
  );
  const catalog = catalogEnvelope({
    capturedAt,
    collectAll,
    targetCount: target,
    pageSize: perPage,
    maxPages: pageLimit,
    retries: retryLimit,
    timeoutMs: timeout,
    htmlCapture,
    reactCapture,
    templates,
  });
  return validateCatalog(catalog);
}

export function parseAuraArgs(argv) {
  const options = {
    targetCount: 50,
    collectAll: false,
    pageSize: DEFAULT_PAGE_SIZE,
    maxPages: DEFAULT_MAX_PAGES,
    retries: 3,
    timeoutMs: 20_000,
    baseDelayMs: 400,
    outputPath: DEFAULT_OUTPUT_PATH,
    quiet: false,
    postwaveApiUrl: "",
    importCatalogPath: "",
  };
  let targetRequested = false;
  let allRequested = false;
  let outputExplicit = false;
  const numericFlags = new Map([
    ["--target", ["targetCount", 1, MAX_CATALOG_TEMPLATES]],
    ["--page-size", ["pageSize", 1, 1_000]],
    ["--max-pages", ["maxPages", 1, 1_000]],
    ["--retries", ["retries", 0, 10]],
    ["--timeout-ms", ["timeoutMs", 100, 120_000]],
    ["--base-delay-ms", ["baseDelayMs", 0, 30_000]],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (argument === "--all") {
      if (targetRequested) {
        throw new Error("--all and --target cannot be used together");
      }
      allRequested = true;
      options.collectAll = true;
      continue;
    }
    if (argument === "--out") {
      const outputPath = argv[index + 1];
      if (!outputPath) throw new Error("--out requires a path");
      options.outputPath = outputPath;
      outputExplicit = true;
      index += 1;
      continue;
    }
    if (argument === "--postwave-api-url") {
      const apiUrl = argv[index + 1];
      if (!apiUrl) throw new Error("--postwave-api-url requires a URL");
      options.postwaveApiUrl = apiUrl;
      index += 1;
      continue;
    }
    if (argument === "--import-catalog") {
      const inputPath = argv[index + 1];
      if (!inputPath) throw new Error("--import-catalog requires a path");
      options.importCatalogPath = inputPath;
      index += 1;
      continue;
    }
    const numeric = numericFlags.get(argument);
    if (!numeric) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    const [key, minimum, maximum] = numeric;
    if (argument === "--target") {
      if (allRequested) {
        throw new Error("--all and --target cannot be used together");
      }
      targetRequested = true;
    }
    options[key] = clampInteger(value, {
      name: argument,
      minimum,
      maximum,
    });
    index += 1;
  }
  if (allRequested && !outputExplicit) {
    options.outputPath = DEFAULT_FULL_OUTPUT_PATH;
  }
  if (options.importCatalogPath) {
    if (!options.postwaveApiUrl) {
      throw new Error(
        "--import-catalog requires --postwave-api-url so the destination is explicit",
      );
    }
    if (allRequested || targetRequested || outputExplicit) {
      throw new Error(
        "--import-catalog cannot be combined with --all, --target, or --out",
      );
    }
  }
  return options;
}

function helpText() {
  return `Usage: node scripts/aura-template-ingest.mjs [options]

Capture Aura's public featured HTML and React template metadata as attributed,
adaptation-only Moosewave newsletter design references. Source code and webpage
HTML are never collected.

Options:
  --target N          References to write (default: 50)
  --all               Capture the complete public featured template inventory
                      (defaults --out to ${DEFAULT_FULL_OUTPUT_PATH})
  --page-size N       Public API records per page (default: ${DEFAULT_PAGE_SIZE}, max: 1000)
  --max-pages N       Safety ceiling per source table (default: ${DEFAULT_MAX_PAGES})
  --retries N         Retries for transient requests (default: 3, max: 10)
  --timeout-ms N      Per-request timeout (default: 20000)
  --base-delay-ms N   Exponential retry base delay (default: 400)
  --out PATH          Output path (default: ${DEFAULT_OUTPUT_PATH})
  --postwave-api-url  Also import into this explicit Moosewave API base URL
                      (reads the bearer token from POSTWAVE_API_TOKEN)
  --import-catalog PATH
                      Import an existing verified bundle; requires
                      --postwave-api-url
  --quiet             Suppress progress output
  -h, --help          Show this help

The scraper discovers Aura's browser-visible public anonymous client key from
its same-origin application bundle. A current public key can alternatively be
provided through AURA_PUBLIC_ANON_KEY; authenticated or service-role keys are
rejected.
`;
}

async function main() {
  const options = parseAuraArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.importCatalogPath) {
    const { catalog, result } = await importCatalogBundleToPostwave(
      options.importCatalogPath,
      {
        apiUrl: options.postwaveApiUrl,
        token: process.env.POSTWAVE_API_TOKEN,
        timeoutMs: Math.max(options.timeoutMs, 120_000),
      },
    );
    process.stdout.write(
      `Imported ${catalog.harvest.template_count} verified Aura references: ${result.created ?? 0} created, ${result.updated ?? 0} updated across ${result.batches ?? 0} batches\n`,
    );
    return;
  }
  const logger = options.quiet
    ? { info() {}, warn() {} }
    : { info: console.log, warn: console.warn };
  const catalog = await ingestAuraTemplateCatalog({
    ...options,
    anonKey: process.env.AURA_PUBLIC_ANON_KEY ?? "",
    logger,
  });
  const bundle = await writeCatalogBundle(options.outputPath, catalog);
  process.stdout.write(
    `Wrote ${catalog.harvest.template_count} Aura design references to ${bundle.artifactPath}\nManifest: ${bundle.manifestPath}\n`,
  );
  if (options.postwaveApiUrl) {
    const result = await importCatalogToPostwave(catalog, {
      apiUrl: options.postwaveApiUrl,
      token: process.env.POSTWAVE_API_TOKEN,
      timeoutMs: Math.max(options.timeoutMs, 120_000),
    });
    process.stdout.write(
      `Moosewave import complete: ${result.created ?? 0} created, ${result.updated ?? 0} updated\n`,
    );
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) {
  main().catch((error) => {
    console.error(`Aura template ingest failed: ${error.message}`);
    process.exitCode = 1;
  });
}
