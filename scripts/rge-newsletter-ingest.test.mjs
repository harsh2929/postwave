import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessReferenceQuality,
  catalogCheckpointPath,
  catalogManifestPath,
  createCatalogImportBatches,
  createPostwaveImportPayload,
  fetchJsonWithRetry,
  ingestRgeNewsletterCatalog,
  importCatalogBundleToPostwave,
  importCatalogToPostwave,
  loadCatalog,
  loadResumeCatalog,
  loadVerifiedCatalogBundle,
  makePostwaveSlug,
  mapConcurrent,
  normalizeReference,
  parseArgs,
  stripHtml,
  validateCatalog,
  validateCatalogContentHashes,
  validateCatalogImportReadiness,
  writeCatalog,
  writeCatalogBundle,
  writeCatalogManifest,
} from "./rge-newsletter-ingest.mjs";

const CAPTURED_AT = "2026-07-17T00:00:00.000Z";

function emailHtml({ responsive = true } = {}) {
  return `<!doctype html><html><head><style>${
    responsive ? "@media (max-width: 600px) { table { width: 100%; } }" : ""
  }</style></head><body><table><tr><td>${"Newsletter content ".repeat(
    100,
  )}</td></tr></table></body></html>`;
}

function summary(slug, overrides = {}) {
  return {
    slug,
    title: `Title for ${slug}`,
    description: `<p>A useful &amp; polished ${slug} newsletter.</p>`,
    desktopScreenshot: {
      url: `https://images.example.test/${slug}.png`,
      width: 680,
      height: 2400,
    },
    mobileScreenshot: {
      url: `https://images.example.test/mobile/${slug}.png`,
      width: 360,
      height: 2400,
    },
    categories: [{ name: "Newsletter", slug: "newsletter" }],
    tags: [{ name: "Founder Letter", slug: "founder-letter" }],
    company: { name: "Example Co", slug: "example-co" },
    publishedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  };
}

function detail(slug, overrides = {}) {
  return {
    ...summary(slug),
    id: `source-${slug}`,
    html: emailHtml(),
    htmlSource: "published",
    createdAt: "2026-07-16T10:00:00.000Z",
    originalSubmission: {
      title: `Original ${slug}`,
      userName: "submitter",
      createdAt: "2026-07-16T09:00:00.000Z",
    },
    ...overrides,
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function deployableCatalog(
  slugs = ["bundle-one", "bundle-two"],
  { mode = "target", generatedAt = CAPTURED_AT } = {},
) {
  const templates = slugs.map((slug) =>
    normalizeReference(summary(slug), detail(slug), {
      capturedAt: generatedAt,
    }),
  );
  return {
    schema_version: "postwave.campaign-template-reference-catalog.v1",
    generated_at: generatedAt,
    source: {
      provider: "really_good_emails",
      collection_url: "https://reallygoodemails.com/categories/newsletter",
      search_api_url: "https://reallygoodemails.com/api/search/emails",
      category: "newsletter",
      sort: "published_at",
      order: mode === "exhaustive" ? "asc" : "desc",
    },
    harvest: {
      requested_count: mode === "exhaustive" ? "all" : templates.length,
      mode,
      complete: true,
      pagination_exhausted: mode === "exhaustive",
      resumed: false,
      previous_template_count: 0,
      template_count: templates.length,
      pages_fetched: 1,
      summaries_fetched: templates.length,
      source_total_at_capture: mode === "exhaustive" ? templates.length : 3_194,
      duplicate_summaries_skipped: 0,
      duplicate_details_skipped: 0,
      source_unique_summaries: templates.length,
      stale_resume_references_pruned: 0,
      detail_failures: [],
      quality_rejections: [],
      quality_warnings: [],
      bounds: {},
    },
    templates,
  };
}

function deployableAuraCatalog(slugs = ["hero-one", "hero-two"]) {
  const emptyContentHash = `sha256:${createHash("sha256")
    .update("")
    .digest("hex")}`;
  const templates = slugs.map((sourceSlug) => ({
    catalog_id: `aura:html:${sourceSlug}`,
    slug: `aura-html-${sourceSlug}`,
    name: `Aura ${sourceSlug}`,
    description: "Aura web-design reference requiring email adaptation.",
    category: "newsletter",
    goal: "newsletter",
    subject: `Aura ${sourceSlug}`,
    preview_text: "",
    body_html: "",
    body_mjml: "",
    variables: [],
    tags: ["source-aura", "web-design-reference"],
    template_kind: "reference",
    source_provider: "aura_build",
    source_external_id: `html:${sourceSlug}`,
    source_url: `https://aura.build/templates/${sourceSlug}`,
    source_brand: "Aura",
    thumbnail_url: "",
    source_captured_at: CAPTURED_AT,
    source_license_status: "personal-use-unreviewed",
    source_metadata: {
      source_slug: `html:${sourceSlug}`,
      source_artifact_type: "web_template",
    },
    industry: "",
    style: "web-design-reference",
    layout: "",
    design_metadata: {
      source_format: "metadata",
      quality_warnings: ["web-layout-requires-email-adaptation"],
    },
    review_status: "pending",
    quality_score: 0.7,
    content_hash: emptyContentHash,
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
  }));
  return {
    schema_version: "postwave.campaign-template-reference-catalog.v1",
    generated_at: CAPTURED_AT,
    source: {
      provider: "aura_build",
      collection_url: "https://www.aura.build/browse/components",
      category: "web-design-reference",
    },
    harvest: {
      requested_count: templates.length,
      mode: "target",
      complete: true,
      pagination_exhausted: false,
      template_count: templates.length,
      source_total_at_capture: 7_863,
    },
    templates,
  };
}

test("normalizes descriptive text and creates a stable Moosewave-safe slug", () => {
  assert.equal(
    stripHtml("<p>Hello&nbsp;<strong>world</strong> &amp; friends.</p>"),
    "Hello world & friends.",
  );

  const sourceSlug = `An extremely long newsletter source slug ${"segment ".repeat(20)}`;
  const first = makePostwaveSlug(sourceSlug);
  const second = makePostwaveSlug(sourceSlug);
  assert.equal(first, second);
  assert.match(first, /^[a-z][a-z0-9-]+$/);
  assert.ok(first.length <= 80);

  const collidingSourceSlugs = [
    "-",
    "-+-",
    "beautiful-photos-on-every-screen-",
    "beautiful-photos-on-every-screen",
    "Case-Sensitive",
    "case-sensitive",
  ];
  const postwaveSlugs = collidingSourceSlugs.map(makePostwaveSlug);
  assert.equal(new Set(postwaveSlugs).size, collidingSourceSlugs.length);
  assert.ok(postwaveSlugs.every((slug) => /^[a-z][a-z0-9-]{0,79}$/.test(slug)));
});

test("preserves punctuation-only source slugs as distinct catalog identities", () => {
  const first = normalizeReference(summary("-"), detail("-"), {
    capturedAt: CAPTURED_AT,
  });
  const second = normalizeReference(summary("-+-"), detail("-+-"), {
    capturedAt: CAPTURED_AT,
  });

  assert.equal(first.catalog_id, "rge:-");
  assert.equal(second.catalog_id, "rge:-+-");
  assert.equal(first.source_metadata.source_slug, "-");
  assert.equal(second.source_metadata.source_slug, "-+-");
  assert.notEqual(first.slug, second.slug);
  validateCatalog({
    schema_version: "postwave.campaign-template-reference-catalog.v1",
    harvest: { template_count: 2 },
    templates: [first, second],
  });
});

test("preserves existing percent-encoded bytes in source links", () => {
  const sourceSlug = "introducing-ui-animation%f0%9f%92%ab";
  const normalized = normalizeReference(
    summary(sourceSlug),
    detail(sourceSlug),
    {
      capturedAt: CAPTURED_AT,
    },
  );

  assert.equal(
    normalized.source_url,
    "https://reallygoodemails.com/emails/introducing-ui-animation%f0%9f%92%ab",
  );
  assert.equal(
    normalized.source_metadata.detail_api_url,
    "https://reallygoodemails.com/api/emails/introducing-ui-animation%f0%9f%92%ab",
  );
  assert.doesNotMatch(normalized.source_url, /%25f0/i);
});

test("normalizes a qualified source into the campaign-template import contract", () => {
  const sourceSummary = summary("founder-roundup");
  const sourceDetail = detail("founder-roundup");
  const normalized = normalizeReference(sourceSummary, sourceDetail, {
    capturedAt: CAPTURED_AT,
  });

  assert.deepEqual(
    {
      slug: normalized.slug,
      category: normalized.category,
      goal: normalized.goal,
      variables: normalized.variables,
    },
    {
      slug: "rge-founder-roundup",
      category: "newsletter",
      goal: "newsletter",
      variables: [],
    },
  );
  assert.equal(normalized.body_html, sourceDetail.html);
  assert.equal(
    normalized.preview_text,
    "A useful & polished founder-roundup newsletter.",
  );
  assert.equal(normalized.provenance.source_id, "source-founder-roundup");
  assert.equal(normalized.provenance.captured_at, CAPTURED_AT);
  assert.equal(normalized.template_kind, "reference");
  assert.equal(normalized.source_provider, "really_good_emails");
  assert.equal(normalized.source_external_id, "source-founder-roundup");
  assert.equal(normalized.source_captured_at, CAPTURED_AT);
  assert.equal(normalized.source_license_status, "personal-use-unreviewed");
  assert.equal(normalized.review_status, "pending");
  assert.equal(normalized.quality_score, 1);
  assert.match(normalized.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalized.adaptation_policy.send_ready, false);
  assert.ok(normalized.tags.includes("source-rge"));
  assert.ok(normalized.tags.includes("company-example-co"));
  assert.equal(normalized.design_metadata.html_features.responsive_css, true);
});

test("projects strict backend CreateInput fields without catalog-only metadata", () => {
  const normalized = normalizeReference(
    summary("strict-create"),
    detail("strict-create"),
    {
      capturedAt: CAPTURED_AT,
    },
  );
  const payload = createPostwaveImportPayload(normalized);

  assert.equal(payload.slug, "rge-strict-create");
  assert.equal(payload.body_html, normalized.body_html);
  assert.equal(payload.template_kind, "reference");
  assert.equal(payload.source_metadata.source_slug, "strict-create");
  assert.equal(payload.design_metadata.source_format, "html");
  assert.equal("catalog_id" in payload, false);
  assert.equal("adaptation_policy" in payload, false);
  assert.equal("previews" in payload, false);
  assert.equal("provenance" in payload, false);
});

test("quality gate rejects summaries without a usable screenshot or full HTML", () => {
  const sourceSummary = summary("broken", { desktopScreenshot: null });
  const sourceDetail = detail("broken", {
    desktopScreenshot: null,
    html: "<p>short</p>",
  });
  const quality = assessReferenceQuality(sourceSummary, sourceDetail);

  assert.equal(quality.eligible, false);
  assert.ok(quality.rejection_reasons.includes("missing_desktop_screenshot"));
  assert.ok(quality.rejection_reasons.includes("desktop_width_below_500"));
  assert.ok(quality.rejection_reasons.includes("source_html_below_1000_bytes"));
});

test("quality gate rejects active content instead of making it importable", () => {
  const sourceSummary = summary("active");
  const sourceDetail = detail("active", {
    html: emailHtml().replace(
      "</body>",
      '<script type="application/ld+json">{}</script></body>',
    ),
  });
  const quality = assessReferenceQuality(sourceSummary, sourceDetail);

  assert.equal(quality.eligible, false);
  assert.ok(quality.rejection_reasons.includes("active_content_detected"));
});

test("retries transient HTTP errors and honors Retry-After", async () => {
  let requests = 0;
  const delays = [];
  const result = await fetchJsonWithRetry("https://example.test/catalog", {
    retries: 2,
    baseDelayMs: 5,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) {
        return jsonResponse(
          { error: "busy" },
          { status: 503, headers: { "retry-after": "1" } },
        );
      }
      return jsonResponse({ ok: true });
    },
    sleepImpl: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests, 2);
  assert.deepEqual(delays, [1_000]);
});

test("does not retry a permanent HTTP error", async () => {
  let requests = 0;
  await assert.rejects(
    fetchJsonWithRetry("https://example.test/missing", {
      retries: 3,
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({ error: "missing" }, { status: 404 });
      },
      sleepImpl: async () => assert.fail("should not sleep"),
    }),
    (error) => error.status === 404 && error.retryable === false,
  );
  assert.equal(requests, 1);
});

test("retries requests aborted by the per-request timeout", async () => {
  let requests = 0;
  const result = await fetchJsonWithRetry("https://example.test/slow", {
    retries: 1,
    timeoutMs: 100,
    baseDelayMs: 0,
    fetchImpl: async (_url, { signal }) => {
      requests += 1;
      if (requests === 2) return jsonResponse({ recovered: true });
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(result, { recovered: true });
  assert.equal(requests, 2);
});

test("mapConcurrent never exceeds the requested worker bound", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
  assert.equal(maximumActive, 2);
});

test("ingest paginates past rejected entries and emits provenance-rich records", async () => {
  const requestedUrls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requestedUrls.push(url.href);
    if (url.pathname === "/api/search/emails") {
      const page = Number(url.searchParams.get("page"));
      assert.equal(url.searchParams.get("category"), "newsletter");
      assert.equal(url.searchParams.get("sort"), "published_at");
      if (page === 0) {
        return jsonResponse({
          emails: [
            summary("valid-one"),
            summary("rejected", { desktopScreenshot: null }),
          ],
          pagination: { limit: 2, offset: 0, total: 3, hasMore: true },
        });
      }
      return jsonResponse({
        emails: [summary("valid-two")],
        pagination: { limit: 2, offset: 2, total: 3, hasMore: false },
      });
    }
    if (url.pathname === "/api/emails/valid-one") {
      return jsonResponse({ email: detail("valid-one") });
    }
    if (url.pathname === "/api/emails/rejected") {
      return jsonResponse({
        email: detail("rejected", { desktopScreenshot: null }),
      });
    }
    if (url.pathname === "/api/emails/valid-two") {
      return jsonResponse({ email: detail("valid-two") });
    }
    return jsonResponse({ error: "not found" }, { status: 404 });
  };

  const catalog = await ingestRgeNewsletterCatalog({
    targetCount: 2,
    pageSize: 2,
    maxPages: 2,
    concurrency: 2,
    retries: 0,
    fetchImpl,
    capturedAt: CAPTURED_AT,
    logger: { info() {}, warn() {} },
  });

  assert.equal(catalog.harvest.template_count, 2);
  assert.equal(catalog.harvest.pages_fetched, 2);
  assert.equal(catalog.harvest.summaries_fetched, 3);
  assert.deepEqual(
    catalog.templates.map((template) => template.catalog_id),
    ["rge:valid-one", "rge:valid-two"],
  );
  assert.deepEqual(catalog.harvest.quality_rejections, [
    {
      slug: "rejected",
      reasons: [
        "missing_desktop_screenshot",
        "desktop_width_below_500",
        "desktop_height_below_800",
      ],
    },
  ]);
  assert.ok(requestedUrls.some((url) => url.includes("page=1")));
});

test("exhaustive ingest retains degraded and summary-only references to pagination exhaustion", async () => {
  const requestedUrls = [];
  const checkpoints = [];
  const sourceSummaries = [
    summary("old-valid"),
    summary("screenshot-only"),
    summary("active-source"),
    summary("detail-gone", { desktopScreenshot: null }),
  ];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    requestedUrls.push(url.href);
    if (url.pathname === "/api/search/emails") {
      assert.equal(url.searchParams.get("order"), "asc");
      const page = Number(url.searchParams.get("page"));
      return jsonResponse({
        emails: sourceSummaries.slice(page * 2, page * 2 + 2),
        pagination: {
          limit: 2,
          offset: page * 2,
          total: 4,
          hasMore: page === 0,
        },
      });
    }
    if (url.pathname === "/api/emails/old-valid") {
      return jsonResponse({ email: detail("old-valid") });
    }
    if (url.pathname === "/api/emails/screenshot-only") {
      return jsonResponse({ email: detail("screenshot-only", { html: "" }) });
    }
    if (url.pathname === "/api/emails/active-source") {
      return jsonResponse({
        email: detail("active-source", {
          html: emailHtml().replace("</body>", "<script>bad()</script></body>"),
        }),
      });
    }
    return jsonResponse({ error: "gone" }, { status: 404 });
  };

  const catalog = await ingestRgeNewsletterCatalog({
    targetCount: null,
    pageSize: 2,
    maxPages: 3,
    checkpointEveryPages: 1,
    concurrency: 2,
    retries: 0,
    fetchImpl,
    capturedAt: CAPTURED_AT,
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
    logger: { info() {}, warn() {} },
  });

  assert.equal(catalog.harvest.mode, "exhaustive");
  assert.equal(catalog.harvest.complete, true);
  assert.equal(catalog.harvest.pagination_exhausted, true);
  assert.equal(catalog.harvest.source_total_at_capture, 4);
  assert.equal(catalog.templates.length, 4);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].harvest.complete, false);
  assert.equal(checkpoints[0].templates.length, 2);
  assert.deepEqual(
    new Set(catalog.harvest.quality_warnings.map((item) => item.slug)),
    new Set(["screenshot-only", "active-source", "detail-gone"]),
  );
  assert.equal(catalog.harvest.detail_failures[0].slug, "detail-gone");
  assert.equal(
    catalog.templates.find((item) => item.catalog_id === "rge:active-source")
      .body_html,
    "",
  );
  assert.equal(
    catalog.templates.find((item) => item.catalog_id === "rge:active-source")
      .source_metadata.source_html_disposition,
    "quarantined-active-content",
  );
  assert.equal(
    catalog.templates.find((item) => item.catalog_id === "rge:detail-gone")
      .design_metadata.source_format,
    "metadata",
  );
  assert.equal(validateCatalog(catalog), catalog);
  assert.ok(requestedUrls.some((url) => url.includes("page=1")));
});

test("exhaustive resume scans from page zero, skips saved source slugs, and finishes exactly", async () => {
  const summaries = [summary("resume-one"), summary("resume-two")];
  let firstDetailRequests = 0;
  const firstFetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/search/emails") {
      return jsonResponse({
        emails: summaries.slice(0, 1),
        pagination: { limit: 1, offset: 0, total: 2, hasMore: true },
      });
    }
    firstDetailRequests += 1;
    return jsonResponse({ email: detail("resume-one") });
  };
  let checkpoint;
  await assert.rejects(
    ingestRgeNewsletterCatalog({
      targetCount: null,
      pageSize: 1,
      maxPages: 1,
      checkpointEveryPages: 1,
      retries: 0,
      fetchImpl: firstFetch,
      capturedAt: CAPTURED_AT,
      onCheckpoint: async (catalog) => {
        checkpoint = catalog;
      },
      logger: { info() {}, warn() {} },
    }),
    /reached maxPages=1/,
  );
  assert.equal(firstDetailRequests, 1);
  assert.equal(checkpoint.templates.length, 1);
  // Strict seed catalogs can record a rejected slug that exhaustive resume
  // must revisit and retain instead of treating it as already harvested.
  checkpoint.harvest.quality_rejections = [
    { slug: "resume-two", reasons: ["active_content_detected"] },
  ];
  checkpoint.templates.push(
    normalizeReference(
      summary("removed-from-source"),
      detail("removed-from-source"),
      {
        capturedAt: CAPTURED_AT,
      },
    ),
  );
  checkpoint.harvest.template_count = checkpoint.templates.length;

  const resumedDetailSlugs = [];
  const resumedFetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/api/search/emails") {
      const page = Number(url.searchParams.get("page"));
      return jsonResponse({
        emails: summaries.slice(page, page + 1),
        pagination: {
          limit: 1,
          offset: page,
          total: 2,
          hasMore: page === 0,
        },
      });
    }
    const slug = url.pathname.split("/").at(-1);
    resumedDetailSlugs.push(slug);
    return jsonResponse({ email: detail(slug) });
  };
  const catalog = await ingestRgeNewsletterCatalog({
    targetCount: null,
    pageSize: 1,
    maxPages: 3,
    retries: 0,
    resumeCatalog: checkpoint,
    fetchImpl: resumedFetch,
    capturedAt: CAPTURED_AT,
    logger: { info() {}, warn() {} },
  });

  assert.equal(catalog.templates.length, 2);
  assert.equal(catalog.harvest.resumed, true);
  assert.equal(catalog.harvest.previous_template_count, 2);
  assert.equal(catalog.harvest.duplicate_summaries_skipped, 1);
  assert.equal(catalog.harvest.source_unique_summaries, 2);
  assert.equal(catalog.harvest.stale_resume_references_pruned, 1);
  assert.equal(
    catalog.templates.some(
      (item) => item.catalog_id === "rge:removed-from-source",
    ),
    false,
  );
  assert.deepEqual(resumedDetailSlugs, ["resume-two"]);
});

test("exhaustive ingest fails closed when its page bound truncates pagination", async () => {
  await assert.rejects(
    ingestRgeNewsletterCatalog({
      targetCount: null,
      pageSize: 1,
      maxPages: 1,
      retries: 0,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === "/api/search/emails") {
          return jsonResponse({
            emails: [summary("bounded")],
            pagination: { limit: 1, offset: 0, total: 2, hasMore: true },
          });
        }
        return jsonResponse({ email: detail("bounded") });
      },
      logger: { info() {}, warn() {} },
    }),
    (error) =>
      /reached maxPages=1/.test(error.message) &&
      error.partial.harvest.complete === false,
  );
});

test("CLI parsing enforces request bounds", () => {
  assert.deepEqual(
    parseArgs(["--target", "75", "--concurrency", "4", "--quiet"]),
    {
      targetCount: 75,
      pageSize: 50,
      maxPages: 100,
      concurrency: 4,
      retries: 3,
      timeoutMs: 20_000,
      baseDelayMs: 400,
      checkpointEveryPages: 5,
      outputPath: "scripts/fixtures/rge-newsletter-catalog.json",
      resume: false,
      quiet: true,
      postwaveApiUrl: "",
      importCatalogPath: "",
    },
  );
  assert.throws(() => parseArgs(["--concurrency", "21"]), /between 1 and 20/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
  assert.deepEqual(
    parseArgs([
      "--postwave-api-url",
      "https://postwave.example.test",
      "--quiet",
    ]),
    {
      targetCount: 50,
      pageSize: 50,
      maxPages: 100,
      concurrency: 5,
      retries: 3,
      timeoutMs: 20_000,
      baseDelayMs: 400,
      checkpointEveryPages: 5,
      outputPath: "scripts/fixtures/rge-newsletter-catalog.json",
      resume: false,
      quiet: true,
      postwaveApiUrl: "https://postwave.example.test",
      importCatalogPath: "",
    },
  );
  assert.deepEqual(parseArgs(["--all", "--resume"]), {
    targetCount: null,
    pageSize: 50,
    maxPages: 100,
    concurrency: 5,
    retries: 3,
    timeoutMs: 20_000,
    baseDelayMs: 400,
    checkpointEveryPages: 5,
    outputPath: "scripts/fixtures/rge-newsletter-catalog-full.json.gz",
    resume: true,
    quiet: false,
    postwaveApiUrl: "",
    importCatalogPath: "",
  });
  assert.deepEqual(
    parseArgs([
      "--import-catalog",
      "scripts/fixtures/rge-newsletter-catalog-full.json.gz",
      "--postwave-api-url",
      "https://postwave.example.test",
      "--quiet",
    ]),
    {
      targetCount: 50,
      pageSize: 50,
      maxPages: 100,
      concurrency: 5,
      retries: 3,
      timeoutMs: 20_000,
      baseDelayMs: 400,
      checkpointEveryPages: 5,
      outputPath: "scripts/fixtures/rge-newsletter-catalog.json",
      resume: false,
      quiet: true,
      postwaveApiUrl: "https://postwave.example.test",
      importCatalogPath: "scripts/fixtures/rge-newsletter-catalog-full.json.gz",
    },
  );
  assert.throws(
    () =>
      parseArgs([
        "--import-catalog",
        "catalog.json.gz",
        "--postwave-api-url",
        "https://postwave.example.test",
        "--resume",
      ]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseArgs(["--import-catalog", "catalog.json.gz"]),
    /requires --postwave-api-url/,
  );
  assert.throws(
    () => parseArgs(["--all", "--target", "10"]),
    /cannot be used together/,
  );
});

test("bulk import posts the complete catalog to the idempotent endpoint", async () => {
  const bodyHTML = "";
  const catalog = {
    harvest: { mode: "target", complete: true, template_count: 1 },
    templates: [
      {
        slug: "rge-example",
        body_html: bodyHTML,
        content_hash: `sha256:${createHash("sha256")
          .update(bodyHTML)
          .digest("hex")}`,
      },
    ],
  };
  let captured;
  const result = await importCatalogToPostwave(catalog, {
    apiUrl: "https://postwave.example.test",
    token: "secret-token",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse({ created: 1, updated: 0, failed: 0, items: [] });
    },
  });
  assert.equal(
    captured.url,
    "https://postwave.example.test/api/v1/campaign-templates/import",
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(captured.init.body), {
    ...catalog,
    harvest: {
      ...catalog.harvest,
      import_batch: true,
      source_catalog_template_count: 1,
    },
  });
  assert.equal(result.created, 1);
});

test("catalog imports are split below both the 100-item and byte bounds", async () => {
  const bodyHTML = "x".repeat(700);
  const contentHash = `sha256:${createHash("sha256")
    .update(bodyHTML)
    .digest("hex")}`;
  const catalog = {
    harvest: { mode: "target", complete: true, template_count: 205 },
    templates: Array.from({ length: 205 }, (_, index) => ({
      slug: `rge-batch-${index}`,
      body_html: bodyHTML,
      content_hash: contentHash,
    })),
  };
  const itemBounded = createCatalogImportBatches(catalog);
  assert.deepEqual(
    itemBounded.map((batch) => batch.count),
    [100, 100, 5],
  );
  assert.ok(itemBounded.every((batch) => batch.bytes <= 7_500_000));

  const byteBounded = createCatalogImportBatches(
    { templates: catalog.templates.slice(0, 3) },
    { maxBytes: 1_900 },
  );
  assert.deepEqual(
    byteBounded.map((batch) => batch.count),
    [2, 1],
  );
  assert.ok(byteBounded.every((batch) => batch.bytes <= 1_900));

  let requests = 0;
  const result = await importCatalogToPostwave(catalog, {
    apiUrl: "https://postwave.example.test",
    token: "secret-token",
    fetchImpl: async (_url, init) => {
      requests += 1;
      const count = JSON.parse(init.body).templates.length;
      return jsonResponse({ created: count, updated: 0, failed: 0, items: [] });
    },
  });
  assert.equal(requests, 3);
  assert.equal(result.batches, 3);
  assert.equal(result.created, 205);
});

test("import rejects incomplete or truncated captures before any HTTP request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse({ created: 0, updated: 0, failed: 0, items: [] });
  };
  const incomplete = {
    harvest: { mode: "target", complete: false, template_count: 1 },
    templates: [{ slug: "rge-incomplete" }],
  };
  await assert.rejects(
    importCatalogToPostwave(incomplete, {
      apiUrl: "https://postwave.example.test",
      token: "secret-token",
      fetchImpl,
    }),
    /harvest\.complete=true/,
  );

  const truncated = {
    harvest: {
      mode: "exhaustive",
      complete: true,
      pagination_exhausted: false,
      template_count: 1,
      source_total_at_capture: 2,
    },
    templates: [{ slug: "rge-truncated" }],
  };
  assert.throws(
    () => validateCatalogImportReadiness(truncated),
    /pagination_exhausted=true/,
  );
  truncated.harvest.pagination_exhausted = true;
  assert.throws(
    () => validateCatalogImportReadiness(truncated),
    /template_count to match source_total_at_capture/,
  );
  await assert.rejects(
    importCatalogToPostwave(truncated, {
      apiUrl: "https://postwave.example.test",
      token: "secret-token",
      fetchImpl,
    }),
    /template_count to match source_total_at_capture/,
  );
  assert.equal(requests, 0);
});

test("content hash validation rejects HTML drift before direct import", async () => {
  const catalog = deployableCatalog(["hash-drift"]);
  catalog.templates[0].body_html += " ";
  assert.throws(
    () => validateCatalogContentHashes(catalog),
    /content_hash does not match body_html/,
  );

  let requests = 0;
  await assert.rejects(
    importCatalogToPostwave(catalog, {
      apiUrl: "https://postwave.example.test",
      token: "secret-token",
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({});
      },
    }),
    /content_hash does not match body_html/,
  );
  assert.equal(requests, 0);
});

test("import-only rejects a matching sidecar for incomplete exhaustive recovery state", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "postwave-rge-incomplete-import-"),
  );
  try {
    const outputPath = join(temporaryDirectory, "catalog.json.gz");
    const incomplete = deployableCatalog(["incomplete"], {
      mode: "exhaustive",
    });
    incomplete.harvest.complete = false;
    incomplete.harvest.pagination_exhausted = false;
    await writeCatalog(outputPath, incomplete);
    await writeCatalogManifest(outputPath, incomplete);

    let requests = 0;
    await assert.rejects(
      importCatalogBundleToPostwave(outputPath, {
        apiUrl: "https://postwave.example.test",
        token: "secret-token",
        fetchImpl: async () => {
          requests += 1;
          return jsonResponse({});
        },
      }),
      /harvest\.complete=true/,
    );
    assert.equal(requests, 0);

    incomplete.harvest.complete = true;
    incomplete.harvest.pagination_exhausted = true;
    incomplete.harvest.source_total_at_capture = 2;
    await writeCatalog(outputPath, incomplete);
    await writeCatalogManifest(outputPath, incomplete);
    await assert.rejects(
      importCatalogBundleToPostwave(outputPath, {
        apiUrl: "https://postwave.example.test",
        token: "secret-token",
        fetchImpl: async () => {
          requests += 1;
          return jsonResponse({});
        },
      }),
      /template_count to match source_total_at_capture/,
    );
    assert.equal(requests, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("interrupted checkpoints preserve the canonical bundle and resume first", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "postwave-rge-recovery-"),
  );
  try {
    const outputPath = join(temporaryDirectory, "catalog.json.gz");
    const canonical = deployableCatalog(["canonical-one", "canonical-two"]);
    const published = await writeCatalogBundle(outputPath, canonical);
    const canonicalArtifact = await readFile(published.artifactPath);
    const canonicalManifest = await readFile(published.manifestPath);

    const checkpoint = structuredClone(canonical);
    checkpoint.harvest.complete = false;
    checkpoint.harvest.pagination_exhausted = false;
    checkpoint.harvest.template_count = 1;
    checkpoint.templates = checkpoint.templates.slice(0, 1);
    const checkpointPath = catalogCheckpointPath(outputPath);
    assert.match(checkpointPath, /\.checkpoint\.json\.gz$/);
    await writeCatalog(checkpointPath, checkpoint);

    assert.deepEqual(await readFile(outputPath), canonicalArtifact);
    assert.deepEqual(
      await readFile(catalogManifestPath(outputPath)),
      canonicalManifest,
    );
    const resume = await loadResumeCatalog(outputPath);
    assert.equal(resume.checkpoint, true);
    assert.equal(resume.path, checkpointPath);
    assert.equal(resume.catalog.harvest.complete, false);
    assert.deepEqual(
      resume.catalog.templates.map((item) => item.catalog_id),
      ["rge:canonical-one"],
    );

    await writeCatalogBundle(outputPath, canonical);
    await assert.rejects(
      readFile(checkpointPath),
      (error) => error?.code === "ENOENT",
    );
    const fallback = await loadResumeCatalog(outputPath);
    assert.equal(fallback.checkpoint, false);
    assert.equal(fallback.catalog.harvest.complete, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("provider-specific Aura catalogs round-trip through the shared bundle contract", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "postwave-aura-bundle-"),
  );
  try {
    const outputPath = join(temporaryDirectory, "aura-catalog.json.gz");
    const catalog = deployableAuraCatalog();
    const written = await writeCatalogBundle(outputPath, catalog);
    const loaded = await loadVerifiedCatalogBundle(written.artifactPath);

    assert.equal(loaded.catalog.source.provider, "aura_build");
    assert.equal(loaded.manifest.source.provider, "aura_build");
    assert.deepEqual(
      loaded.catalog.templates.map((item) => item.source_provider),
      ["aura_build", "aura_build"],
    );
    assert.deepEqual(loaded.catalog, catalog);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("catalog bundles reject mixed providers and envelope-provider mismatches", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "postwave-provider-mismatch-"),
  );
  try {
    const mixed = deployableAuraCatalog();
    mixed.templates[1].source_provider = "really_good_emails";
    await assert.rejects(
      writeCatalogBundle(join(temporaryDirectory, "mixed.json.gz"), mixed),
      /source_provider must match catalog source\.provider aura_build/,
    );

    const envelopeMismatch = deployableAuraCatalog(["hero-one"]);
    envelopeMismatch.source.provider = "really_good_emails";
    await assert.rejects(
      writeCatalogBundle(
        join(temporaryDirectory, "envelope-mismatch.json.gz"),
        envelopeMismatch,
      ),
      /source_provider must match catalog source\.provider really_good_emails/,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("import-only verification requires an exact artifact sidecar before HTTP", async (t) => {
  async function withBundle(name, operation) {
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), `postwave-rge-${name}-`),
    );
    try {
      const outputPath = join(temporaryDirectory, "catalog.json.gz");
      const bundle = await writeCatalogBundle(outputPath, deployableCatalog());
      await operation(bundle);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  await t.test("missing sidecar", async () => {
    await withBundle("missing-manifest", async (bundle) => {
      await rm(bundle.manifestPath);
      let requests = 0;
      await assert.rejects(
        importCatalogBundleToPostwave(bundle.artifactPath, {
          apiUrl: "https://postwave.example.test",
          token: "secret-token",
          fetchImpl: async () => {
            requests += 1;
            return jsonResponse({});
          },
        }),
        /Catalog manifest is required/,
      );
      assert.equal(requests, 0);
    });
  });

  await t.test("schema, provider, and count mismatch", async () => {
    await withBundle("metadata-mismatch", async (bundle) => {
      const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
      manifest.schema_version = "unsupported.manifest.v0";
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /Unsupported catalog manifest schema_version/,
      );

      manifest.schema_version =
        "postwave.campaign-template-reference-manifest.v1";
      manifest.source.provider = "different_provider";
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /source\.provider/,
      );

      manifest.source.provider = "really_good_emails";
      manifest.harvest.template_count += 1;
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /harvest metadata does not match/,
      );
    });
  });

  await t.test("artifact filename, byte size, and hash mismatch", async () => {
    await withBundle("artifact-mismatch", async (bundle) => {
      const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
      manifest.artifact.file = "different.json.gz";
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /artifact\.file/,
      );

      manifest.artifact.file = "catalog.json.gz";
      manifest.artifact.bytes += 1;
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /artifact\.bytes/,
      );

      manifest.artifact.bytes -= 1;
      manifest.artifact.content_hash = `sha256:${"0".repeat(64)}`;
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /artifact\.content_hash/,
      );
    });
  });

  await t.test("identity and content-hash linkage mismatch", async () => {
    await withBundle("identity-mismatch", async (bundle) => {
      const manifest = JSON.parse(await readFile(bundle.manifestPath, "utf8"));
      manifest.templates[0].catalog_id = "rge:different";
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /catalog_id does not match/,
      );

      manifest.templates[0].catalog_id = "rge:bundle-one";
      manifest.templates[1].catalog_id = "rge:bundle-one";
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /Duplicate manifest catalog_id/,
      );

      manifest.templates[1].catalog_id = "rge:bundle-two";
      manifest.templates[0].content_hash = `sha256:${"f".repeat(64)}`;
      await writeFile(bundle.manifestPath, JSON.stringify(manifest));
      await assert.rejects(
        loadVerifiedCatalogBundle(bundle.artifactPath),
        /content_hash does not match/,
      );
    });
  });

  await t.test(
    "declared content hash does not match catalog HTML",
    async () => {
      const temporaryDirectory = await mkdtemp(
        join(tmpdir(), "postwave-rge-body-hash-mismatch-"),
      );
      try {
        const outputPath = join(temporaryDirectory, "catalog.json.gz");
        const catalog = deployableCatalog();
        catalog.templates[0].body_html += " ";
        await writeCatalog(outputPath, catalog);
        await writeCatalogManifest(outputPath, catalog);
        await assert.rejects(
          loadVerifiedCatalogBundle(outputPath),
          /content_hash does not match body_html/,
        );
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );
});

test("checked-in exhaustive artifact and sidecar form a verified deployable bundle", async () => {
  const artifactPath = fileURLToPath(
    new URL("./fixtures/rge-newsletter-catalog-full.json.gz", import.meta.url),
  );
  const bundle = await loadVerifiedCatalogBundle(artifactPath);
  assert.equal(bundle.catalog.harvest.complete, true);
  assert.equal(bundle.catalog.harvest.pagination_exhausted, true);
  assert.equal(bundle.catalog.harvest.template_count, 3_194);
  assert.equal(bundle.manifest.templates.length, 3_194);
});

test("gzip catalog writes are atomic, resumable, and accompanied by an HTML-free index", async () => {
  const checkedIn = JSON.parse(
    readFileSync(
      new URL("./fixtures/rge-newsletter-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const catalog = {
    ...checkedIn,
    harvest: { ...checkedIn.harvest, template_count: 2 },
    templates: checkedIn.templates.slice(0, 2),
  };
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "postwave-rge-"));
  try {
    const outputPath = join(temporaryDirectory, "catalog.json.gz");
    const absoluteOutputPath = await writeCatalog(outputPath, catalog);
    const loaded = await loadCatalog(absoluteOutputPath);
    assert.deepEqual(
      loaded.templates.map((item) => item.catalog_id),
      catalog.templates.map((item) => item.catalog_id),
    );

    const manifestPath = await writeCatalogManifest(
      absoluteOutputPath,
      catalog,
    );
    assert.equal(manifestPath, catalogManifestPath(absoluteOutputPath));
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.artifact.encoding, "gzip");
    assert.equal(manifest.templates.length, 2);
    assert.equal("body_html" in manifest.templates[0], false);
    assert.equal(manifestText.includes(catalog.templates[0].body_html), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("catalog serialization preserves Unicode line separators inside HTML exactly", async () => {
  const catalog = deployableCatalog(["unicode-line-separators"]);
  const html = `${emailHtml()}<p>Before\u2028    after U+2028</p><p>Before\u2029    after U+2029</p>`;
  catalog.templates[0].body_html = html;
  catalog.templates[0].content_hash = `sha256:${createHash("sha256")
    .update(html)
    .digest("hex")}`;
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "postwave-rge-unicode-roundtrip-"),
  );
  try {
    const outputPath = join(temporaryDirectory, "catalog.json.gz");
    await writeCatalog(outputPath, catalog);
    const loaded = await loadCatalog(outputPath);
    assert.equal(loaded.templates[0].body_html, html);
    assert.equal(
      loaded.templates[0].content_hash,
      catalog.templates[0].content_hash,
    );
    assert.equal(validateCatalogContentHashes(loaded), loaded);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("catalog validation rejects duplicate stable source identities", () => {
  const checkedIn = JSON.parse(
    readFileSync(
      new URL("./fixtures/rge-newsletter-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  const duplicate = structuredClone(checkedIn.templates[0]);
  duplicate.catalog_id = `${duplicate.catalog_id}-copy`;
  duplicate.slug = `${duplicate.slug}-copy`;
  duplicate.provenance.source_slug = `${duplicate.provenance.source_slug}-copy`;
  duplicate.source_metadata.source_slug = `${duplicate.source_metadata.source_slug}-copy`;
  const catalog = {
    ...checkedIn,
    harvest: { ...checkedIn.harvest, template_count: 2 },
    templates: [checkedIn.templates[0], duplicate],
  };
  assert.throws(
    () => validateCatalog(catalog),
    /Duplicate source provider\/external ID/,
  );
});

test("checked-in catalog contains 50 unique, backend-compatible references", () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL("./fixtures/rge-newsletter-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    catalog.schema_version,
    "postwave.campaign-template-reference-catalog.v1",
  );
  assert.equal(
    catalog.import_contract.target,
    "POST /api/v1/campaign-templates/import",
  );
  assert.equal(catalog.import_contract.cli.token_env, "POSTWAVE_API_TOKEN");
  assert.equal(catalog.harvest.template_count, 50);
  assert.equal(catalog.templates.length, 50);
  assert.equal(
    new Set(catalog.templates.map((item) => item.catalog_id)).size,
    50,
  );
  assert.equal(new Set(catalog.templates.map((item) => item.slug)).size, 50);
  assert.equal(validateCatalogContentHashes(catalog), catalog);

  for (const reference of catalog.templates) {
    const payload = createPostwaveImportPayload(reference);
    assert.match(payload.slug, /^[a-z][a-z0-9-]{0,79}$/);
    assert.ok(payload.name.length >= 1 && payload.name.length <= 200);
    assert.ok(payload.description.length <= 4_000);
    assert.ok(payload.subject.length <= 2_000);
    assert.ok(payload.preview_text.length <= 2_000);
    assert.ok(Buffer.byteLength(payload.body_html, "utf8") < 2_000_000);
    assert.equal(payload.template_kind, "reference");
    assert.equal(payload.source_provider, "really_good_emails");
    assert.equal(payload.source_license_status, "personal-use-unreviewed");
    assert.equal(payload.review_status, "pending");
    assert.ok(payload.quality_score >= 0 && payload.quality_score <= 1);
    assert.match(payload.content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      payload.design_metadata.html_features.active_content_detected,
      false,
    );
  }
});
