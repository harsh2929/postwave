import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AURA_BROWSE_URL,
  AURA_REST_URL,
  allowedAuraPreviewUrl,
  discoverAuraPublicAnonKey,
  ingestAuraTemplateCatalog,
  normalizeAuraReference,
  parseAuraArgs,
} from "./aura-template-ingest.mjs";
import {
  loadVerifiedCatalogBundle,
  validateCatalog,
  validateCatalogContentHashes,
} from "./rge-newsletter-ingest.mjs";

const CAPTURED_AT = "2026-08-03T06:30:00.000Z";
const USER_ONE = "11111111-1111-4111-8111-111111111111";
const USER_TWO = "22222222-2222-4222-8222-222222222222";
const PRIMARY_STORAGE =
  "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public";
const LEGACY_STORAGE =
  "https://hoirqrkdgbmvpwutwuwj-all.supabase.co/storage/v1/object/public";

function publicAnonKey(overrides = {}) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "supabase",
    ref: "hoirqrkdgbmvpwutwuwj",
    role: "anon",
    iat: 1,
    exp: 4_102_444_800,
    ...overrides,
  })}.public-signature`;
}

function htmlRow(id, slug, overrides = {}) {
  return {
    id,
    slug,
    title: `${slug} landing page`,
    description: `A polished ${slug} reference.`,
    tags: ["Technology", "Landing Page", "Minimal"],
    user_id: USER_ONE,
    username: USER_ONE,
    image_url: `${PRIMARY_STORAGE}/preview-images/${slug}.png`,
    views: 90,
    forks: 4,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-02T10:00:00.000Z",
    featured_at: "2026-08-02T12:00:00.000Z",
    category: "Web",
    featured: true,
    premium: false,
    private: false,
    share_source_code: true,
    price: null,
    purchase_url: null,
    ...overrides,
  };
}

function reactRow(id, slug, overrides = {}) {
  return {
    id,
    source_project_id: `project-${id}`,
    user_id: USER_TWO,
    slug,
    title: `${slug} React website`,
    description: `A ${slug} visual reference.`,
    template_type: "react-vite",
    preview_images: {
      image_320w: `${PRIMARY_STORAGE}/chat-thumbnails/${USER_TWO}/${slug}_320w.jpg`,
      image_800w: `${PRIMARY_STORAGE}/chat-thumbnails/${USER_TWO}/${slug}_800w.jpg`,
      image_1600w: `${PRIMARY_STORAGE}/chat-thumbnails/${USER_TWO}/${slug}_1600w.jpg`,
    },
    image_url: `${PRIMARY_STORAGE}/chat-thumbnails/${USER_TWO}/${slug}_800w.jpg`,
    category: "Animation",
    tags: ["Animated", "Dark", "Portfolio"],
    private: false,
    share_source_code: false,
    featured: true,
    featured_at: "2026-08-01T12:00:00.000Z",
    premium: true,
    price: 29,
    purchase_url: "https://checkout.example.test/template",
    view_count: 2_000,
    fork_count: 10,
    published_at: "2026-07-31T12:00:00.000Z",
    created_at: "2026-07-30T12:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

test("Aura preview URLs use an exact provider-bound storage allowlist", () => {
  assert.equal(
    allowedAuraPreviewUrl(
      `${PRIMARY_STORAGE}/preview-images/shared-code-previews/example.jpeg?t=1234`,
    ),
    `${PRIMARY_STORAGE}/preview-images/shared-code-previews/example.jpeg?t=1234`,
  );
  assert.equal(
    allowedAuraPreviewUrl(
      `${LEGACY_STORAGE}/chat-thumbnails/${USER_ONE}/example_800w.jpg`,
    ),
    `${LEGACY_STORAGE}/chat-thumbnails/${USER_ONE}/example_800w.jpg`,
  );
  for (const invalid of [
    "http://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/preview-images/example.png",
    "https://evil.example.test/storage/v1/object/public/preview-images/example.png",
    "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/render/image/public/preview-images/example.png",
    "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/example.png",
    `${PRIMARY_STORAGE}/preview-images/example.svg`,
    `${PRIMARY_STORAGE}/preview-images/example.png?token=secret`,
    `${PRIMARY_STORAGE}/preview-images/example.png?t=123&width=800`,
  ]) {
    assert.equal(allowedAuraPreviewUrl(invalid), null, invalid);
  }
});

test("normalizes Aura web templates as metadata-only, non-send-ready references", () => {
  const authorProfiles = new Map([
    [USER_ONE, { id: USER_ONE, full_name: "Ada Creator", slug: "ada" }],
  ]);
  const reference = normalizeAuraReference(
    "html",
    htmlRow(42, "Éditorial Digest", {
      views: 12,
      premium: true,
      image_url: `${LEGACY_STORAGE}/preview-images/editorial-digest.png?t=123`,
    }),
    { capturedAt: CAPTURED_AT, authorProfiles },
  );

  assert.equal(reference.catalog_id, "aura:html:42");
  assert.match(reference.slug, /^aura-html-editorial-digest-[a-f0-9]{10}$/);
  assert.equal(reference.source_provider, "aura_build");
  assert.equal(reference.source_external_id, "html:42");
  assert.equal(reference.body_html, "");
  assert.equal(reference.body_mjml, "");
  assert.equal(
    reference.content_hash,
    `sha256:${createHash("sha256").update("").digest("hex")}`,
  );
  assert.equal(reference.source_brand, "Ada Creator");
  assert.equal(reference.source_metadata.access_tier, "aura-pro");
  assert.equal(
    reference.source_metadata.aura_visibility,
    "public-featured-below-grid-threshold",
  );
  assert.equal(reference.source_metadata.aura_pulse_eligible, false);
  assert.equal(reference.design_metadata.source_code_collected, false);
  assert.equal(reference.adaptation_policy.send_ready, false);
  assert.ok(
    reference.design_metadata.quality_warnings.includes(
      "web-layout-requires-email-adaptation",
    ),
  );
  assert.doesNotMatch(JSON.stringify(reference), /<html|<script|<form/i);
});

test("normalizes paid React references without treating width variants as mobile layouts", () => {
  const reference = normalizeAuraReference(
    "react",
    reactRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "motion-studio"),
    { capturedAt: CAPTURED_AT },
  );
  assert.equal(reference.source_metadata.access_tier, "creator-paid");
  assert.equal(reference.source_metadata.aura_pulse_eligible, true);
  assert.equal(reference.previews.mobile, null);
  assert.equal(reference.previews.desktop.url, reference.thumbnail_url);
  assert.equal(reference.previews.card.url, reference.thumbnail_url);
  assert.equal(
    reference.source_metadata.preview_images.image_320w.endsWith("_320w.jpg"),
    true,
  );
  assert.ok(reference.tags.includes("access-creator-paid"));
  assert.ok(
    reference.design_metadata.quality_warnings.includes(
      "source-access-restricted",
    ),
  );
  assert.ok(
    reference.design_metadata.quality_warnings.includes(
      "source-remix-disabled",
    ),
  );
});

test("discovers only Aura's public anonymous browser key from same-origin scripts", async () => {
  const key = publicAnonKey();
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === AURA_BROWSE_URL) {
      return new Response(
        '<html><script type="module" src="/assets/index-test.js"></script><script src="https://evil.test/app.js"></script></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url === "https://www.aura.build/assets/index-test.js") {
      return new Response(`const publicClientKey = "${key}";`, {
        status: 200,
        headers: { "content-type": "application/javascript" },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  assert.equal(await discoverAuraPublicAnonKey({ fetchImpl, retries: 0 }), key);
  assert.deepEqual(calls, [
    AURA_BROWSE_URL,
    "https://www.aura.build/assets/index-test.js",
  ]);

  const serviceKey = publicAnonKey({ role: "service_role" });
  await assert.rejects(
    discoverAuraPublicAnonKey({
      retries: 0,
      fetchImpl: async (input) =>
        String(input) === AURA_BROWSE_URL
          ? new Response('<script src="/assets/index-test.js"></script>')
          : new Response(`const secret = "${serviceKey}";`),
    }),
    /found 0/,
  );
});

test("captures both public Aura template tables to exact exhaustion", async () => {
  const key = publicAnonKey();
  const htmlRows = [
    htmlRow(1, "new-reference", {
      featured_at: "2026-08-03T01:00:00.000Z",
      image_url: `${LEGACY_STORAGE}/preview-images/new-reference.png`,
    }),
    htmlRow(2, "low-view-reference", {
      views: 4,
      featured_at: "2026-08-02T01:00:00.000Z",
    }),
  ];
  const reactRows = [
    reactRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "react-reference", {
      featured_at: "2026-08-01T01:00:00.000Z",
    }),
  ];
  const profiles = [
    { id: USER_ONE, full_name: "HTML Author", slug: "html-author" },
    { id: USER_TWO, full_name: "React Author", slug: "react-author" },
  ];
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("apikey"), key);
    assert.equal(headers.has("authorization"), false);
    calls.push(url);
    const select = url.searchParams.get("select") ?? "";
    assert.doesNotMatch(select, /(?:^|,)code(?:,|$)/);
    if (url.pathname.endsWith("/public_author_profiles")) {
      return new Response(JSON.stringify(profiles), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const rows = url.pathname.endsWith("/shared_code")
      ? htmlRows
      : url.pathname.endsWith("/shared_react_projects")
        ? reactRows
        : null;
    if (!rows) throw new Error(`Unexpected Aura REST path ${url.pathname}`);
    const [startText, endText] = headers.get("range").split("-");
    const start = Number(startText);
    const end = Number(endText);
    const page = rows.slice(start, end + 1);
    const responseEnd = page.length > 0 ? start + page.length - 1 : start;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-range": `${start}-${responseEnd}/${rows.length}`,
      },
    });
  };

  const catalog = await ingestAuraTemplateCatalog({
    collectAll: true,
    pageSize: 2,
    maxPages: 2,
    retries: 0,
    anonKey: key,
    fetchImpl,
    capturedAt: CAPTURED_AT,
    logger: { info() {}, warn() {} },
  });

  assert.equal(catalog.source.provider, "aura_build");
  assert.equal(catalog.harvest.mode, "exhaustive");
  assert.equal(catalog.harvest.complete, true);
  assert.equal(catalog.harvest.pagination_exhausted, true);
  assert.equal(catalog.harvest.source_total_at_capture, 3);
  assert.deepEqual(catalog.harvest.source_counts, { html: 2, react: 1 });
  assert.deepEqual(catalog.harvest.aura_visibility, {
    "default-all-grid": 2,
    "public-featured-below-grid-threshold": 1,
  });
  assert.equal(catalog.harvest.source_code_collected, 0);
  assert.deepEqual(
    catalog.templates.map((template) => template.catalog_id),
    [
      "aura:html:1",
      "aura:html:2",
      "aura:react:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ],
  );
  assert.ok(catalog.templates.every((template) => template.body_html === ""));
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(validateCatalogContentHashes(catalog), catalog);
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/shared_code")).length,
    1,
  );
  assert.equal(
    calls.filter((url) => url.pathname.endsWith("/shared_react_projects"))
      .length,
    1,
  );
});

test("fails closed when the public inventory changes between pages", async () => {
  const key = publicAnonKey();
  let page = 0;
  await assert.rejects(
    ingestAuraTemplateCatalog({
      collectAll: true,
      pageSize: 1,
      maxPages: 3,
      retries: 0,
      anonKey: key,
      logger: { info() {}, warn() {} },
      fetchImpl: async (input, init = {}) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/public_author_profiles")) {
          return new Response("[]");
        }
        if (url.pathname.endsWith("/shared_react_projects")) {
          return new Response("[]", {
            headers: { "content-range": "0-0/0" },
          });
        }
        const current = page++;
        return new Response(
          JSON.stringify([htmlRow(current + 1, `row-${current}`)]),
          {
            headers: {
              "content-range": `${current}-${current}/${current === 0 ? 2 : 3}`,
            },
          },
        );
      },
    }),
    /inventory changed during capture/,
  );
});

test("parses exhaustive capture and explicit verified-import modes", () => {
  assert.deepEqual(parseAuraArgs([]), {
    targetCount: 50,
    collectAll: false,
    pageSize: 500,
    maxPages: 25,
    retries: 3,
    timeoutMs: 20_000,
    baseDelayMs: 400,
    outputPath: "scripts/fixtures/aura-template-catalog.json",
    quiet: false,
    postwaveApiUrl: "",
    importCatalogPath: "",
  });
  assert.equal(
    parseAuraArgs(["--all"]).outputPath,
    "scripts/fixtures/aura-template-catalog-full.json.gz",
  );
  assert.deepEqual(
    parseAuraArgs([
      "--import-catalog",
      "catalog.json.gz",
      "--postwave-api-url",
      "https://api.example.test",
    ]),
    {
      targetCount: 50,
      collectAll: false,
      pageSize: 500,
      maxPages: 25,
      retries: 3,
      timeoutMs: 20_000,
      baseDelayMs: 400,
      outputPath: "scripts/fixtures/aura-template-catalog.json",
      quiet: false,
      postwaveApiUrl: "https://api.example.test",
      importCatalogPath: "catalog.json.gz",
    },
  );
  assert.throws(() => parseAuraArgs(["--all", "--target", "10"]), /cannot/);
  assert.throws(
    () => parseAuraArgs(["--import-catalog", "catalog.json.gz"]),
    /requires --postwave-api-url/,
  );
});

test("Aura public API origin stays fixed", () => {
  const url = new URL(AURA_REST_URL);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "hoirqrkdgbmvpwutwuwj.supabase.co");
  assert.equal(url.pathname, "/rest/v1");
});

test("checked-in exhaustive Aura bundle is complete, attributed, and adaptation-only", async () => {
  const bundle = await loadVerifiedCatalogBundle(
    fileURLToPath(
      new URL("./fixtures/aura-template-catalog-full.json.gz", import.meta.url),
    ),
  );
  const { catalog, manifest } = bundle;
  assert.equal(catalog.source.provider, "aura_build");
  assert.equal(catalog.harvest.complete, true);
  assert.equal(catalog.harvest.pagination_exhausted, true);
  assert.equal(catalog.harvest.template_count, 7_863);
  assert.equal(catalog.harvest.source_total_at_capture, 7_863);
  assert.deepEqual(catalog.harvest.source_counts, { html: 7_759, react: 104 });
  assert.deepEqual(catalog.harvest.aura_visibility, {
    "default-all-grid": 5_376,
    "public-featured-below-grid-threshold": 2_487,
  });
  assert.equal(catalog.harvest.aura_pulse_eligible, 5_304);
  assert.equal(catalog.harvest.previews.allowlisted, 7_863);
  assert.equal(catalog.harvest.previews.legacy_host, 288);
  assert.equal(catalog.harvest.source_code_collected, 0);
  assert.equal(manifest.templates.length, 7_863);
  assert.equal(
    new Set(catalog.templates.map((template) => template.catalog_id)).size,
    7_863,
  );
  assert.equal(
    new Set(catalog.templates.map((template) => template.slug)).size,
    7_863,
  );
  assert.ok(
    catalog.templates.every(
      (template) =>
        template.source_provider === "aura_build" &&
        template.body_html === "" &&
        template.body_mjml === "" &&
        template.adaptation_policy?.send_ready === false,
    ),
  );
  assert.equal(validateCatalogContentHashes(catalog), catalog);
});

test("checked-in Aura starter catalog remains a verified 50-reference subset", async () => {
  const { catalog, manifest } = await loadVerifiedCatalogBundle(
    fileURLToPath(
      new URL("./fixtures/aura-template-catalog.json", import.meta.url),
    ),
  );
  assert.equal(catalog.harvest.mode, "target");
  assert.equal(catalog.harvest.template_count, 50);
  assert.equal(catalog.harvest.source_total_at_capture, 7_863);
  assert.equal(manifest.templates.length, 50);
});
