#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RGE_BASE_URL = "https://reallygoodemails.com";
export const RGE_NEWSLETTER_URL = `${RGE_BASE_URL}/categories/newsletter`;
export const DEFAULT_OUTPUT_PATH =
  "scripts/fixtures/rge-newsletter-catalog.json";
export const DEFAULT_FULL_OUTPUT_PATH =
  "scripts/fixtures/rge-newsletter-catalog-full.json.gz";
export const POSTWAVE_CREATE_PAYLOAD_FIELDS = Object.freeze([
  "slug",
  "name",
  "description",
  "category",
  "goal",
  "subject",
  "preview_text",
  "body_html",
  "body_mjml",
  "variables",
  "tags",
  "template_kind",
  "source_provider",
  "source_external_id",
  "source_url",
  "source_brand",
  "thumbnail_url",
  "source_captured_at",
  "source_license_status",
  "source_metadata",
  "industry",
  "style",
  "layout",
  "design_metadata",
  "review_status",
  "quality_score",
  "content_hash",
  "reference_template_ids",
  "generation_metadata",
]);

const DEFAULT_USER_AGENT =
  "PostwaveNewsletterCatalog/1.0 (+https://github.com/postwave/postwave; personal-reference-ingest)";
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const POSTWAVE_SLUG_MAX_LENGTH = 80;
const POSTWAVE_NAME_MAX_LENGTH = 200;
const PREVIEW_TEXT_MAX_LENGTH = 300;
const MAX_SOURCE_HTML_BYTES = 1_800_000;
const MAX_JSON_RESPONSE_BYTES = 4_000_000;
const MAX_CATALOG_TEMPLATES = 10_000;
const MAX_CATALOG_METADATA_BYTES = 10_000_000;
const DEFAULT_MAX_PAGES = 100;
const IMPORT_MAX_ITEMS = 100;
const IMPORT_MAX_BYTES = 7_500_000;
const CATALOG_SCHEMA_VERSION =
  "postwave.campaign-template-reference-catalog.v1";
const CATALOG_MANIFEST_SCHEMA_VERSION =
  "postwave.campaign-template-reference-manifest.v1";
const INDUSTRY_CATEGORY_SLUGS = new Set([
  "artificial-intelligence",
  "automotive",
  "b2b",
  "banking-credit-card",
  "ecommerce",
  "education",
  "entertainment",
  "fashion",
  "financial",
  "food-and-beverage",
  "government",
  "health-and-wellness-medical",
  "hotels-and-resorts",
  "media",
  "non-profit-charity",
  "publication-and-blog",
  "real-estate",
  "religion",
  "retail",
  "saas",
  "sports",
  "technology",
  "travel-and-leisure",
]);

export class HttpError extends Error {
  constructor(message, { status, url, retryable = false, body = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.retryable = retryable;
    this.body = body;
  }
}

function clampInteger(value, { name, minimum, maximum }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function decodeEntity(entity) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };
  const normalized = entity.toLowerCase();
  if (named[normalized] !== undefined) return named[normalized];
  if (!normalized.startsWith("#")) return `&${entity};`;

  const radix = normalized.startsWith("#x") ? 16 : 10;
  const digits = normalized.slice(radix === 16 ? 2 : 1);
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return `&${entity};`;
  }
}

export function stripHtml(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return value
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (_, entity) =>
      decodeEntity(entity),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, maximum) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
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

function sourceSlugValue(...values) {
  for (const value of values) {
    const slug = String(value ?? "").trim();
    if (slug) return slug;
  }
  return "";
}

function encodeSourceSlugPath(sourceSlug) {
  // RGE listing results occasionally return slugs that already contain
  // percent-encoded UTF-8 bytes. Encode the path segment without turning an
  // existing `%f0` sequence into `%25f0`.
  return encodeURIComponent(sourceSlugValue(sourceSlug)).replace(
    /%25([0-9a-f]{2})/gi,
    "%$1",
  );
}

export function makePostwaveSlug(sourceSlug) {
  const raw = sourceSlugValue(sourceSlug);
  const normalized = normalizeToken(raw);
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const stableToken =
    !normalized || raw !== normalized
      ? `${normalized || "newsletter-reference"}-${digest}`
      : normalized;
  const candidate = `rge-${stableToken}`;
  if (candidate.length <= POSTWAVE_SLUG_MAX_LENGTH) return candidate;

  const prefixLength = POSTWAVE_SLUG_MAX_LENGTH - digest.length - 1;
  return `${candidate.slice(0, prefixLength).replace(/-+$/g, "")}-${digest}`;
}

function asHttpsUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function normalizeTaxonomy(items) {
  if (!Array.isArray(items)) return [];
  const unique = new Map();
  for (const item of items) {
    const slug = normalizeToken(item?.slug || item?.name);
    if (!slug || unique.has(slug)) continue;
    unique.set(slug, {
      slug,
      name: stripHtml(String(item?.name ?? item?.slug ?? slug)),
    });
  }
  return [...unique.values()];
}

function countMatches(input, expression) {
  return [...input.matchAll(expression)].length;
}

export function inspectEmailHtml(html) {
  const source = typeof html === "string" ? html : "";
  const lowered = source.toLowerCase();
  const imageCount = countMatches(source, /<img\b/gi);
  const imagesWithAlt = countMatches(
    source,
    /<img\b[^>]*\balt\s*=\s*["'][^"']*["']/gi,
  );
  return {
    source_bytes: Buffer.byteLength(source, "utf8"),
    image_count: imageCount,
    images_with_alt_count: imagesWithAlt,
    link_count: countMatches(source, /<a\b[^>]*\bhref\s*=/gi),
    has_doctype: /<!doctype\s+html/i.test(source),
    has_responsive_css: /@media\b/i.test(source),
    has_dark_mode_css:
      /prefers-color-scheme\s*:\s*dark/i.test(source) ||
      /supported-color-schemes/i.test(source),
    has_table_layout: /<table\b/i.test(source),
    has_active_content:
      /<\s*(?:script|iframe|object|embed|form)\b/i.test(source) ||
      /\son[a-z]+\s*=/i.test(source) ||
      /javascript\s*:/i.test(lowered),
  };
}

export function assessReferenceQuality(summary, detail) {
  const reasons = [];
  const html = detail?.html;
  const analysis = inspectEmailHtml(html);
  const categories = normalizeTaxonomy(
    detail?.categories ?? summary?.categories,
  );
  const desktop = detail?.desktopScreenshot ?? summary?.desktopScreenshot;
  const desktopUrl = asHttpsUrl(desktop?.url);
  const width = Number(desktop?.width);
  const height = Number(desktop?.height);

  if (!stripHtml(String(detail?.title ?? summary?.title ?? "")))
    reasons.push("missing_title");
  if (!normalizeToken(detail?.slug ?? summary?.slug))
    reasons.push("missing_slug");
  if (!stripHtml(String((detail?.company ?? summary?.company)?.name ?? ""))) {
    reasons.push("missing_company");
  }
  if (!categories.some((category) => category.slug === "newsletter")) {
    reasons.push("not_newsletter");
  }
  if (!desktopUrl) reasons.push("missing_desktop_screenshot");
  if (!Number.isFinite(width) || width < 500)
    reasons.push("desktop_width_below_500");
  if (!Number.isFinite(height) || height < 800)
    reasons.push("desktop_height_below_800");
  if (analysis.source_bytes < 1_000)
    reasons.push("source_html_below_1000_bytes");
  if (analysis.source_bytes > MAX_SOURCE_HTML_BYTES)
    reasons.push("source_html_too_large");
  if (!/<(?:html|table|div)\b/i.test(String(html ?? "")))
    reasons.push("invalid_source_html");
  if (analysis.has_active_content) reasons.push("active_content_detected");

  let score = 100;
  score -= reasons.length * 20;
  if (!asHttpsUrl((detail?.mobileScreenshot ?? summary?.mobileScreenshot)?.url))
    score -= 5;
  if (!analysis.has_responsive_css) score -= 5;
  if (
    analysis.image_count > 0 &&
    analysis.images_with_alt_count < analysis.image_count
  )
    score -= 5;

  return {
    eligible: reasons.length === 0,
    score: Math.max(0, score),
    rejection_reasons: reasons,
    html_analysis: analysis,
  };
}

function normalizedScreenshot(value) {
  const url = asHttpsUrl(value?.url);
  if (!url) return null;
  const width = Number(value?.width);
  const height = Number(value?.height);
  return {
    url,
    ...(Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(Number.isFinite(height) && height > 0 ? { height } : {}),
  };
}

function makeTags(categories, tags, company) {
  const tokens = [
    "source-rge",
    ...categories.map((item) => item.slug),
    ...tags.map((item) => item.slug),
    company?.slug ? `company-${normalizeToken(company.slug)}` : "",
  ];
  return [...new Set(tokens.filter(Boolean))].slice(0, 40);
}

function inferIndustry(categories) {
  return (
    categories.find((category) => INDUSTRY_CATEGORY_SLUGS.has(category.slug))
      ?.slug ?? ""
  );
}

function inferLayout(desktopScreenshot) {
  const width = Number(desktopScreenshot?.width);
  const height = Number(desktopScreenshot?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height))
    return "";
  const aspectRatio = height / width;
  if (aspectRatio >= 8) return "long-scroll";
  if (aspectRatio >= 4.5) return "editorial-scroll";
  return "compact-scroll";
}

function inferStyle(htmlAnalysis) {
  if (htmlAnalysis.has_dark_mode_css) return "dark-mode-aware";
  if (htmlAnalysis.image_count >= 12) return "image-led";
  if (htmlAnalysis.link_count >= 12) return "curated-editorial";
  return "editorial";
}

export function createPostwaveImportPayload(reference) {
  if (!reference || typeof reference !== "object") {
    throw new TypeError("reference must be an object");
  }
  return Object.fromEntries(
    POSTWAVE_CREATE_PAYLOAD_FIELDS.filter(
      (field) => reference[field] !== undefined,
    ).map((field) => [field, reference[field]]),
  );
}

function referenceSourceSlug(reference) {
  return sourceSlugValue(
    reference?.provenance?.source_slug ??
      reference?.source_metadata?.source_slug ??
      String(reference?.catalog_id ?? "").replace(/^rge:/, ""),
  );
}

function referenceSourceKey(reference) {
  const provider = normalizeToken(reference?.source_provider);
  const externalId = String(reference?.source_external_id ?? "").trim();
  return provider && externalId ? `${provider}:${externalId}` : "";
}

function addUniqueIdentity(set, value, label) {
  if (!value) throw new Error(`Catalog reference is missing ${label}`);
  if (set.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
  set.add(value);
}

/**
 * Validate the complete JSON envelope before it is checkpointed, published, or
 * sent to Moosewave. This deliberately checks stable source identities rather
 * than content hashes: two distinct emails may legitimately share HTML.
 */
export function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new TypeError("catalog must be an object");
  }
  if (catalog.schema_version !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported catalog schema_version: ${catalog.schema_version ?? "missing"}`,
    );
  }
  if (!Array.isArray(catalog.templates)) {
    throw new TypeError("catalog.templates must be an array");
  }
  if (catalog.templates.length > MAX_CATALOG_TEMPLATES) {
    throw new Error(
      `Catalog exceeds the ${MAX_CATALOG_TEMPLATES} template safety bound`,
    );
  }
  if (catalog.harvest?.template_count !== catalog.templates.length) {
    throw new Error(
      "catalog.harvest.template_count must equal catalog.templates.length",
    );
  }

  const catalogIds = new Set();
  const slugs = new Set();
  const sourceSlugs = new Set();
  const sourceKeys = new Set();
  for (const reference of catalog.templates) {
    if (!reference || typeof reference !== "object") {
      throw new TypeError("Catalog templates must be objects");
    }
    addUniqueIdentity(catalogIds, reference.catalog_id, "catalog_id");
    addUniqueIdentity(slugs, reference.slug, "slug");
    addUniqueIdentity(
      sourceSlugs,
      referenceSourceSlug(reference),
      "source slug",
    );
    addUniqueIdentity(
      sourceKeys,
      referenceSourceKey(reference),
      "source provider/external ID",
    );
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(reference.slug)) {
      throw new Error(`Invalid Moosewave template slug: ${reference.slug}`);
    }
    if (reference.template_kind !== "reference") {
      throw new Error(`${reference.catalog_id} is not a reference template`);
    }
    if (
      reference.category !== "newsletter" ||
      reference.goal !== "newsletter"
    ) {
      throw new Error(`${reference.catalog_id} is not a newsletter template`);
    }
    if (typeof reference.body_html !== "string") {
      throw new TypeError(`${reference.catalog_id} body_html must be a string`);
    }
    const htmlBytes = Buffer.byteLength(reference.body_html, "utf8");
    if (
      htmlBytes !== 0 &&
      (htmlBytes < 1_000 || htmlBytes > MAX_SOURCE_HTML_BYTES)
    ) {
      throw new Error(
        `${reference.catalog_id} body_html is outside the allowed byte range`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(reference.content_hash ?? "")) {
      throw new Error(`${reference.catalog_id} has an invalid content_hash`);
    }
    if (!asHttpsUrl(reference.source_url)) {
      throw new Error(`${reference.catalog_id} has an invalid source_url`);
    }
    if (reference.thumbnail_url && !asHttpsUrl(reference.thumbnail_url)) {
      throw new Error(`${reference.catalog_id} has an invalid thumbnail_url`);
    }
    if (
      htmlBytes > 0 &&
      inspectEmailHtml(reference.body_html).has_active_content
    ) {
      throw new Error(`${reference.catalog_id} contains active content`);
    }
  }
  return catalog;
}

/**
 * Check the capture-level invariants that make a catalog safe to deploy.
 * Checkpoints intentionally fail this validation because they are recovery
 * state, not deployable inventory.
 */
export function validateCatalogImportReadiness(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new TypeError("catalog must be an object");
  }
  if (catalog.harvest?.complete !== true) {
    throw new Error("Catalog import requires harvest.complete=true");
  }
  if (!["target", "exhaustive"].includes(catalog.harvest?.mode)) {
    throw new Error(
      "Catalog import requires harvest.mode to be target or exhaustive",
    );
  }
  if (
    !Number.isInteger(catalog.harvest.template_count) ||
    !Array.isArray(catalog.templates) ||
    catalog.harvest.template_count !== catalog.templates.length
  ) {
    throw new Error(
      "Catalog import requires harvest.template_count to match templates.length",
    );
  }
  if (catalog.harvest?.mode === "exhaustive") {
    if (catalog.harvest.pagination_exhausted !== true) {
      throw new Error(
        "Exhaustive catalog import requires harvest.pagination_exhausted=true",
      );
    }
    const templateCount = catalog.harvest.template_count;
    const sourceTotal = catalog.harvest.source_total_at_capture;
    if (
      !Number.isInteger(templateCount) ||
      !Number.isInteger(sourceTotal) ||
      templateCount !== sourceTotal
    ) {
      throw new Error(
        "Exhaustive catalog import requires template_count to match source_total_at_capture",
      );
    }
  }
  return catalog;
}

/**
 * A reference review receipt is bound to content_hash, so the declared value
 * must always describe the exact stored HTML rather than merely looking like a
 * SHA-256 token.
 */
export function validateCatalogContentHashes(catalog) {
  if (!catalog || !Array.isArray(catalog.templates)) {
    throw new TypeError("catalog.templates must be an array");
  }
  for (const reference of catalog.templates) {
    if (typeof reference?.body_html !== "string") {
      throw new TypeError(
        `${reference?.catalog_id ?? "Catalog reference"} body_html must be a string`,
      );
    }
    const expected = `sha256:${createHash("sha256")
      .update(reference.body_html)
      .digest("hex")}`;
    if (reference.content_hash !== expected) {
      throw new Error(
        `${reference.catalog_id ?? reference.slug ?? "Catalog reference"} content_hash does not match body_html`,
      );
    }
  }
  return catalog;
}

function validateCatalogForImport(catalog) {
  validateCatalog(catalog);
  validateCatalogImportReadiness(catalog);
  validateCatalogContentHashes(catalog);
  const sourceProvider = catalog.source?.provider;
  if (
    typeof sourceProvider !== "string" ||
    sourceProvider.length === 0 ||
    sourceProvider !== sourceProvider.trim() ||
    sourceProvider !== sourceProvider.toLowerCase() ||
    sourceProvider === "postwave"
  ) {
    throw new Error(
      "Catalog source.provider must be a normalized external provider",
    );
  }
  for (const reference of catalog.templates) {
    if (reference.source_provider !== sourceProvider) {
      throw new Error(
        `${reference.catalog_id} source_provider must match catalog source.provider ${sourceProvider}`,
      );
    }
  }
  return catalog;
}

/**
 * Split a catalog below both server limits without repeatedly serializing an
 * ever-growing candidate batch. Each template is encoded once; the fixed
 * envelope size plus commas gives the exact request size.
 */
function* catalogImportBatchIterator(
  catalog,
  { maxItems = IMPORT_MAX_ITEMS, maxBytes = IMPORT_MAX_BYTES } = {},
) {
  if (!catalog || !Array.isArray(catalog.templates)) {
    throw new TypeError("catalog.templates must be an array");
  }
  const itemLimit = clampInteger(maxItems, {
    name: "maxItems",
    minimum: 1,
    maximum: IMPORT_MAX_ITEMS,
  });
  const byteLimit = clampInteger(maxBytes, {
    name: "maxBytes",
    minimum: 1_024,
    maximum: 8_000_000,
  });
  const baseEnvelope = {
    ...catalog,
    harvest: {
      ...(catalog.harvest ?? {}),
      import_batch: true,
      source_catalog_template_count: catalog.templates.length,
    },
    templates: [],
  };
  const emptyEnvelopeBytes = Buffer.byteLength(
    JSON.stringify(baseEnvelope),
    "utf8",
  );
  let templates = [];
  let encodedTemplateBytes = 0;

  function takeBatch() {
    const envelope = { ...baseEnvelope, templates };
    const body = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > byteLimit) {
      throw new Error(
        `Import batch unexpectedly exceeded ${byteLimit} bytes (${bytes})`,
      );
    }
    const batch = {
      catalog: envelope,
      body,
      bytes,
      count: templates.length,
    };
    templates = [];
    encodedTemplateBytes = 0;
    return batch;
  }

  for (const template of catalog.templates) {
    const encoded = JSON.stringify(template);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    const candidateCount = templates.length + 1;
    const candidateBytes =
      emptyEnvelopeBytes +
      encodedTemplateBytes +
      encodedBytes +
      Math.max(0, candidateCount - 1);
    if (
      templates.length > 0 &&
      (candidateCount > itemLimit || candidateBytes > byteLimit)
    ) {
      yield takeBatch();
    }

    const singleItemBytes = emptyEnvelopeBytes + encodedBytes;
    if (singleItemBytes > byteLimit) {
      throw new Error(
        `Template ${template?.catalog_id ?? template?.slug ?? "unknown"} cannot fit in a ${byteLimit}-byte import request`,
      );
    }
    templates.push(template);
    encodedTemplateBytes += encodedBytes;
  }
  if (templates.length > 0) yield takeBatch();
}

export function createCatalogImportBatches(catalog, options = {}) {
  return [...catalogImportBatchIterator(catalog, options)];
}

/**
 * Import a generated catalog through Moosewave's bounded, idempotent endpoint.
 * Requests stay under 100 records and 8 MiB, and aggregate failures stop the
 * command with the exact batch number.
 */
export async function importCatalogToPostwave(
  catalog,
  {
    apiUrl,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    maxItems = IMPORT_MAX_ITEMS,
    maxBytes = IMPORT_MAX_BYTES,
  } = {},
) {
  if (!catalog || !Array.isArray(catalog.templates)) {
    throw new TypeError("catalog.templates must be an array");
  }
  validateCatalogImportReadiness(catalog);
  validateCatalogContentHashes(catalog);
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch implementation is required");
  }
  if (!apiUrl) throw new Error("Moosewave API URL is required");
  if (!token) throw new Error("POSTWAVE_API_TOKEN is required for import");
  const base = String(apiUrl).replace(/\/+$/g, "");
  const endpoint = base.endsWith("/api/v1/campaign-templates/import")
    ? base
    : `${base}/api/v1/campaign-templates/import`;
  const aggregate = {
    created: 0,
    updated: 0,
    failed: 0,
    batches: 0,
    items: [],
  };

  let index = 0;
  for (const batch of catalogImportBatchIterator(catalog, {
    maxItems,
    maxBytes,
  })) {
    aggregate.batches += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: batch.body,
        signal: controller.signal,
      });
      const body = await readResponseText(response, MAX_JSON_RESPONSE_BYTES);
      if (!response.ok) {
        throw new HttpError(
          `Moosewave import batch ${index + 1} failed with HTTP ${response.status}`,
          {
            status: response.status,
            url: endpoint,
            body: body.slice(0, 1_000),
          },
        );
      }
      const result = JSON.parse(body);
      aggregate.created += Number(result.created ?? 0);
      aggregate.updated += Number(result.updated ?? 0);
      aggregate.failed += Number(result.failed ?? 0);
      if (Array.isArray(result.items)) aggregate.items.push(...result.items);
      if (Number(result.failed ?? 0) > 0) {
        throw new Error(
          `Moosewave import batch ${index + 1} had ${result.failed} failed items`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
    index += 1;
  }
  return aggregate;
}

export function normalizeReference(
  summary,
  detail,
  { capturedAt = new Date().toISOString() } = {},
) {
  const sourceSlug = sourceSlugValue(detail?.slug, summary?.slug);
  const title = stripHtml(String(detail?.title ?? summary?.title ?? ""));
  const description = stripHtml(
    String(detail?.description ?? summary?.description ?? ""),
  );
  const categories = normalizeTaxonomy(
    detail?.categories ?? summary?.categories,
  );
  const tags = normalizeTaxonomy(detail?.tags ?? summary?.tags);
  const sourceCompany = detail?.company ?? summary?.company;
  const company = sourceCompany
    ? {
        slug: normalizeToken(sourceCompany.slug ?? sourceCompany.name),
        name: stripHtml(String(sourceCompany.name ?? sourceCompany.slug ?? "")),
      }
    : null;
  const desktopScreenshot = normalizedScreenshot(
    detail?.desktopScreenshot ?? summary?.desktopScreenshot,
  );
  const mobileScreenshot = normalizedScreenshot(
    detail?.mobileScreenshot ?? summary?.mobileScreenshot,
  );
  const sourceHtml = typeof detail?.html === "string" ? detail.html : "";
  const quality = assessReferenceQuality(summary, detail);
  const sourceHtmlUsable =
    quality.html_analysis.source_bytes >= 1_000 &&
    quality.html_analysis.source_bytes <= MAX_SOURCE_HTML_BYTES &&
    /<(?:html|table|div)\b/i.test(sourceHtml) &&
    !quality.html_analysis.has_active_content;
  // Empty HTML is intentional for screenshot/metadata-only references. Never
  // persist active, oversized, or malformed source markup merely to make an
  // exhaustive catalog appear complete.
  const html = sourceHtmlUsable ? sourceHtml : "";
  const publishedAt = detail?.publishedAt ?? summary?.publishedAt ?? null;
  const sourceId =
    typeof detail?.id === "string" && detail.id.trim()
      ? detail.id.trim()
      : sourceSlug;
  const encodedSourceSlug = encodeSourceSlugPath(sourceSlug);
  const sourceUrl = `${RGE_BASE_URL}/emails/${encodedSourceSlug}`;
  const detailApiUrl = `${RGE_BASE_URL}/api/emails/${encodedSourceSlug}`;
  const originalSubmission = detail?.originalSubmission
    ? {
        title: stripHtml(String(detail.originalSubmission.title ?? "")),
        user_name: detail.originalSubmission.userName ?? null,
        created_at: detail.originalSubmission.createdAt ?? null,
      }
    : null;
  const sourceMetadata = {
    source_slug: sourceSlug,
    detail_api_url: detailApiUrl,
    collection_url: RGE_NEWSLETTER_URL,
    company,
    published_at: publishedAt,
    source_created_at: detail?.createdAt ?? null,
    html_source: detail?.htmlSource ?? null,
    original_submission: originalSubmission,
    mobile_screenshot: mobileScreenshot,
    source_html_disposition: sourceHtmlUsable
      ? "retained"
      : quality.html_analysis.has_active_content
        ? "quarantined-active-content"
        : "unavailable-or-unusable",
  };
  const normalizedQualityScore = quality.score / 100;
  const industry = inferIndustry(categories);
  const style = inferStyle(quality.html_analysis);
  const layout = inferLayout(desktopScreenshot);

  return {
    catalog_id: `rge:${sourceSlug}`,
    slug: makePostwaveSlug(sourceSlug),
    name: truncate(
      company?.name ? `${company.name} — ${title}` : title,
      POSTWAVE_NAME_MAX_LENGTH,
    ),
    description: truncate(
      description ||
        `Newsletter design reference from ${company?.name || "RGE"}.`,
      1_000,
    ),
    category: "newsletter",
    goal: "newsletter",
    subject: title,
    preview_text: truncate(description, PREVIEW_TEXT_MAX_LENGTH),
    body_html: html,
    body_mjml: "",
    variables: [],
    tags: makeTags(categories, tags, company),
    template_kind: "reference",
    source_provider: "really_good_emails",
    source_external_id: sourceId,
    source_url: sourceUrl,
    source_brand: company?.name ?? "",
    thumbnail_url: desktopScreenshot?.url ?? "",
    source_captured_at: capturedAt,
    source_license_status: "personal-use-unreviewed",
    source_metadata: sourceMetadata,
    industry,
    style,
    layout,
    design_metadata: {
      source_format: sourceHtmlUsable
        ? "html"
        : desktopScreenshot
          ? "screenshot"
          : "metadata",
      source_html_bytes: quality.html_analysis.source_bytes,
      stored_html_bytes: Buffer.byteLength(html, "utf8"),
      screenshot_width: desktopScreenshot?.width ?? null,
      screenshot_height: desktopScreenshot?.height ?? null,
      has_mobile_preview: Boolean(mobileScreenshot),
      categories,
      source_tags: tags,
      html_features: {
        image_count: quality.html_analysis.image_count,
        images_with_alt_count: quality.html_analysis.images_with_alt_count,
        link_count: quality.html_analysis.link_count,
        responsive_css: quality.html_analysis.has_responsive_css,
        dark_mode_css: quality.html_analysis.has_dark_mode_css,
        table_layout: quality.html_analysis.has_table_layout,
        active_content_detected: quality.html_analysis.has_active_content,
      },
      classification_method: "heuristic-v1-pending-review",
      quality_score: normalizedQualityScore,
      quality_warnings: quality.rejection_reasons,
    },
    review_status: "pending",
    quality_score: normalizedQualityScore,
    content_hash: `sha256:${createHash("sha256").update(html).digest("hex")}`,
    reference_template_ids: [],
    generation_metadata: {},
    adaptation_policy: {
      intended_use: "design_reference",
      requires_brand_replacement: true,
      requires_content_rewrite: true,
      requires_link_review: true,
      requires_asset_review: true,
      send_ready: false,
    },
    previews: {
      desktop: desktopScreenshot,
      mobile: mobileScreenshot,
    },
    provenance: {
      provider: "really_good_emails",
      source_id: sourceId,
      source_slug: sourceSlug,
      source_url: sourceUrl,
      detail_api_url: detailApiUrl,
      collection_url: RGE_NEWSLETTER_URL,
      company,
      published_at: publishedAt,
      source_created_at: detail?.createdAt ?? null,
      html_source: detail?.htmlSource ?? null,
      captured_at: capturedAt,
      rights_status: "personal-use-unreviewed",
      original_submission: originalSubmission,
    },
  };
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function readResponseText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(`Response exceeded ${maximumBytes} bytes`, {
      status: response.status,
      url: response.url,
      retryable: false,
    });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new HttpError(`Response exceeded ${maximumBytes} bytes`, {
        status: response.status,
        url: response.url,
        retryable: false,
      });
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response size limit exceeded");
        throw new HttpError(`Response exceeded ${maximumBytes} bytes`, {
          status: response.status,
          url: response.url,
          retryable: false,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchJsonWithRetry(
  url,
  {
    fetchImpl = globalThis.fetch,
    retries = 3,
    timeoutMs = 20_000,
    baseDelayMs = 400,
    maximumBytes = MAX_JSON_RESPONSE_BYTES,
    userAgent = DEFAULT_USER_AGENT,
    onRetry = () => {},
    sleepImpl = (milliseconds) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  } = {},
) {
  if (typeof fetchImpl !== "function")
    throw new Error("fetch implementation is required");
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
          Accept: "application/json",
          "User-Agent": userAgent,
        },
        signal: controller.signal,
      });
      const text = await readResponseText(response, maximumBytes);
      if (!response.ok) {
        const retryable = RETRYABLE_STATUS_CODES.has(response.status);
        const error = new HttpError(`HTTP ${response.status} for ${url}`, {
          status: response.status,
          url,
          retryable,
          body: text.slice(0, 500),
        });
        error.retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new HttpError(`Invalid JSON from ${url}: ${error.message}`, {
          status: response.status,
          url,
          retryable: false,
          body: text.slice(0, 500),
        });
      }
    } catch (error) {
      lastError = error;
      const retryable =
        timedOut ||
        error?.retryable === true ||
        error?.name === "AbortError" ||
        error?.name === "TimeoutError" ||
        error instanceof TypeError;
      if (!retryable || attempt >= retries) throw error;

      const exponentialDelay = baseDelayMs * 2 ** attempt;
      const retryAfterMs = Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : 0;
      const delayMs = Math.min(
        30_000,
        Math.max(exponentialDelay, retryAfterMs),
      );
      onRetry({ attempt: attempt + 1, delayMs, error, url });
      await sleepImpl(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

export async function mapConcurrent(items, concurrency, worker) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const limit = clampInteger(concurrency, {
    name: "concurrency",
    minimum: 1,
    maximum: 20,
  });
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  );
  return results;
}

function searchUrl({ baseUrl, page, pageSize, order }) {
  const url = new URL("/api/search/emails", baseUrl);
  url.searchParams.set("category", "newsletter");
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("sort", "published_at");
  url.searchParams.set("order", order);
  return url.href;
}

function detailUrl(baseUrl, slug) {
  return new URL(`/api/emails/${encodeSourceSlugPath(slug)}`, baseUrl).href;
}

function publicError(error, slug = null) {
  return {
    ...(slug ? { slug } : {}),
    name: error?.name || "Error",
    message: String(error?.message || error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function dedupeDiagnostics(items, keyForItem) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyForItem(item);
    if (!key || unique.has(key)) continue;
    unique.set(key, item);
  }
  return [...unique.values()];
}

function catalogEnvelope({
  origin,
  capturedAt,
  collectAll,
  target,
  selected,
  pagesFetched,
  summariesFetched,
  totalAvailable,
  failures,
  rejected,
  warnings,
  pageSize,
  pageLimit,
  parallelism,
  retryLimit,
  timeout,
  resumed,
  previousTemplateCount,
  duplicateSummariesSkipped,
  duplicateDetailsSkipped,
  sourceUniqueSummaries,
  staleResumeReferencesPruned,
  paginationExhausted,
  complete,
  checkpointEveryPages,
  sourceOrder,
}) {
  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    generated_at: capturedAt,
    source: {
      provider: "really_good_emails",
      collection_url: `${origin}/categories/newsletter`,
      search_api_url: `${origin}/api/search/emails`,
      category: "newsletter",
      sort: "published_at",
      order: sourceOrder,
    },
    harvest: {
      requested_count: collectAll ? "all" : target,
      mode: collectAll ? "exhaustive" : "target",
      complete,
      pagination_exhausted: paginationExhausted,
      resumed,
      previous_template_count: previousTemplateCount,
      template_count: selected.length,
      pages_fetched: pagesFetched,
      summaries_fetched: summariesFetched,
      source_total_at_capture: totalAvailable,
      duplicate_summaries_skipped: duplicateSummariesSkipped,
      duplicate_details_skipped: duplicateDetailsSkipped,
      source_unique_summaries: sourceUniqueSummaries,
      stale_resume_references_pruned: staleResumeReferencesPruned,
      detail_failures: failures,
      quality_rejections: rejected,
      quality_warnings: warnings,
      bounds: {
        page_size: pageSize,
        max_pages: pageLimit,
        concurrency: parallelism,
        retries: retryLimit,
        timeout_ms: timeout,
        checkpoint_every_pages: checkpointEveryPages,
        maximum_source_html_bytes: MAX_SOURCE_HTML_BYTES,
        maximum_catalog_templates: MAX_CATALOG_TEMPLATES,
      },
    },
    import_contract: {
      target: "POST /api/v1/campaign-templates/import",
      payload_fields: [...POSTWAVE_CREATE_PAYLOAD_FIELDS],
      cli: {
        flag: "--postwave-api-url <api-base-or-import-endpoint>",
        token_env: "POSTWAVE_API_TOKEN",
        behavior:
          "Writes the normalized catalog, then posts the complete catalog envelope to the bounded idempotent bulk endpoint and exits non-zero if any item fails.",
      },
      projection:
        "The batch endpoint accepts this complete catalog; createPostwaveImportPayload(template) remains available for single-row clients.",
      note: "Imports are tenant-owned and idempotent on source_provider + source_external_id. Catalog-only adaptation_policy, previews, and provenance are ignored because their persisted equivalents already live in source_metadata/design_metadata.",
    },
    templates: [...selected],
  };
}

export async function ingestRgeNewsletterCatalog({
  targetCount = 50,
  pageSize = 50,
  maxPages = DEFAULT_MAX_PAGES,
  concurrency = 5,
  retries = 3,
  timeoutMs = 20_000,
  baseDelayMs = 400,
  checkpointEveryPages = 5,
  resumeCatalog = null,
  onCheckpoint = null,
  baseUrl = RGE_BASE_URL,
  capturedAt = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  sleepImpl,
  logger = console,
} = {}) {
  const collectAll = targetCount === null || targetCount === "all";
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
    maximum: 100,
  });
  const pageLimit = clampInteger(maxPages, {
    name: "maxPages",
    minimum: 1,
    maximum: 1_000,
  });
  const parallelism = clampInteger(concurrency, {
    name: "concurrency",
    minimum: 1,
    maximum: 20,
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
  const checkpointInterval = clampInteger(checkpointEveryPages, {
    name: "checkpointEveryPages",
    minimum: 1,
    maximum: 100,
  });
  if (onCheckpoint !== null && typeof onCheckpoint !== "function") {
    throw new TypeError("onCheckpoint must be a function");
  }
  const origin = new URL(baseUrl).origin;
  // Oldest-first pagination is stable while new emails are published: new
  // records append instead of shifting offsets beneath a long-running crawl.
  const sourceOrder = collectAll ? "asc" : "desc";
  const resumedCatalog = resumeCatalog ? validateCatalog(resumeCatalog) : null;
  const selected = resumedCatalog ? [...resumedCatalog.templates] : [];
  if (!collectAll && selected.length > target) {
    throw new Error(
      `Resume catalog already contains ${selected.length} templates, exceeding target ${target}`,
    );
  }
  const previousTemplateCount = selected.length;
  const resumed = Boolean(resumedCatalog);
  const seen = new Set(selected.map(referenceSourceSlug).filter(Boolean));
  const currentSourceSlugs = new Set();
  const catalogIds = new Set(selected.map((item) => item.catalog_id));
  const templateSlugs = new Set(selected.map((item) => item.slug));
  const sourceKeys = new Set(selected.map(referenceSourceKey).filter(Boolean));
  const failures = dedupeDiagnostics(
    resumedCatalog?.harvest?.detail_failures,
    (item) =>
      `${sourceSlugValue(item?.slug)}:${item?.status ?? ""}:${item?.message ?? ""}`,
  );
  const rejected = dedupeDiagnostics(
    resumedCatalog?.harvest?.quality_rejections,
    (item) => sourceSlugValue(item?.slug),
  );
  const warnings = dedupeDiagnostics(
    resumedCatalog?.harvest?.quality_warnings,
    (item) => sourceSlugValue(item?.slug),
  );
  if (!collectAll) {
    for (const item of rejected) {
      const slug = sourceSlugValue(item?.slug);
      if (slug) seen.add(slug);
    }
  }
  let pagesFetched = 0;
  let summariesFetched = 0;
  let totalAvailable = null;
  let lastHasMore = true;
  let duplicateSummariesSkipped = 0;
  let duplicateDetailsSkipped = 0;
  let staleResumeReferencesPruned = 0;

  const makeEnvelope = ({ complete = false } = {}) =>
    catalogEnvelope({
      origin,
      capturedAt,
      collectAll,
      target,
      selected,
      pagesFetched,
      summariesFetched,
      totalAvailable,
      failures,
      rejected,
      warnings,
      pageSize: perPage,
      pageLimit,
      parallelism,
      retryLimit,
      timeout,
      resumed,
      previousTemplateCount,
      duplicateSummariesSkipped,
      duplicateDetailsSkipped,
      sourceUniqueSummaries: currentSourceSlugs.size,
      staleResumeReferencesPruned,
      paginationExhausted: !lastHasMore,
      complete,
      checkpointEveryPages: checkpointInterval,
      sourceOrder,
    });

  async function checkpoint() {
    if (!onCheckpoint) return;
    const partialCatalog = makeEnvelope();
    validateCatalog(partialCatalog);
    await onCheckpoint(partialCatalog, {
      pagesFetched,
      templateCount: selected.length,
    });
  }

  const retryOptions = {
    fetchImpl,
    retries: retryLimit,
    timeoutMs: timeout,
    baseDelayMs,
    ...(sleepImpl ? { sleepImpl } : {}),
    onRetry: ({ attempt, delayMs, error, url }) => {
      logger.warn?.(
        `Retry ${attempt} in ${delayMs}ms after ${error.message} (${new URL(url).pathname})`,
      );
    },
  };

  for (
    let page = 0;
    page < pageLimit && (collectAll || selected.length < target) && lastHasMore;
    page += 1
  ) {
    const listingUrl = searchUrl({
      baseUrl: origin,
      page,
      pageSize: perPage,
      order: sourceOrder,
    });
    logger.info?.(
      `Fetching newsletter summaries page ${page + 1}/${pageLimit}`,
    );
    const listing = await fetchJsonWithRetry(listingUrl, retryOptions);
    pagesFetched += 1;
    const summaries = Array.isArray(listing?.emails) ? listing.emails : [];
    summariesFetched += summaries.length;
    const reportedTotal = Number(listing?.pagination?.total);
    totalAvailable = Number.isInteger(reportedTotal)
      ? reportedTotal
      : totalAvailable;
    if (typeof listing?.pagination?.hasMore === "boolean") {
      lastHasMore = listing.pagination.hasMore;
    } else if (Number.isInteger(totalAvailable)) {
      const offset = Number(listing?.pagination?.offset ?? page * perPage);
      const limit = Number(listing?.pagination?.limit ?? perPage);
      lastHasMore = offset + limit < totalAvailable;
    } else {
      lastHasMore = summaries.length === perPage;
    }

    const freshSummaries = summaries.filter((summary) => {
      const slug = sourceSlugValue(summary?.slug);
      if (slug) currentSourceSlugs.add(slug);
      if (!slug || seen.has(slug)) {
        duplicateSummariesSkipped += 1;
        return false;
      }
      seen.add(slug);
      return true;
    });

    const details = await mapConcurrent(
      freshSummaries,
      parallelism,
      async (summary) => {
        const slug = sourceSlugValue(summary.slug);
        try {
          const response = await fetchJsonWithRetry(
            detailUrl(origin, slug),
            retryOptions,
          );
          if (!response?.email || typeof response.email !== "object") {
            throw new Error("Detail response did not contain an email object");
          }
          return { summary, detail: response.email };
        } catch (error) {
          failures.push(publicError(error, slug));
          logger.warn?.(
            `Detail unavailable for ${slug}; retaining summary-only reference: ${error.message}`,
          );
          return { summary, detail: summary, detailError: error };
        }
      },
    );

    for (const candidate of details) {
      if (!candidate || (!collectAll && selected.length >= target)) continue;
      const quality = assessReferenceQuality(
        candidate.summary,
        candidate.detail,
      );
      if (!quality.eligible) {
        const diagnostic = {
          slug: sourceSlugValue(
            candidate.detail?.slug,
            candidate.summary?.slug,
          ),
          reasons: quality.rejection_reasons,
        };
        if (!collectAll) {
          rejected.push(diagnostic);
          continue;
        }
        warnings.push(diagnostic);
      }
      const reference = normalizeReference(
        candidate.summary,
        candidate.detail,
        {
          capturedAt,
        },
      );
      const sourceKey = referenceSourceKey(reference);
      if (
        catalogIds.has(reference.catalog_id) ||
        templateSlugs.has(reference.slug) ||
        sourceKeys.has(sourceKey)
      ) {
        duplicateDetailsSkipped += 1;
        continue;
      }
      catalogIds.add(reference.catalog_id);
      templateSlugs.add(reference.slug);
      sourceKeys.add(sourceKey);
      selected.push(reference);
    }

    logger.info?.(
      collectAll
        ? `Selected ${selected.length} high-quality newsletter references so far`
        : `Selected ${selected.length}/${target} high-quality newsletter references`,
    );
    if (summaries.length === 0) lastHasMore = false;
    if (
      onCheckpoint &&
      lastHasMore &&
      pagesFetched % checkpointInterval === 0
    ) {
      await checkpoint();
    }
  }

  const stoppedAtPageLimit = pagesFetched >= pageLimit && lastHasMore;
  if (collectAll && stoppedAtPageLimit) {
    await checkpoint();
    const error = new Error(
      `Exhaustive harvest reached maxPages=${pageLimit} while the source still reported more results`,
    );
    error.partial = makeEnvelope();
    throw error;
  }

  // A resumable exhaustive capture is also a current inventory, not an
  // ever-growing union. Once pagination reaches the authoritative end, remove
  // identities that existed in the checkpoint but no longer appear in the
  // source listing. We only prune after a complete scan; interruption and page
  // bounds preserve the last checkpoint fail-closed.
  if (collectAll && resumed && !lastHasMore) {
    const current = selected.filter((reference) =>
      currentSourceSlugs.has(referenceSourceSlug(reference)),
    );
    staleResumeReferencesPruned = selected.length - current.length;
    if (staleResumeReferencesPruned > 0) {
      selected.splice(0, selected.length, ...current);
      logger.info?.(
        `Pruned ${staleResumeReferencesPruned} references no longer present in the source inventory`,
      );
    }
  }

  if (
    collectAll &&
    Number.isInteger(totalAvailable) &&
    selected.length !== totalAvailable
  ) {
    await checkpoint();
    const error = new Error(
      `Exhaustive harvest retained ${selected.length} unique references, but the source reported ${totalAvailable}`,
    );
    error.partial = makeEnvelope();
    throw error;
  }

  if (!collectAll && selected.length < target) {
    await checkpoint();
    const error = new Error(
      `Only ${selected.length} eligible newsletter references were found; target was ${target}`,
    );
    error.partial = makeEnvelope();
    throw error;
  }

  const catalog = makeEnvelope({ complete: true });
  validateCatalog(catalog);
  return catalog;
}

function* catalogJsonChunks(catalog) {
  const metadata = { ...catalog };
  delete metadata.templates;
  const metadataJson = JSON.stringify(metadata, null, 2);
  yield `${metadataJson.slice(0, -2)},\n  "templates": [\n`;
  for (let index = 0; index < catalog.templates.length; index += 1) {
    // Indent only after JSON's structural LF characters. A multiline regular
    // expression also treats U+2028/U+2029 inside JSON strings as line
    // boundaries and would silently inject spaces into captured HTML.
    const encoded = JSON.stringify(catalog.templates[index], null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    yield `${index === 0 ? "" : ",\n"}${encoded}`;
  }
  yield "\n  ]\n}\n";
}

async function writeStreamAtomically(
  absolutePath,
  source,
  { gzip = false } = {},
) {
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    if (gzip) {
      await pipeline(
        source,
        createGzip({ level: 9 }),
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
    } else {
      await pipeline(
        source,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
    }
    const handle = await open(temporaryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch((unlinkError) => {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }
}

async function loadGzipCatalog(absolutePath) {
  // writeCatalog intentionally writes templates last. Parse that array one
  // object at a time so resume does not hold the compressed bytes, inflated
  // bytes, complete JSON string, and parsed catalog in memory simultaneously.
  const templatesMarker = ',\n  "templates": [\n';
  const decoder = new TextDecoder();
  const templates = [];
  let header = "";
  let metadata = null;
  let currentTemplate = "";
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let arrayClosed = false;

  function parseTemplateBody(text) {
    let segmentStart = objectDepth > 0 ? 0 : -1;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (objectDepth === 0) {
        if (arrayClosed) {
          if (character !== "}" && !/\s/.test(character)) {
            throw new Error("Unexpected data after catalog templates array");
          }
          continue;
        }
        if (character === "{") {
          objectDepth = 1;
          inString = false;
          escaped = false;
          segmentStart = index;
        } else if (character === "]") {
          arrayClosed = true;
        } else if (character !== "," && !/\s/.test(character)) {
          throw new Error(
            `Invalid catalog template array at template ${templates.length + 1}`,
          );
        }
        continue;
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        objectDepth += 1;
      } else if (character === "}") {
        objectDepth -= 1;
        if (objectDepth === 0) {
          currentTemplate += text.slice(segmentStart, index + 1);
          let template;
          try {
            template = JSON.parse(currentTemplate);
          } catch (error) {
            throw new Error(
              `Invalid catalog template ${templates.length + 1}: ${error.message}`,
            );
          }
          templates.push(template);
          if (templates.length > MAX_CATALOG_TEMPLATES) {
            throw new Error(
              `Catalog exceeds the ${MAX_CATALOG_TEMPLATES} template safety bound`,
            );
          }
          currentTemplate = "";
          segmentStart = -1;
        }
      }
    }
    if (objectDepth > 0) {
      currentTemplate += text.slice(segmentStart);
    }
  }

  function consume(text) {
    if (!metadata) {
      header += text;
      if (Buffer.byteLength(header, "utf8") > MAX_CATALOG_METADATA_BYTES) {
        throw new Error(
          `Catalog metadata exceeded ${MAX_CATALOG_METADATA_BYTES} bytes`,
        );
      }
      const markerIndex = header.indexOf(templatesMarker);
      if (markerIndex < 0) return;
      try {
        metadata = JSON.parse(`${header.slice(0, markerIndex)}\n}`);
      } catch (error) {
        throw new Error(`Invalid catalog metadata: ${error.message}`);
      }
      text = header.slice(markerIndex + templatesMarker.length);
      header = "";
    }
    parseTemplateBody(text);
  }

  const gunzip = createGunzip();
  const compressed = createReadStream(absolutePath);
  compressed.on("error", (error) => gunzip.destroy(error));
  const input = compressed.pipe(gunzip);
  for await (const chunk of input) {
    consume(decoder.decode(chunk, { stream: true }));
  }
  consume(decoder.decode());
  if (!metadata) throw new Error("Catalog did not contain a templates array");
  if (objectDepth !== 0 || currentTemplate) {
    throw new Error("Catalog ended inside a template object");
  }
  if (!arrayClosed) throw new Error("Catalog templates array was not closed");
  return { ...metadata, templates };
}

export async function loadCatalog(inputPath) {
  const absolutePath = resolve(inputPath);
  let catalog;
  try {
    catalog = absolutePath.endsWith(".gz")
      ? await loadGzipCatalog(absolutePath)
      : JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error(
      `Invalid catalog JSON at ${absolutePath}: ${error.message}`,
    );
  }
  return validateCatalog(catalog);
}

export function catalogCheckpointPath(outputPath) {
  const absolutePath = resolve(outputPath);
  if (absolutePath.endsWith(".json.gz")) {
    return `${absolutePath.slice(0, -".json.gz".length)}.checkpoint.json.gz`;
  }
  if (absolutePath.endsWith(".gz")) {
    return `${absolutePath.slice(0, -".gz".length)}.checkpoint.gz`;
  }
  if (absolutePath.endsWith(".json")) {
    return `${absolutePath.slice(0, -".json".length)}.checkpoint.json`;
  }
  return `${absolutePath}.checkpoint`;
}

/**
 * Resume always prefers the deterministic recovery checkpoint. A missing
 * checkpoint falls back to the canonical artifact for compatibility with
 * completed or pre-checkpoint captures. A corrupt checkpoint fails closed
 * instead of silently discarding newer recovery state.
 */
export async function loadResumeCatalog(outputPath) {
  const checkpointPath = catalogCheckpointPath(outputPath);
  try {
    return {
      catalog: await loadCatalog(checkpointPath),
      path: checkpointPath,
      checkpoint: true,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const canonicalPath = resolve(outputPath);
  return {
    catalog: await loadCatalog(canonicalPath),
    path: canonicalPath,
    checkpoint: false,
  };
}

export async function writeCatalog(outputPath, catalog) {
  validateCatalog(catalog);
  const absolutePath = resolve(outputPath);
  await writeStreamAtomically(
    absolutePath,
    Readable.from(catalogJsonChunks(catalog)),
    { gzip: absolutePath.endsWith(".gz") },
  );
  return absolutePath;
}

async function sha256File(inputPath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(inputPath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

export function catalogManifestPath(outputPath) {
  const absolutePath = resolve(outputPath);
  return absolutePath.endsWith(".json.gz")
    ? `${absolutePath.slice(0, -".json.gz".length)}.manifest.json`
    : `${absolutePath}.manifest.json`;
}

function catalogManifest(catalog, artifact) {
  return {
    schema_version: CATALOG_MANIFEST_SCHEMA_VERSION,
    generated_at: catalog.generated_at,
    artifact,
    source: catalog.source,
    harvest: catalog.harvest,
    templates: catalog.templates.map((reference) => ({
      catalog_id: reference.catalog_id,
      slug: reference.slug,
      name: reference.name,
      subject: reference.subject,
      source_provider: reference.source_provider,
      source_external_id: reference.source_external_id,
      source_url: reference.source_url,
      source_brand: reference.source_brand,
      thumbnail_url: reference.thumbnail_url,
      source_format: reference.design_metadata?.source_format ?? "metadata",
      quality_score: reference.quality_score,
      quality_warnings: reference.design_metadata?.quality_warnings ?? [],
      content_hash: reference.content_hash,
    })),
  };
}

export async function writeCatalogManifest(
  outputPath,
  catalog,
  {
    manifestPath = catalogManifestPath(outputPath),
    artifactFile = basename(resolve(outputPath)),
  } = {},
) {
  validateCatalog(catalog);
  const absoluteArtifactPath = resolve(outputPath);
  const artifactStat = await stat(absoluteArtifactPath);
  const manifest = catalogManifest(catalog, {
    file: artifactFile,
    encoding: absoluteArtifactPath.endsWith(".gz") ? "gzip" : "identity",
    bytes: artifactStat.size,
    content_hash: await sha256File(absoluteArtifactPath),
  });
  const absoluteManifestPath = resolve(manifestPath);
  await writeStreamAtomically(
    absoluteManifestPath,
    Readable.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  return absoluteManifestPath;
}

function parseCatalogManifest(text, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid catalog manifest JSON at ${manifestPath}: ${error.message}`,
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError(
      `Catalog manifest at ${manifestPath} must be an object`,
    );
  }
  return manifest;
}

function verifyManifestCatalogLinkage(manifest, catalog) {
  if (manifest.schema_version !== CATALOG_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported catalog manifest schema_version: ${manifest.schema_version ?? "missing"}`,
    );
  }
  if (manifest.generated_at !== catalog.generated_at) {
    throw new Error("Catalog manifest generated_at does not match artifact");
  }
  if (manifest.source?.provider !== catalog.source.provider) {
    throw new Error(
      `Catalog manifest source.provider must match artifact source.provider ${catalog.source.provider}`,
    );
  }
  if (manifest.harvest?.complete !== true) {
    throw new Error("Catalog manifest requires harvest.complete=true");
  }
  if (
    manifest.harvest.template_count !== catalog.harvest.template_count ||
    manifest.harvest.mode !== catalog.harvest.mode ||
    manifest.harvest.pagination_exhausted !==
      catalog.harvest.pagination_exhausted ||
    manifest.harvest.source_total_at_capture !==
      catalog.harvest.source_total_at_capture
  ) {
    throw new Error(
      "Catalog manifest harvest metadata does not match artifact",
    );
  }
  if (!Array.isArray(manifest.templates)) {
    throw new TypeError("Catalog manifest templates must be an array");
  }
  if (manifest.templates.length !== catalog.templates.length) {
    throw new Error("Catalog manifest template count does not match artifact");
  }

  const manifestCatalogIds = new Set();
  const manifestSlugs = new Set();
  const manifestSourceKeys = new Set();
  const linkedFields = [
    "catalog_id",
    "slug",
    "source_provider",
    "source_external_id",
    "content_hash",
  ];
  for (let index = 0; index < manifest.templates.length; index += 1) {
    const manifestReference = manifest.templates[index];
    const catalogReference = catalog.templates[index];
    if (
      !manifestReference ||
      typeof manifestReference !== "object" ||
      Array.isArray(manifestReference)
    ) {
      throw new TypeError(
        `Catalog manifest template ${index + 1} must be an object`,
      );
    }
    addUniqueIdentity(
      manifestCatalogIds,
      manifestReference.catalog_id,
      "manifest catalog_id",
    );
    addUniqueIdentity(manifestSlugs, manifestReference.slug, "manifest slug");
    addUniqueIdentity(
      manifestSourceKeys,
      referenceSourceKey(manifestReference),
      "manifest source provider/external ID",
    );
    for (const field of linkedFields) {
      if (manifestReference[field] !== catalogReference[field]) {
        throw new Error(
          `Catalog manifest template ${index + 1} ${field} does not match artifact`,
        );
      }
    }
  }
}

/**
 * Load a deployable artifact only after binding it to the exact adjacent
 * sidecar. This is the import boundary: no network request may precede it.
 */
export async function loadVerifiedCatalogBundle(
  inputPath,
  {
    manifestPath = catalogManifestPath(inputPath),
    expectedArtifactFile = basename(resolve(inputPath)),
  } = {},
) {
  const absoluteArtifactPath = resolve(inputPath);
  const absoluteManifestPath = resolve(manifestPath);
  let manifestText;
  try {
    manifestText = await readFile(absoluteManifestPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Catalog manifest is required at ${absoluteManifestPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  const manifest = parseCatalogManifest(manifestText, absoluteManifestPath);
  if (manifest.artifact?.file !== expectedArtifactFile) {
    throw new Error(
      `Catalog manifest artifact.file must be ${expectedArtifactFile}`,
    );
  }
  const expectedEncoding = absoluteArtifactPath.endsWith(".gz")
    ? "gzip"
    : "identity";
  if (manifest.artifact?.encoding !== expectedEncoding) {
    throw new Error(
      `Catalog manifest artifact.encoding must be ${expectedEncoding}`,
    );
  }
  const artifactStat = await stat(absoluteArtifactPath);
  if (
    !Number.isInteger(manifest.artifact?.bytes) ||
    manifest.artifact.bytes !== artifactStat.size
  ) {
    throw new Error("Catalog manifest artifact.bytes does not match artifact");
  }
  const artifactHash = await sha256File(absoluteArtifactPath);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(manifest.artifact?.content_hash ?? "") ||
    manifest.artifact.content_hash !== artifactHash
  ) {
    throw new Error(
      "Catalog manifest artifact.content_hash does not match artifact",
    );
  }

  const catalog = validateCatalogForImport(
    await loadCatalog(absoluteArtifactPath),
  );
  verifyManifestCatalogLinkage(manifest, catalog);
  return {
    catalog,
    manifest,
    artifactPath: absoluteArtifactPath,
    manifestPath: absoluteManifestPath,
  };
}

function stagedCatalogPath(absolutePath) {
  const suffix = absolutePath.endsWith(".json.gz")
    ? ".json.gz"
    : absolutePath.endsWith(".gz")
      ? ".gz"
      : absolutePath.endsWith(".json")
        ? ".json"
        : "";
  const stem = suffix ? absolutePath.slice(0, -suffix.length) : absolutePath;
  return `${stem}.staged-${process.pid}-${randomUUID()}${suffix}`;
}

async function linkIfPresent(sourcePath, backupPath) {
  try {
    await link(sourcePath, backupPath);
    return backupPath;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkIfPresent(inputPath) {
  if (!inputPath) return;
  await unlink(inputPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

/**
 * Stage and validate the artifact and sidecar before the two adjacent atomic
 * renames. The sidecar makes the brief two-file publication window fail
 * closed, and hard-link backups restore the prior verified bundle if either
 * promotion step fails.
 */
export async function writeCatalogBundle(outputPath, catalog) {
  validateCatalogForImport(catalog);
  const absoluteArtifactPath = resolve(outputPath);
  const absoluteManifestPath = catalogManifestPath(absoluteArtifactPath);
  const stagedArtifact = stagedCatalogPath(absoluteArtifactPath);
  const stagedManifest = `${absoluteManifestPath}.staged-${process.pid}-${randomUUID()}`;
  const backupArtifact = `${absoluteArtifactPath}.backup-${process.pid}-${randomUUID()}`;
  const backupManifest = `${absoluteManifestPath}.backup-${process.pid}-${randomUUID()}`;
  let priorArtifact = null;
  let priorManifest = null;
  let publicationStarted = false;

  try {
    await writeCatalog(stagedArtifact, catalog);
    await writeCatalogManifest(stagedArtifact, catalog, {
      manifestPath: stagedManifest,
      artifactFile: basename(absoluteArtifactPath),
    });
    await loadVerifiedCatalogBundle(stagedArtifact, {
      manifestPath: stagedManifest,
      expectedArtifactFile: basename(absoluteArtifactPath),
    });

    priorArtifact = await linkIfPresent(absoluteArtifactPath, backupArtifact);
    priorManifest = await linkIfPresent(absoluteManifestPath, backupManifest);
    publicationStarted = true;
    await rename(stagedArtifact, absoluteArtifactPath);
    await rename(stagedManifest, absoluteManifestPath);
    const verified = await loadVerifiedCatalogBundle(absoluteArtifactPath);
    publicationStarted = false;
    await unlinkIfPresent(priorArtifact);
    priorArtifact = null;
    await unlinkIfPresent(priorManifest);
    priorManifest = null;
    await unlinkIfPresent(catalogCheckpointPath(absoluteArtifactPath));
    return verified;
  } catch (error) {
    if (publicationStarted) {
      const rollbackErrors = [];
      try {
        if (priorArtifact) {
          await rename(priorArtifact, absoluteArtifactPath);
          priorArtifact = null;
        } else {
          await unlinkIfPresent(absoluteArtifactPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        if (priorManifest) {
          await rename(priorManifest, absoluteManifestPath);
          priorManifest = null;
        } else {
          await unlinkIfPresent(absoluteManifestPath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Catalog bundle publication and rollback failed",
        );
      }
    }
    throw error;
  } finally {
    await Promise.all([
      unlinkIfPresent(stagedArtifact),
      unlinkIfPresent(stagedManifest),
      unlinkIfPresent(priorArtifact),
      unlinkIfPresent(priorManifest),
    ]);
  }
}

export async function importCatalogBundleToPostwave(inputPath, options = {}) {
  const bundle = await loadVerifiedCatalogBundle(inputPath);
  const result = await importCatalogToPostwave(bundle.catalog, options);
  return { ...bundle, result };
}

export function parseArgs(argv) {
  const options = {
    targetCount: 50,
    pageSize: 50,
    maxPages: DEFAULT_MAX_PAGES,
    concurrency: 5,
    retries: 3,
    timeoutMs: 20_000,
    baseDelayMs: 400,
    checkpointEveryPages: 5,
    outputPath: DEFAULT_OUTPUT_PATH,
    resume: false,
    quiet: false,
    postwaveApiUrl: "",
    importCatalogPath: "",
  };
  let outputWasExplicit = false;
  let allWasRequested = false;
  let targetWasRequested = false;
  let resumeWasRequested = false;

  const valueFlags = new Map([
    ["--target", ["targetCount", 1, MAX_CATALOG_TEMPLATES]],
    ["--page-size", ["pageSize", 1, 100]],
    ["--max-pages", ["maxPages", 1, 1_000]],
    ["--concurrency", ["concurrency", 1, 20]],
    ["--retries", ["retries", 0, 10]],
    ["--timeout-ms", ["timeoutMs", 100, 120_000]],
    ["--base-delay-ms", ["baseDelayMs", 0, 30_000]],
    ["--checkpoint-every", ["checkpointEveryPages", 1, 100]],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (argument === "--all") {
      if (targetWasRequested) {
        throw new Error("--all and --target cannot be used together");
      }
      allWasRequested = true;
      options.targetCount = null;
      continue;
    }
    if (argument === "--resume") {
      options.resume = true;
      resumeWasRequested = true;
      continue;
    }
    if (argument === "--out") {
      const outputPath = argv[index + 1];
      if (!outputPath) throw new Error("--out requires a path");
      options.outputPath = outputPath;
      outputWasExplicit = true;
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
    const definition = valueFlags.get(argument);
    if (!definition) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    const [key, minimum, maximum] = definition;
    if (argument === "--target") {
      if (allWasRequested) {
        throw new Error("--all and --target cannot be used together");
      }
      targetWasRequested = true;
    }
    options[key] = clampInteger(value, { name: argument, minimum, maximum });
    index += 1;
  }
  if (allWasRequested && !outputWasExplicit) {
    options.outputPath = DEFAULT_FULL_OUTPUT_PATH;
  }
  if (options.importCatalogPath) {
    if (!options.postwaveApiUrl) {
      throw new Error(
        "--import-catalog requires --postwave-api-url so the destination is explicit",
      );
    }
    if (
      allWasRequested ||
      targetWasRequested ||
      resumeWasRequested ||
      outputWasExplicit
    ) {
      throw new Error(
        "--import-catalog cannot be combined with --all, --target, --resume, or --out",
      );
    }
  }
  return options;
}

function helpText() {
  return `Usage: node scripts/rge-newsletter-ingest.mjs [options]

Fetch and normalize Really Good Emails newsletter references for Moosewave.

Options:
  --target N          Strict-quality references to write (default: 50)
  --all               Retain every source summary and paginate to exhaustion
                      (defaults --out to ${DEFAULT_FULL_OUTPUT_PATH})
  --page-size N       Search results per API page (default: 50, max: 100)
  --max-pages N       Safety ceiling for API pages (default: ${DEFAULT_MAX_PAGES})
  --concurrency N     Concurrent detail requests (default: 5, max: 20)
  --retries N         Retries for transient requests (default: 3, max: 10)
  --timeout-ms N      Per-request timeout (default: 20000)
  --base-delay-ms N   Exponential retry base delay (default: 400)
  --checkpoint-every N  Checkpoint after N pages to a separate recovery file
                        (default: 5; never replaces the canonical bundle)
  --resume            Prefer the recovery checkpoint, then the --out artifact
  --out PATH          Output catalog path (default: ${DEFAULT_OUTPUT_PATH})
                      (.gz outputs are compressed while streaming)
  --postwave-api-url  Also ingest into this Moosewave API base URL
                      (reads bearer token from POSTWAVE_API_TOKEN)
  --import-catalog PATH
                      Import an existing .json or .json.gz artifact only after
                      verifying its exact adjacent manifest; requires
                      --postwave-api-url
  --quiet             Suppress progress output
  -h, --help          Show this help
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const logger = options.quiet
    ? { info() {}, warn() {} }
    : { info: console.log, warn: console.warn };
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
      `Imported ${catalog.harvest.template_count} validated newsletter references from ${resolve(options.importCatalogPath)}: ${result.created ?? 0} created, ${result.updated ?? 0} updated across ${result.batches ?? 0} batches\n`,
    );
    return;
  }
  let resumeCatalog = null;
  if (options.resume) {
    try {
      const resume = await loadResumeCatalog(options.outputPath);
      resumeCatalog = resume.catalog;
      logger.info?.(
        `Resuming from ${resumeCatalog.templates.length} catalog references at ${resume.path}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      logger.info?.(
        `No prior catalog found at ${options.outputPath}; starting fresh`,
      );
    }
  }
  const catalog = await ingestRgeNewsletterCatalog({
    ...options,
    resumeCatalog,
    onCheckpoint: async (partialCatalog) => {
      const checkpointPath = catalogCheckpointPath(options.outputPath);
      await writeCatalog(checkpointPath, partialCatalog);
      logger.info?.(
        `Checkpointed ${partialCatalog.harvest.template_count} references at ${checkpointPath}`,
      );
    },
    logger,
  });
  const { artifactPath: outputPath, manifestPath } = await writeCatalogBundle(
    options.outputPath,
    catalog,
  );
  process.stdout.write(
    `Wrote ${catalog.harvest.template_count} newsletter references to ${outputPath}\nManifest: ${manifestPath}\n`,
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
    console.error(`RGE newsletter ingest failed: ${error.message}`);
    process.exitCode = 1;
  });
}
