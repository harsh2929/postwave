#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { chromium } from "playwright";
import sharp from "sharp";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const RICH_CATALOG_PATH = resolve(
  REPO_ROOT,
  "scripts/fixtures/rge-newsletter-catalog.json",
);
const FULL_MANIFEST_PATH = resolve(
  REPO_ROOT,
  "scripts/fixtures/rge-newsletter-catalog-full.manifest.json",
);
const OUTPUT_DIR = resolve(REPO_ROOT, "docs/demos/newsletter-template-library");
let expectedCatalogSize = 0;
const DEMO_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const DEMO_USER_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_CAMPAIGN_ID = "77777777-7777-4777-8777-777777777777";
const DEMO_SAVED_TEMPLATE_ID = "66666666-6666-4666-8666-666666666666";
const DEMO_COLLECTION_ID = "44444444-4444-4444-8444-444444444444";
const DEMO_SAVED_SEARCH_ID = "33333333-3333-4333-8333-333333333333";
const FIXED_CREATED_AT = "2026-07-17T06:16:34.728Z";
const FIXED_UPDATED_AT = "2026-07-29T09:00:00.000Z";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const DEMO_ORDER = [
  "5f8bed60-2ecc-44f4-868c-f8bbe4502a9d", // AirDNA
  "14216f59-72ca-43f7-82a5-ff947ecd5382", // Mount Sapo
  "8936aa63-deb5-48d7-96b7-7019a7625bd6", // Sublimio
  "8027234f-2fdd-4d14-a7f8-24ac08032c5f", // Make
  "90b0d4db-c469-4958-8ecd-0ae1b752065a", // Visit Utah
  "5adcec1a-5181-4d9a-ae5c-a95f3304f534", // Rare Beauty
  "c6e3cce6-0b76-4e60-8d7d-61412fbae4cf", // Bloomberg
];

const GENERATED_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Signal Stack Weekly</title>
  </head>
  <body style="margin:0;background:#f3f1ff;color:#17152b;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f1ff;padding:28px 12px;">
      <tr><td align="center">
        <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="width:100%;max-width:620px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 16px 50px rgba(42,28,95,.14);">
          <tr>
            <td style="padding:24px 34px;background:#17152b;color:#ffffff;">
              <table role="presentation" width="100%"><tr>
                <td style="font-size:16px;font-weight:700;letter-spacing:.02em;">POSTWAVE / SIGNAL STACK</td>
                <td align="right" style="font-size:12px;color:#bdb6ed;">ISSUE 042 · JUL 17</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="padding:46px 42px 40px;background:linear-gradient(135deg,#5b45f6 0%,#8b5cf6 58%,#ec4899 140%);color:#ffffff;">
              <div style="font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#e9e5ff;">AI signals for product leaders</div>
              <h1 style="margin:16px 0 14px;font-size:44px;line-height:1.04;letter-spacing:-1.6px;">Three shifts worth your attention.</h1>
              <p style="margin:0;max-width:490px;font-size:17px;line-height:1.55;color:#f4f1ff;">A sharp weekly read on agents, interfaces, and the teams turning AI experiments into durable products.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 42px 10px;">
              <div style="font-size:12px;font-weight:700;letter-spacing:.16em;color:#6d5bd0;text-transform:uppercase;">The lead</div>
              <h2 style="margin:10px 0 12px;font-size:27px;line-height:1.2;letter-spacing:-.5px;">The interface is becoming the workflow</h2>
              <p style="margin:0;color:#5b5870;font-size:15px;line-height:1.65;">The best agent products no longer ask users to babysit a chat window. They expose progress, decisions, and review points—then make the next action obvious.</p>
              <a href="#" style="display:inline-block;margin-top:20px;padding:12px 18px;border-radius:999px;background:#17152b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;">Read the 4-minute brief →</a>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 42px 34px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td width="48%" valign="top" style="padding:20px;border:1px solid #e5e1fa;border-radius:16px;background:#faf9ff;">
                    <div style="font-size:11px;font-weight:700;color:#7c69dd;letter-spacing:.12em;">01 / BUILD</div>
                    <h3 style="margin:9px 0 7px;font-size:17px;line-height:1.25;">Design for checkpoints</h3>
                    <p style="margin:0;color:#666278;font-size:13px;line-height:1.55;">Make autonomy legible without making it feel slow.</p>
                  </td>
                  <td width="4%"></td>
                  <td width="48%" valign="top" style="padding:20px;border:1px solid #e5e1fa;border-radius:16px;background:#faf9ff;">
                    <div style="font-size:11px;font-weight:700;color:#7c69dd;letter-spacing:.12em;">02 / WATCH</div>
                    <h3 style="margin:9px 0 7px;font-size:17px;line-height:1.25;">Context gets portable</h3>
                    <p style="margin:0;color:#666278;font-size:13px;line-height:1.55;">MCP is moving useful context between the tools teams already use.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 42px;background:#17152b;color:#bdb8d3;font-size:12px;line-height:1.5;">
              Generated in Moosewave from two reference designs · Review links and claims before send
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

function json(response, status = 200, headers = {}) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(response),
  };
}

function jsonError(code, message, status = 400) {
  return json({ error: { code, message } }, status);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableUUID(label) {
  const hex = sha256(label).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function escapeXML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function facetValues(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key];
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, count }));
}

function tagFacetValues(items) {
  const counts = new Map();
  for (const item of items) {
    for (const tag of item.tags ?? []) {
      if (tag === "source-rge" || tag.startsWith("company-")) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 30)
    .map(([value, count]) => ({ value, count }));
}

function hostedAssetURL(assetBase, templateID, variant) {
  return `${assetBase}/${encodeURIComponent(templateID)}/${variant}.png`;
}

function sourceHasHTML(template) {
  return (
    Boolean(template.body_html?.trim()) ||
    template.source_format === "html" ||
    template.design_metadata?.stored_html_bytes > 0
  );
}

function mobilePreviewMetadata(template) {
  const mobile = template.source_metadata?.mobile_screenshot;
  return mobile && typeof mobile === "object" ? mobile : null;
}

function previewAssetsFor(template, assetBase) {
  const id = template.source_external_id;
  const mobile = mobilePreviewMetadata(template);
  const assets = [
    {
      variant: "card",
      url: hostedAssetURL(assetBase, id, "card"),
      mime_type: "image/png",
      width: 680,
      height: 850,
      size_bytes: 320_000,
      status: "ready",
    },
    {
      variant: "desktop",
      url: hostedAssetURL(assetBase, id, "desktop"),
      mime_type: "image/png",
      width: Number(template.design_metadata?.screenshot_width) || 680,
      height: Number(template.design_metadata?.screenshot_height) || 1_080,
      size_bytes: 640_000,
      status: "ready",
    },
  ];
  if (mobile?.url) {
    assets.push({
      variant: "mobile",
      url: hostedAssetURL(assetBase, id, "mobile"),
      mime_type: "image/png",
      width: Number(mobile.width) || 375,
      height: Number(mobile.height) || 1_080,
      size_bytes: 480_000,
      status: "ready",
    });
  }
  return assets;
}

function summaryFor(template, index, assetBase) {
  const hasSourceHTML = sourceHasHTML(template);
  const hasMobilePreview = Boolean(mobilePreviewMetadata(template)?.url);
  const reviewDecisionID = stableUUID(
    `postwave-demo-review:${template.source_external_id}`,
  );
  return {
    id: template.source_external_id,
    tenant_id: DEMO_TENANT_ID,
    name: template.name,
    description:
      template.description ||
      `${template.source_brand || "A leading brand"} newsletter design preserved as visual inspiration.`,
    subject: template.subject || template.name,
    goal: template.goal || "newsletter",
    category: template.category || "newsletter",
    tags: template.tags?.length ? template.tags : ["source-rge", "newsletter"],
    style: template.style || "editorial",
    industry: template.industry || "general",
    layout_archetype: template.layout || "long-form",
    thumbnail_url: hostedAssetURL(
      assetBase,
      template.source_external_id,
      "card",
    ),
    preview_assets: previewAssetsFor(template, assetBase),
    source: "ingested",
    provider: "Really Good Emails",
    source_provider: template.source_provider,
    source_brand: template.source_brand,
    template_kind: "reference",
    is_featured: index < 8 && index % 2 === 0,
    is_favorited: index === 1,
    usage_count: Math.max(2, 41 - index),
    review_status: "approved",
    source_license_status:
      template.source_license_status || "personal-use-unreviewed",
    reference_review_decision_id: reviewDecisionID,
    reference_reviewed_at: FIXED_UPDATED_AT,
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_adapt: true,
      can_use_directly: false,
      can_create_campaign: false,
      can_edit_directly: false,
      can_clone: false,
      can_delete: false,
      can_archive: false,
      can_restore: false,
      has_source_html: hasSourceHTML,
      has_source_mjml: false,
      has_desktop_preview: true,
      has_mobile_preview: hasMobilePreview,
      preview_kind: "screenshot",
    },
    recommended_action: "campaign_template_adapt",
    warnings: [
      ...(!hasSourceHTML
        ? [
            {
              code: "metadata_only_reference",
              message:
                "Only visual or metadata inspiration is available; generated output may not closely match the source.",
              recommended_action: "campaign_template_adapt",
            },
          ]
        : []),
      {
        code: "adaptation_only",
        message:
          "This reference may inspire an original design but its captured content cannot be used directly.",
        recommended_action: "campaign_template_adapt",
      },
    ],
  };
}

function detailFor(template, index, assetBase) {
  const sourceMetadata = template.source_metadata ?? {};
  return {
    ...summaryFor(template, index, assetBase),
    slug: template.slug,
    preview_text: template.preview_text,
    variables: template.variables ?? [],
    editable_regions: [],
    provenance: {
      source_url: template.source_url,
      source_name: template.source_brand,
      captured_at: template.source_captured_at || FIXED_CREATED_AT,
      review_decision: "adaptation_allowed_direct_use_denied",
    },
    license_status: template.source_license_status || "personal-use-unreviewed",
    source_url: template.source_url,
    source_metadata: {
      source_slug: sourceMetadata.source_slug || template.slug,
      published_at: sourceMetadata.published_at,
      source_format:
        template.source_format ||
        (sourceHasHTML(template) ? "html" : "screenshot"),
      source_html_disposition: sourceMetadata.source_html_disposition,
      has_mobile_preview: Boolean(mobilePreviewMetadata(template)?.url),
    },
    design_metadata: {
      source_format:
        template.source_format ||
        template.design_metadata?.source_format ||
        "screenshot",
      stored_html_bytes: sourceHasHTML(template) ? 1 : 0,
      has_desktop_preview: true,
      has_mobile_preview: Boolean(mobilePreviewMetadata(template)?.url),
      quality_score:
        template.quality_score || template.design_metadata?.quality_score,
    },
    version: 1,
    etag: `"demo-template-${template.source_external_id}-v1"`,
    created_at: template.source_captured_at || FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
  };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

async function listen(server, port = 0) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve the demo server port.");
  }
  return address.port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function encodeCursor(signature, lastID) {
  return Buffer.from(
    JSON.stringify({ version: 1, signature, last_id: lastID }),
  ).toString("base64url");
}

function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.signature !== "string" ||
      typeof parsed.last_id !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertNoCallerHTML(input, boundary) {
  const forbiddenKeys = new Set([
    "body_html",
    "body_mjml",
    "html",
    "mjml",
    "raw_html",
    "source_html",
  ]);
  const visit = (value, path = "$") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw new Error(
          `${boundary} received forbidden caller-authored content at ${path}.${key}`,
        );
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(input);
  for (const value of Object.values(input ?? {})) {
    if (
      typeof value === "string" &&
      /<!doctype|<html|<table|<mjml/i.test(value)
    ) {
      throw new Error(`${boundary} received an HTML document in its payload`);
    }
  }
}

function assertExactCommit(input, revision) {
  if (
    !Number.isInteger(input.revision) ||
    input.revision !== revision.revision
  ) {
    throw new Error(
      `Expected exact revision ${revision.revision}, received ${String(input.revision)}`,
    );
  }
  if (
    typeof input.output_hash !== "string" ||
    !HASH_PATTERN.test(input.output_hash) ||
    input.output_hash !== revision.output_hash
  ) {
    throw new Error("The exact 64-hex output hash was missing or mismatched");
  }
}

function outputForRevision(revision, instructions = "") {
  const refined = revision > 1;
  const bodyHTML = refined
    ? GENERATED_HTML.replace(
        "Three shifts worth your attention.",
        "Three signals to put to work this week.",
      )
        .replace(
          "A sharp weekly read on agents, interfaces, and the teams turning AI experiments into durable products.",
          "A cleaner, more actionable weekly read on agents, interfaces, and teams shipping durable AI products.",
        )
        .replace("padding:34px 42px 10px", "padding:42px 42px 14px")
    : GENERATED_HTML;
  return {
    name: refined ? "Signal Stack Weekly — Refined" : "Signal Stack Weekly",
    subject: refined
      ? "Three AI signals to put to work this week"
      : "Three AI shifts worth your attention",
    preview_text:
      "Agents, interfaces, and the teams shipping durable AI products.",
    body_html: bodyHTML,
    variables: { first_name: "Alex" },
    unresolved_variables: [],
    reference_template_ids: [],
    warnings: [
      refined
        ? `Refinement applied: ${instructions || "shorter hero and clearer spacing"}`
        : "Verify factual claims and destination links before scheduling.",
    ],
  };
}

function revisionFor(state, operation, instructions = "") {
  const revision = state.revisions.length + 1;
  const output = outputForRevision(revision, instructions);
  output.reference_template_ids = [...state.request.reference_template_ids];
  const outputHash = sha256(JSON.stringify(output));
  return {
    id: stableUUID(`${state.id}:revision:${revision}`),
    draft_id: state.id,
    revision,
    operation,
    ...(revision > 1 ? { base_revision: revision - 1 } : {}),
    output,
    output_hash: outputHash,
    validation: {
      status: "warn",
      checks: [
        {
          code: "safe_html",
          status: "pass",
          message: "Active content and unsafe URLs were removed.",
          repaired: false,
        },
        {
          code: "mobile_layout",
          status: "pass",
          message: "The 620px layout remains readable on narrow screens.",
          repaired: false,
        },
        {
          code: "review_links_and_claims",
          status: "warn",
          message: "Review factual claims and every destination link.",
          repaired: false,
        },
      ],
    },
    warnings: [
      {
        code: "manual_review_required",
        message:
          "Review factual claims, destination links, and legal footer details before use.",
        recommended_action: "review_design_revision",
      },
    ],
    created_at: revision === 1 ? FIXED_CREATED_AT : "2026-07-29T09:05:00.000Z",
  };
}

function designCapabilities(state) {
  const stable = ["ready", "saved", "campaign_created"].includes(state.status);
  return {
    can_refine:
      state.status === "ready" &&
      !state.savedTemplateID &&
      !state.createdCampaignID,
    can_retry: state.status === "failed",
    can_save: stable && !state.savedTemplateID,
    can_create_campaign: stable && !state.createdCampaignID,
    can_archive: !["queued", "generating", "archived"].includes(state.status),
  };
}

function designResponse(state) {
  const revision = state.revisions[state.revisions.length - 1];
  return {
    id: state.id,
    mode: state.request.mode,
    status: state.status,
    ...(state.request.source_template_id
      ? { source_template_id: state.request.source_template_id }
      : {}),
    reference_template_ids: [...state.request.reference_template_ids],
    current_revision: revision?.revision ?? 0,
    ...(revision ? { revision } : {}),
    attempt_count: state.attemptCount,
    ...(state.lastErrorCode
      ? {
          last_error_code: state.lastErrorCode,
          last_error_message: state.lastErrorMessage,
        }
      : {}),
    ...(state.savedTemplateID
      ? {
          saved_template_id: state.savedTemplateID,
          saved_revision: state.savedRevision,
        }
      : {}),
    ...(state.createdCampaignID
      ? {
          created_campaign_id: state.createdCampaignID,
          campaign_revision: state.campaignRevision,
        }
      : {}),
    capabilities: designCapabilities(state),
    recommended_action:
      state.status === "queued" || state.status === "generating"
        ? "wait"
        : state.status === "failed"
          ? "retry"
          : state.createdCampaignID
            ? "open_campaign"
            : state.savedTemplateID
              ? "create_campaign"
              : "review_revision",
    ...(state.status === "queued" || state.status === "generating"
      ? { retry_after_seconds: 1 }
      : {}),
    expires_at: "2099-12-31T23:59:59.000Z",
    created_at: FIXED_CREATED_AT,
    updated_at:
      state.revisions.length > 1
        ? "2026-07-29T09:05:00.000Z"
        : FIXED_UPDATED_AT,
    request: state.request,
  };
}

function completePendingDesign(state) {
  if (!state.pending) return;
  state.revisions.push(
    revisionFor(state, state.pending.operation, state.pending.instructions),
  );
  state.pending = null;
  state.status = "ready";
}

function buildCampaign(state, input) {
  const revision = state.revisions[state.revisions.length - 1];
  return {
    id: DEMO_CAMPAIGN_ID,
    tenant_id: DEMO_TENANT_ID,
    name: input.name || `${revision.output.name} campaign`,
    subject: input.subject || revision.output.subject,
    status: "draft",
    campaign_type: "regular",
    editor_mode: "html",
    preview_text: input.preview_text || revision.output.preview_text,
    body_html: revision.output.body_html,
    from_name: "Moosewave Studio",
    reply_to: "hello@postwave.local",
    content_blocks: [],
    variants: [],
    tracking_settings: {
      track_opens: true,
      track_clicks: true,
    },
    delivery_settings: {},
    ...(input.segment_id ? { segment_id: input.segment_id } : {}),
    ...(input.list_id ? { list_id: String(input.list_id) } : {}),
    ...(state.savedTemplateID
      ? { source_template_id: state.savedTemplateID }
      : {}),
    reference_template_ids: [...state.request.reference_template_ids],
    template_variables: input.variables || revision.output.variables,
    scheduled_at: null,
    sent_at: null,
    created_at: FIXED_UPDATED_AT,
    updated_at: FIXED_UPDATED_AT,
  };
}

async function fallbackPreview(template, variant) {
  const label = escapeXML(template.source_brand || "Moosewave inspiration");
  const accent = `#${sha256(template.source_external_id).slice(0, 6)}`;
  const width = variant === "mobile" ? 420 : 680;
  const height = variant === "card" ? 850 : 1_080;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${accent}"/>
          <stop offset="1" stop-color="#17152b"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="#f6f4ff"/>
      <rect x="34" y="34" width="${width - 68}" height="${height - 68}" rx="28" fill="white"/>
      <rect x="34" y="34" width="${width - 68}" height="280" rx="28" fill="url(#g)"/>
      <text x="68" y="110" fill="white" font-size="18" font-family="Arial" font-weight="700">${label}</text>
      <text x="68" y="185" fill="white" font-size="38" font-family="Arial" font-weight="700">Newsletter</text>
      <text x="68" y="230" fill="white" font-size="38" font-family="Arial" font-weight="700">inspiration</text>
      <rect x="68" y="360" width="${width - 136}" height="24" rx="12" fill="#dad6ee"/>
      <rect x="68" y="410" width="${width - 190}" height="18" rx="9" fill="#ebe8f6"/>
      <rect x="68" y="450" width="${width - 150}" height="18" rx="9" fill="#ebe8f6"/>
      <rect x="68" y="520" width="${width - 136}" height="210" rx="18" fill="#f0edff"/>
      <rect x="68" y="770" width="180" height="46" rx="23" fill="${accent}"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function buildDemoServer(templates, assetBase) {
  const allSummaries = templates.map((template, index) =>
    summaryFor(template, index, assetBase),
  );
  const summaryByID = new Map(allSummaries.map((item) => [item.id, item]));
  const templateByID = new Map(
    templates.map((template) => [template.source_external_id, template]),
  );
  const facets = {
    goals: facetValues(allSummaries, "goal"),
    categories: facetValues(allSummaries, "category"),
    styles: facetValues(allSummaries, "style"),
    industries: facetValues(allSummaries, "industry"),
    layouts: facetValues(allSummaries, "layout_archetype"),
    sources: [{ value: "ingested", count: allSummaries.length }],
    tags: tagFacetValues(allSummaries),
  };
  const designs = new Map();
  const campaigns = new Map();
  const createIdempotency = new Map();
  const recentViews = new Map();
  let demoCollection = {
    id: DEMO_COLLECTION_ID,
    name: "Launch-worthy shortlist",
    description: "Three references for the next editorial redesign.",
    template_ids: DEMO_ORDER.slice(0, 3),
    item_count: 3,
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
    version: 1,
    etag: `"campaign-template-collection:${DEMO_COLLECTION_ID}:v1"`,
  };
  const demoSavedSearch = {
    id: DEMO_SAVED_SEARCH_ID,
    name: "Minimal editorial picks",
    filters: {
      goal: "newsletter",
      style: allSummaries[0]?.style || "curated-editorial",
      kind: "reference",
      sort: "most_used",
    },
    created_at: FIXED_CREATED_AT,
    updated_at: FIXED_UPDATED_AT,
    version: 1,
    etag: `"campaign-template-saved-search:${DEMO_SAVED_SEARCH_ID}:v1"`,
  };
  const assetCache = new Map();
  const metrics = {
    requestLog: [],
    boundaryCommits: [],
    assetRequests: 0,
    violations: [],
  };

  const collectionResponse = () => ({
    ...demoCollection,
    items: demoCollection.template_ids
      .map((id) => summaryByID.get(id))
      .filter(Boolean),
  });

  const loadPreviewAsset = async (template, variant, timeoutMs = 6_500) => {
    const mobile = mobilePreviewMetadata(template);
    const upstreamURL =
      variant === "mobile" && mobile?.url ? mobile.url : template.thumbnail_url;
    const fetchUpstream =
      Boolean(upstreamURL) &&
      process.env.POSTWAVE_DEMO_FETCH_UPSTREAM_PREVIEWS === "1";
    const cacheKey = fetchUpstream
      ? `upstream:${upstreamURL}`
      : `fallback:${template.source_external_id}:${variant}`;
    if (!assetCache.has(cacheKey)) {
      assetCache.set(
        cacheKey,
        (async () => {
          if (fetchUpstream) {
            try {
              const parsed = new URL(upstreamURL);
              if (
                parsed.protocol !== "https:" ||
                parsed.username ||
                parsed.password
              ) {
                throw new Error("Unsafe upstream preview URL");
              }
              const upstream = await fetch(parsed, {
                headers: {
                  accept: "image/png,image/jpeg,image/webp,image/*;q=0.8",
                  "user-agent": "PostwaveDemoCapture/1.0",
                },
                redirect: "follow",
                // Fail over before the app proxy times out so every browser
                // request still receives a Moosewave-hosted image.
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (!upstream.ok) {
                throw new Error(`Preview fetch returned ${upstream.status}`);
              }
              const declaredLength = Number(
                upstream.headers.get("content-length") || 0,
              );
              if (
                Number.isFinite(declaredLength) &&
                declaredLength > 18 * 1024 * 1024
              ) {
                throw new Error("Preview image exceeds the demo size limit");
              }
              const body = Buffer.from(await upstream.arrayBuffer());
              if (body.length === 0 || body.length > 18 * 1024 * 1024) {
                throw new Error("Preview image is empty or too large");
              }
              return body;
            } catch {
              // The browser still receives a stable Moosewave-hosted fallback.
            }
          }
          return fallbackPreview(template, variant);
        })(),
      );
    }
    return assetCache.get(cacheKey);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const collectionDetailMatch = path.match(
      /^\/api\/v1\/campaign-template-collections\/([^/]+)$/,
    );
    const collectionItemsMatch = path.match(
      /^\/api\/v1\/campaign-template-collections\/([^/]+)\/items$/,
    );
    const savedSearchDetailMatch = path.match(
      /^\/api\/v1\/campaign-template-saved-searches\/([^/]+)$/,
    );
    const savedSearchResultsMatch = path.match(
      /^\/api\/v1\/campaign-template-saved-searches\/([^/]+)\/results$/,
    );
    let result;
    metrics.requestLog.push({
      method: request.method,
      path,
      search: url.search,
    });

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "content-type,authorization,idempotency-key,x-tenant-slug,x-postwave-role",
        "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      });
      response.end();
      return;
    }

    try {
      const assetMatch = path.match(
        /^\/api\/v1\/demo-assets\/([^/]+)\/(card|desktop|mobile)\.png$/,
      );
      if (request.method === "GET" && assetMatch) {
        const id = decodeURIComponent(assetMatch[1]);
        const template = templateByID.get(id);
        if (!template) {
          result = jsonError("asset_not_found", "Preview asset not found", 404);
        } else {
          metrics.assetRequests += 1;
          const body = await loadPreviewAsset(template, assetMatch[2]);
          response.writeHead(200, {
            "content-type": "image/png",
            "content-length": String(body.length),
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          });
          response.end(body);
          return;
        }
      } else if (path === "/healthz" || path === "/readyz") {
        result = json({ ok: true });
      } else if (path === "/api/v1/auth/me") {
        result = json({
          user_id: DEMO_USER_ID,
          tenant_id: DEMO_TENANT_ID,
          email: "demo@postwave.local",
          role: "owner",
          effective_role: "owner",
          auth_provider: "local-demo",
          email_verified: true,
          workspace_name: "Moosewave Demo",
          workspace_slug: "demo",
          mfa_required: false,
          mfa_satisfied: true,
        });
      } else if (path === "/api/v1/onboarding-progress") {
        result = json({
          steps: [],
          completed: 0,
          total: 0,
          percent: 100,
          all_done: true,
        });
      } else if (path === "/api/v1/notifications") {
        result = json({ items: [], unread_count: 0 });
      } else if (path === "/api/v1/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`event: ready\ndata: {"ok":true}\n\n`);
        request.on("close", () => response.end());
        return;
      } else if (
        request.method === "GET" &&
        path === "/api/v1/campaign-templates/search"
      ) {
        const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
        const scalarFilters = [
          ["goal", "goal"],
          ["category", "category"],
          ["style", "style"],
          ["industry", "industry"],
          ["layout", "layout_archetype"],
          ["kind", "template_kind"],
          ["provider", "source_provider"],
        ];
        let filtered = allSummaries.filter((item) => {
          if (q) {
            const haystack = [
              item.name,
              item.description,
              item.subject,
              item.style,
              item.industry,
              item.layout_archetype,
              item.source_brand,
              ...(item.tags ?? []),
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            if (!haystack.includes(q)) return false;
          }
          for (const [queryKey, itemKey] of scalarFilters) {
            const expected = url.searchParams.get(queryKey);
            if (expected && item[itemKey] !== expected) return false;
          }
          const source = url.searchParams.get("source");
          if (source === "mine") return false;
          if (source && source !== "all" && item.source !== source)
            return false;
          const tags = (url.searchParams.get("tags") ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (tags.some((tag) => !item.tags.includes(tag))) return false;
          if (
            url.searchParams.get("featured") === "true" &&
            !item.is_featured
          ) {
            return false;
          }
          if (
            url.searchParams.get("favorited") === "true" &&
            !item.is_favorited
          ) {
            return false;
          }
          return true;
        });
        const sort = url.searchParams.get("sort") || "recommended";
        if (sort === "name") {
          filtered = [...filtered].sort(
            (left, right) =>
              left.name.localeCompare(right.name) ||
              left.id.localeCompare(right.id),
          );
        } else if (sort === "most_used") {
          filtered = [...filtered].sort(
            (left, right) =>
              right.usage_count - left.usage_count ||
              left.id.localeCompare(right.id),
          );
        }
        const signature = sha256(
          JSON.stringify({
            q,
            goal: url.searchParams.get("goal") || "",
            category: url.searchParams.get("category") || "",
            style: url.searchParams.get("style") || "",
            industry: url.searchParams.get("industry") || "",
            layout: url.searchParams.get("layout") || "",
            kind: url.searchParams.get("kind") || "",
            provider: url.searchParams.get("provider") || "",
            source: url.searchParams.get("source") || "",
            tags: url.searchParams.get("tags") || "",
            featured: url.searchParams.get("featured") || "",
            favorited: url.searchParams.get("favorited") || "",
            sort,
          }),
        ).slice(0, 24);
        const perPage = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("per_page") ?? 24)),
        );
        const rawCursor = url.searchParams.get("cursor");
        let start = Math.max(
          0,
          (Math.max(1, Number(url.searchParams.get("page") ?? 1)) - 1) *
            perPage,
        );
        if (rawCursor) {
          const cursor = decodeCursor(rawCursor);
          if (!cursor || cursor.signature !== signature) {
            result = jsonError(
              "invalid_catalog_cursor",
              "The catalogue cursor is invalid for this search.",
              400,
            );
          } else {
            const lastIndex = filtered.findIndex(
              (item) => item.id === cursor.last_id,
            );
            if (lastIndex === -1) {
              result = jsonError(
                "stale_catalog_cursor",
                "The catalogue cursor no longer resolves.",
                409,
              );
            } else {
              start = lastIndex + 1;
            }
          }
        }
        if (!result) {
          const items = filtered.slice(start, start + perPage);
          const hasMore = start + items.length < filtered.length;
          result = json({
            items,
            page: Math.floor(start / perPage) + 1,
            per_page: perPage,
            total: filtered.length,
            next_cursor:
              hasMore && items.length
                ? encodeCursor(signature, items[items.length - 1].id)
                : null,
            facets,
          });
        }
      } else if (
        request.method === "GET" &&
        path === "/api/v1/campaign-templates/recent"
      ) {
        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") ?? 24)),
        );
        result = json({
          items: [...recentViews.values()]
            .sort((left, right) =>
              right.last_viewed_at.localeCompare(left.last_viewed_at),
            )
            .slice(0, limit),
        });
      } else if (
        request.method === "DELETE" &&
        path === "/api/v1/campaign-templates/recent"
      ) {
        const cleared = recentViews.size;
        recentViews.clear();
        result = json({ ok: true, cleared });
      } else if (
        request.method === "GET" &&
        path === "/api/v1/campaign-templates/compare"
      ) {
        const identifiers = url.searchParams.getAll("template");
        if (
          identifiers.length < 2 ||
          identifiers.length > 4 ||
          new Set(identifiers).size !== identifiers.length
        ) {
          result = jsonError(
            "invalid_compare_selection",
            "Choose two to four different templates.",
            400,
          );
        } else {
          const items = identifiers.map((identifier) => {
            const template = summaryByID.get(identifier);
            return template
              ? {
                  requested_identifier: identifier,
                  matched_by: "id",
                  template,
                }
              : null;
          });
          result = items.some((item) => !item)
            ? jsonError(
                "template_identifier_not_found",
                "A selected template is no longer available.",
                404,
              )
            : json({ items });
        }
      } else if (
        request.method === "GET" &&
        path === "/api/v1/campaign-template-collections"
      ) {
        result = json({ items: [collectionResponse()] });
      } else if (
        request.method === "GET" &&
        collectionDetailMatch?.[1] === DEMO_COLLECTION_ID
      ) {
        result = json(collectionResponse(), 200, {
          etag: demoCollection.etag,
        });
      } else if (
        request.method === "PUT" &&
        collectionItemsMatch?.[1] === DEMO_COLLECTION_ID
      ) {
        if (request.headers["if-match"] !== demoCollection.etag) {
          result = jsonError(
            "precondition_failed",
            "Reload the latest collection version.",
            412,
          );
        } else {
          const input = await readRequestBody(request);
          const templateIDs = Array.isArray(input.template_ids)
            ? input.template_ids
            : [];
          if (
            templateIDs.length > 100 ||
            new Set(templateIDs).size !== templateIDs.length ||
            templateIDs.some((id) => !summaryByID.has(id))
          ) {
            result = jsonError(
              "invalid_template_ids",
              "Collection items are invalid.",
              400,
            );
          } else {
            const version = demoCollection.version + 1;
            demoCollection = {
              ...demoCollection,
              template_ids: templateIDs,
              item_count: templateIDs.length,
              updated_at: new Date().toISOString(),
              version,
              etag: `"campaign-template-collection:${DEMO_COLLECTION_ID}:v${version}"`,
            };
            result = json(collectionResponse(), 200, {
              etag: demoCollection.etag,
            });
          }
        }
      } else if (
        request.method === "GET" &&
        path === "/api/v1/campaign-template-saved-searches"
      ) {
        result = json({ items: [demoSavedSearch] });
      } else if (
        request.method === "GET" &&
        savedSearchResultsMatch?.[1] === DEMO_SAVED_SEARCH_ID
      ) {
        const perPage = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("per_page") ?? 24)),
        );
        const filtered = allSummaries
          .filter(
            (item) =>
              item.goal === demoSavedSearch.filters.goal &&
              item.style === demoSavedSearch.filters.style &&
              item.template_kind === demoSavedSearch.filters.kind,
          )
          .sort(
            (left, right) =>
              right.usage_count - left.usage_count ||
              left.id.localeCompare(right.id),
          );
        result = json({
          items: filtered.slice(0, perPage),
          next_cursor: null,
          total: filtered.length,
          facets,
        });
      } else if (
        request.method === "GET" &&
        savedSearchDetailMatch?.[1] === DEMO_SAVED_SEARCH_ID
      ) {
        result = json(demoSavedSearch, 200, {
          etag: demoSavedSearch.etag,
        });
      } else if (
        request.method === "POST" &&
        path === "/api/v1/campaign-template-designs"
      ) {
        const input = await readRequestBody(request);
        const idempotencyKey = request.headers["idempotency-key"];
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.trim() === ""
        ) {
          result = jsonError(
            "idempotency_key_required",
            "An Idempotency-Key header is required.",
            400,
          );
        } else if (!["generate", "adapt"].includes(input.mode)) {
          result = jsonError(
            "invalid_design_mode",
            "Design mode must be generate or adapt.",
            400,
          );
        } else {
          assertNoCallerHTML(input, "design create");
          for (const forbidden of ["save_as_template", "saved_template"]) {
            if (Object.hasOwn(input, forbidden)) {
              throw new Error(
                `Durable design create received legacy field ${forbidden}`,
              );
            }
          }
          const bodyHash = sha256(JSON.stringify(input));
          const existing = createIdempotency.get(idempotencyKey);
          if (existing && existing.bodyHash !== bodyHash) {
            result = jsonError(
              "idempotency_key_request_mismatch",
              "That retry key belongs to a different design request.",
              409,
            );
          } else if (existing) {
            result = json(designResponse(designs.get(existing.designID)), 202);
          } else {
            const sequence = designs.size + 1;
            const id = `55555555-5555-4555-8555-${String(sequence).padStart(12, "0")}`;
            const referenceIDs = Array.isArray(input.reference_template_ids)
              ? input.reference_template_ids
              : [];
            if (referenceIDs.some((idValue) => !summaryByID.has(idValue))) {
              result = jsonError(
                "reference_template_not_found",
                "One selected reference no longer exists.",
                404,
              );
            } else {
              const state = {
                id,
                request: {
                  ...input,
                  reference_template_ids: referenceIDs,
                },
                status: "queued",
                attemptCount: 1,
                revisions: [],
                pending: { operation: "initial", instructions: "" },
              };
              designs.set(id, state);
              createIdempotency.set(idempotencyKey, {
                bodyHash,
                designID: id,
              });
              result = json(designResponse(state), 202, {
                "retry-after": "1",
              });
            }
          }
        }
      } else {
        const revisionsMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/revisions$/,
        );
        const refineMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/refine$/,
        );
        const retryMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/retry$/,
        );
        const saveMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/save$/,
        );
        const campaignMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/create-campaign$/,
        );
        const archiveMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)\/archive$/,
        );
        const designMatch = path.match(
          /^\/api\/v1\/campaign-template-designs\/([^/]+)$/,
        );
        const detailMatch = path.match(
          /^\/api\/v1\/campaign-templates\/([^/]+)$/,
        );
        const recentViewMatch = path.match(
          /^\/api\/v1\/campaign-templates\/([^/]+)\/view$/,
        );
        const recentClearMatch = path.match(
          /^\/api\/v1\/campaign-templates\/recent\/([^/]+)$/,
        );
        const favoriteMatch = path.match(
          /^\/api\/v1\/campaign-templates\/([^/]+)\/favorite$/,
        );
        const flowUsageMatch = path.match(
          /^\/api\/v1\/campaign-templates\/([^/]+)\/flow-usage$/,
        );
        const campaignDetailMatch = path.match(
          /^\/api\/v1\/campaigns\/([^/]+)$/,
        );

        if (request.method === "POST" && recentViewMatch) {
          const id = decodeURIComponent(recentViewMatch[1]);
          const template = summaryByID.get(id);
          if (!template) {
            result = jsonError("template_not_found", "Template not found", 404);
          } else {
            const now = new Date().toISOString();
            const prior = recentViews.get(id);
            const view = {
              template,
              view_count: (prior?.view_count ?? 0) + 1,
              first_viewed_at: prior?.first_viewed_at ?? now,
              last_viewed_at: now,
            };
            recentViews.set(id, view);
            result = json(view);
          }
        } else if (request.method === "DELETE" && recentClearMatch) {
          const id = decodeURIComponent(recentClearMatch[1]);
          const cleared = recentViews.delete(id) ? 1 : 0;
          result = json({ ok: true, cleared });
        } else if (request.method === "GET" && revisionsMatch) {
          const state = designs.get(decodeURIComponent(revisionsMatch[1]));
          result = state
            ? json({ items: [...state.revisions] })
            : jsonError(
                "design_draft_not_found",
                "Design draft not found.",
                404,
              );
        } else if (request.method === "POST" && refineMatch) {
          const state = designs.get(decodeURIComponent(refineMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else {
            const input = await readRequestBody(request);
            assertNoCallerHTML(input, "design refinement");
            const current = state.revisions[state.revisions.length - 1];
            if (
              state.status !== "ready" ||
              input.base_revision !== current?.revision
            ) {
              result = jsonError(
                "design_revision_conflict",
                "Refine from the latest immutable revision.",
                409,
              );
            } else {
              state.status = "queued";
              state.attemptCount += 1;
              state.pending = {
                operation: "refine",
                instructions: String(input.instructions || "").trim(),
              };
              result = json(designResponse(state), 202, {
                "retry-after": "1",
              });
            }
          }
        } else if (request.method === "POST" && retryMatch) {
          const state = designs.get(decodeURIComponent(retryMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else if (state.status !== "failed") {
            result = jsonError(
              "design_retry_not_available",
              "Only failed design attempts can be retried.",
              409,
            );
          } else {
            state.status = "queued";
            state.attemptCount += 1;
            state.pending = { operation: "repair", instructions: "" };
            result = json(designResponse(state), 202, {
              "retry-after": "1",
            });
          }
        } else if (request.method === "POST" && saveMatch) {
          const state = designs.get(decodeURIComponent(saveMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else {
            const input = await readRequestBody(request);
            assertNoCallerHTML(input, "save boundary");
            const current = state.revisions[state.revisions.length - 1];
            assertExactCommit(input, current);
            metrics.boundaryCommits.push({
              boundary: "save",
              revision: input.revision,
              output_hash: input.output_hash,
              keys: Object.keys(input).sort(),
            });
            state.savedTemplateID = DEMO_SAVED_TEMPLATE_ID;
            state.savedRevision = input.revision;
            state.status = "saved";
            result = json({
              id: DEMO_SAVED_TEMPLATE_ID,
              tenant_id: DEMO_TENANT_ID,
              slug: input.slug,
              name: input.name || current.output.name,
              subject: input.subject || current.output.subject,
              preview_text: input.preview_text || current.output.preview_text,
              tags: ["generated", "ai", "newsletter"],
              variables: [],
              template_kind: "editable",
              version: 1,
              etag: '"demo-saved-template-v1"',
              created_at: FIXED_UPDATED_AT,
              updated_at: FIXED_UPDATED_AT,
              capabilities: {
                can_preview: true,
                can_favorite: true,
                can_adapt: false,
                can_use_directly: true,
                can_create_campaign: true,
                can_edit_directly: true,
                can_clone: true,
                can_delete: true,
                can_archive: true,
                can_restore: false,
                has_source_html: true,
                has_source_mjml: false,
                has_desktop_preview: false,
                has_mobile_preview: false,
              },
              recommended_action: "campaign_template_create_campaign",
              warnings: [],
            });
          }
        } else if (request.method === "POST" && campaignMatch) {
          const state = designs.get(decodeURIComponent(campaignMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else {
            const input = await readRequestBody(request);
            assertNoCallerHTML(input, "campaign boundary");
            const current = state.revisions[state.revisions.length - 1];
            assertExactCommit(input, current);
            metrics.boundaryCommits.push({
              boundary: "campaign",
              revision: input.revision,
              output_hash: input.output_hash,
              keys: Object.keys(input).sort(),
            });
            const campaign = buildCampaign(state, input);
            campaigns.set(campaign.id, campaign);
            state.createdCampaignID = campaign.id;
            state.campaignRevision = input.revision;
            state.status = "campaign_created";
            result = json(campaign, 201);
          }
        } else if (request.method === "POST" && archiveMatch) {
          const state = designs.get(decodeURIComponent(archiveMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else if (["queued", "generating"].includes(state.status)) {
            result = jsonError(
              "design_draft_in_progress",
              "A running design cannot be archived.",
              409,
            );
          } else {
            state.status = "archived";
            result = json(designResponse(state));
          }
        } else if (request.method === "GET" && designMatch) {
          const state = designs.get(decodeURIComponent(designMatch[1]));
          if (!state) {
            result = jsonError(
              "design_draft_not_found",
              "Design draft not found.",
              404,
            );
          } else {
            if (state.status === "queued") {
              state.status = "generating";
            } else if (state.status === "generating") {
              completePendingDesign(state);
            }
            result = json(designResponse(state), 200, {
              ...(["queued", "generating"].includes(state.status)
                ? { "retry-after": "1" }
                : {}),
            });
          }
        } else if (request.method === "POST" && favoriteMatch) {
          const id = decodeURIComponent(favoriteMatch[1]);
          const summary = summaryByID.get(id);
          const input = await readRequestBody(request);
          if (!summary) {
            result = jsonError("template_not_found", "Template not found", 404);
          } else {
            summary.is_favorited = input.favorited !== false;
            result = json({ ok: true, favorited: summary.is_favorited });
          }
        } else if (request.method === "GET" && flowUsageMatch) {
          result = json({ items: [] });
        } else if (request.method === "GET" && detailMatch) {
          const id = decodeURIComponent(detailMatch[1]);
          const template = templateByID.get(id);
          result = template
            ? json(
                detailFor(
                  template,
                  templates.findIndex(
                    (candidate) => candidate.source_external_id === id,
                  ),
                  assetBase,
                ),
              )
            : jsonError("template_not_found", "Template not found", 404);
        } else if (request.method === "GET" && path === "/api/v1/campaigns") {
          result = json([]);
        } else if (request.method === "GET" && campaignDetailMatch) {
          const campaign = campaigns.get(
            decodeURIComponent(campaignDetailMatch[1]),
          );
          result = campaign
            ? json(campaign, 200, { etag: '"demo-campaign-v1"' })
            : jsonError("campaign_not_found", "Campaign not found", 404);
        } else if (request.method === "GET" && path === "/api/v1/segments") {
          result = json([
            {
              id: "88888888-8888-4888-8888-888888888888",
              tenant_id: DEMO_TENANT_ID,
              name: "Product leaders",
              description: "Engaged product and engineering leaders",
              conditions: {},
              last_count: 2_840,
              created_at: FIXED_CREATED_AT,
              updated_at: FIXED_UPDATED_AT,
            },
          ]);
        } else if (request.method === "GET" && path === "/api/v1/lists") {
          result = json({
            items: [
              { id: 42, name: "Signal Stack readers", subscriber_count: 8_420 },
            ],
          });
        } else if (
          request.method === "POST" &&
          path === "/api/v1/audiences/count"
        ) {
          result = json({
            base: 2_917,
            excluded: 77,
            deliverable: 2_840,
            kind: "segment",
          });
        } else if (
          request.method === "PUT" &&
          path === "/api/v1/activity/last-viewed"
        ) {
          result = json({ ok: true });
        } else if (
          request.method === "GET" &&
          path === "/api/mailchimp/3.0/campaign-manager/calendar"
        ) {
          result = json({
            touchpoints: [],
            tasks: [],
            capabilities: [],
            summary: {},
          });
        } else if (
          request.method === "GET" &&
          path === "/api/mailchimp/3.0/reports/custom"
        ) {
          result = json({
            id: "demo-report",
            view: "campaign",
            metrics: ["sent", "opened", "clicked", "revenue_cents"],
            group_by: ["campaign"],
            rows: [],
            graph: [],
            generated_at: FIXED_UPDATED_AT,
          });
        } else if (
          request.method === "GET" &&
          path.startsWith("/api/mailchimp/3.0/")
        ) {
          result = json({
            campaign_id: DEMO_CAMPAIGN_ID,
            enabled: false,
            winner_metric: "opens",
            evaluation_window_hours: 24,
            sample_pct: 20,
            winner_recipients_pct: 80,
            variations: [],
            dimensions: [],
            limits: {},
            recommendation: {
              label: "Build audience first",
              score: 0,
              confidence: "insufficient_data",
              reason: "This is a new draft.",
            },
            data_points: 0,
            method: "none",
            total_clicks: 0,
            links: [],
            device_views: [],
            status: "draft",
            can_cancel: false,
            cancelled: false,
            progress: {},
            delivery_status: "not_started",
            warnings: [],
            replies: [],
            threads: [],
            total_items: 0,
            distinct_replyers: 0,
            reply_rate: 0,
          });
        } else if (request.method === "GET") {
          result = json({ items: [], total: 0 });
        } else {
          result = jsonError(
            "demo_route_not_mocked",
            `The durable demo does not mock ${request.method} ${path}.`,
            404,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      metrics.violations.push(message);
      result = jsonError("demo_contract_violation", message, 422);
    }

    response.writeHead(result.status, {
      "access-control-allow-origin": "*",
      ...result.headers,
    });
    response.end(result.body);
  });
  return {
    server,
    metrics,
    prewarm: (count = 8) =>
      Promise.all(
        templates
          .slice(0, Math.max(0, count))
          .map((template) => loadPreviewAsset(template, "card", 30_000)),
      ),
  };
}

async function waitForWeb(url, processHandle, logBuffer, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `The web demo exited early (${processHandle.exitCode}).\n${logBuffer.join("")}`,
      );
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Next is still compiling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}.\n${logBuffer.join("")}`);
}

async function waitForVisibleThumbnails(page, count = 4) {
  await page.waitForFunction(
    (expected) => {
      const images = [
        ...document.querySelectorAll(
          'img[alt^="Preview of"], img[alt*=" capture of "]',
        ),
      ].slice(0, expected);
      return (
        images.length === expected &&
        images.every(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0,
        )
      );
    },
    count,
    { timeout: 45_000 },
  );
}

async function settlePage(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
  await page.waitForTimeout(500);
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || !processHandle.pid) {
    return;
  }
  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    try {
      processHandle.kill("SIGTERM");
    } catch {
      return;
    }
  }
  await Promise.race([
    new Promise((resolveExit) => processHandle.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 4_000)),
  ]);
  if (processHandle.exitCode === null) {
    try {
      process.kill(-processHandle.pid, "SIGKILL");
    } catch {
      // The process may have exited between checks.
    }
  }
}

async function verifyCompleteStableCatalogue(apiOrigin) {
  const seen = new Set();
  let cursor = null;
  let expectedFirstCursor = null;
  let requests = 0;
  do {
    const query = new URLSearchParams({
      goal: "newsletter",
      kind: "reference",
      per_page: "100",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(
      `${apiOrigin}/api/v1/campaign-templates/search?${query.toString()}`,
    );
    if (!response.ok) {
      throw new Error(
        `Catalogue verification failed with HTTP ${response.status}`,
      );
    }
    const page = await response.json();
    if (page.total !== expectedCatalogSize) {
      throw new Error(
        `Expected catalogue total ${expectedCatalogSize}, received ${page.total}`,
      );
    }
    if (!Array.isArray(page.items) || page.items.length > 100) {
      throw new Error("Catalogue page violated its bounded page contract");
    }
    for (const item of page.items) {
      if (seen.has(item.id)) {
        throw new Error(`Stable catalogue cursor repeated template ${item.id}`);
      }
      seen.add(item.id);
      for (const asset of item.preview_assets ?? []) {
        if (
          !asset.url.startsWith(
            `${item.thumbnail_url.split("/").slice(0, -2).join("/")}/`,
          )
        ) {
          throw new Error(
            `Preview asset escaped the hosted demo base: ${asset.url}`,
          );
        }
      }
    }
    if (requests === 0) expectedFirstCursor = page.next_cursor;
    cursor = page.next_cursor;
    requests += 1;
    if (requests > Math.ceil(expectedCatalogSize / 100) + 1) {
      throw new Error("Catalogue pagination did not terminate");
    }
  } while (cursor);
  if (seen.size !== expectedCatalogSize) {
    throw new Error(
      `Stable pagination exposed ${seen.size} of ${expectedCatalogSize} summaries`,
    );
  }

  const replay = await fetch(
    `${apiOrigin}/api/v1/campaign-templates/search?goal=newsletter&kind=reference&per_page=100`,
  ).then((response) => response.json());
  if (replay.next_cursor !== expectedFirstCursor) {
    throw new Error("The first catalogue cursor was not deterministic");
  }
  return { count: seen.size, pages: requests };
}

async function main() {
  const [manifest, richArtifact] = await Promise.all([
    readFile(FULL_MANIFEST_PATH, "utf8").then(JSON.parse),
    readFile(RICH_CATALOG_PATH, "utf8").then(JSON.parse),
  ]);
  const manifestTemplates = Array.isArray(manifest.templates)
    ? manifest.templates
    : [];
  const richTemplates = Array.isArray(richArtifact.templates)
    ? richArtifact.templates
    : [];
  const reportedCatalogSize = Number(manifest.harvest?.template_count);
  if (
    manifest.harvest?.complete !== true ||
    manifest.harvest?.pagination_exhausted !== true ||
    !Number.isInteger(reportedCatalogSize) ||
    reportedCatalogSize < 1 ||
    manifestTemplates.length !== reportedCatalogSize ||
    Number(manifest.harvest?.source_total_at_capture) !== reportedCatalogSize
  ) {
    throw new Error(
      `Expected a complete manifest matching its source total, found ${manifestTemplates.length} templates for reported total ${manifest.harvest?.source_total_at_capture ?? "missing"}.`,
    );
  }
  expectedCatalogSize = reportedCatalogSize;
  if (richTemplates.length < 50) {
    throw new Error(
      `Expected at least 50 rich templates, found ${richTemplates.length}.`,
    );
  }
  const richByID = new Map(
    richTemplates.map((template) => [template.source_external_id, template]),
  );
  const templates = manifestTemplates.map((entry, manifestIndex) => {
    const rich = richByID.get(entry.source_external_id);
    return {
      category: "newsletter",
      goal: "newsletter",
      preview_text: entry.subject,
      variables: [],
      tags: ["source-rge", "newsletter"],
      template_kind: "reference",
      source_provider: "really_good_emails",
      source_captured_at: manifest.generated_at || FIXED_CREATED_AT,
      source_license_status: "personal-use-unreviewed",
      industry: "general",
      style: "editorial",
      layout: "long-form",
      review_status: "approved",
      ...entry,
      ...(rich ?? {}),
      _manifest_index: manifestIndex,
    };
  });
  const uniqueIDs = new Set(
    templates.map((template) => template.source_external_id),
  );
  if (uniqueIDs.size !== expectedCatalogSize) {
    throw new Error(
      `The full manifest contains only ${uniqueIDs.size} unique template IDs.`,
    );
  }
  const richOrder = [
    ...DEMO_ORDER,
    ...richTemplates
      .map((template) => template.source_external_id)
      .filter((id) => !DEMO_ORDER.includes(id)),
  ];
  const rank = new Map(richOrder.map((id, index) => [id, index]));
  templates.sort((left, right) => {
    const leftRank =
      rank.get(left.source_external_id) ??
      richOrder.length + left._manifest_index;
    const rightRank =
      rank.get(right.source_external_id) ??
      richOrder.length + right._manifest_index;
    return leftRank - rightRank;
  });

  await mkdir(OUTPUT_DIR, { recursive: true });
  const webPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const assetBase = `${baseUrl}/api/v1/demo-assets`;
  const {
    server: demoServer,
    metrics,
    prewarm,
  } = buildDemoServer(templates, assetBase);
  const apiPort = await listen(demoServer);
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  await prewarm(12);
  const catalogueVerification = await verifyCompleteStableCatalogue(apiOrigin);
  const logBuffer = [];
  const screenshotFiles = [
    "01-template-library-gallery.png",
    "02-template-detail-and-preview.png",
    "03-ai-generation-brief.png",
    "04-immutable-design-review.png",
    "05-refinement-and-revision-history.png",
    "06-exact-campaign-handoff.png",
    "07-exact-save-and-campaign-handoff.png",
    "08-campaign-draft-editor.png",
    "09-personal-recent-view.png",
    "10-template-comparison.png",
    "11-ordered-template-collection.png",
    "12-saved-search-run.png",
  ];
  let webProcess;
  let browser;

  try {
    webProcess = spawn(
      "pnpm",
      [
        "--dir",
        "apps/web",
        "exec",
        "next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          API_URL: apiOrigin,
          POSTWAVE_API_URL: apiOrigin,
          POSTWAVE_AUTH_BYPASS: "1",
          POSTWAVE_LOCAL_AUTH_BYPASS: "1",
          NEXT_PUBLIC_TENANT_SLUG: "demo",
          NEXT_PUBLIC_USE_MOCKS: "0",
          NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL: assetBase,
          POSTWAVE_NEXT_DIST_DIR: ".next-template-demo",
        },
      },
    );
    const appendLog = (chunk) => {
      logBuffer.push(chunk.toString());
      if (logBuffer.length > 80) logBuffer.shift();
    };
    webProcess.stdout.on("data", appendLog);
    webProcess.stderr.on("data", appendLog);

    await waitForWeb(`${baseUrl}/app/templates`, webProcess, logBuffer);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1800, height: 1200 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      try {
        if (window.self !== window.top) return;
        window.localStorage.setItem(
          "postwave_tour_dashboard_completed_at",
          new Date().toISOString(),
        );
        window.localStorage.setItem("theme", "light");
      } catch {
        // Sandboxed email preview frames intentionally have no storage origin.
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    const browserErrors = [];
    const browserPreviewLeaks = [];
    const browserAPIFailures = [];
    page.on("pageerror", (error) => {
      browserErrors.push(error.message);
      console.error(`[browser error] ${error.message}`);
    });
    page.on("request", (request) => {
      const requestURL = request.url();
      if (
        requestURL.includes("pro-really-good-emails") ||
        requestURL.includes("really-good-emails.s3")
      ) {
        browserPreviewLeaks.push(requestURL);
      }
    });
    page.on("response", (response) => {
      if (
        response.status() >= 400 &&
        response.url().startsWith(`${baseUrl}/api/`)
      ) {
        browserAPIFailures.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error(`[browser console] ${message.text()}`);
      }
    });

    console.log(
      `Capturing the complete ${expectedCatalogSize.toLocaleString()}-design gallery…`,
    );
    await page.goto(`${baseUrl}/app/templates`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Newsletter templates" }).waitFor();
    await page
      .getByText(
        `Showing 24 of ${expectedCatalogSize.toLocaleString()} designs`,
        { exact: true },
      )
      .waitFor();
    await waitForVisibleThumbnails(page, 6);
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[0]),
      fullPage: false,
    });

    console.log("Capturing a governed, hosted-preview reference detail…");
    const featuredId = DEMO_ORDER[0];
    await page.goto(`${baseUrl}/app/templates/${featuredId}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", {
        level: 1,
        name: /AirDNA/,
      })
      .waitFor();
    await page.getByAltText(/(?:Preview|capture) of AirDNA/i).waitFor();
    await waitForVisibleThumbnails(page, 1);
    await page.getByText(/Visual inspiration\. Choose Make it mine/).waitFor();
    await page.waitForTimeout(750);
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[1]),
      fullPage: false,
    });

    console.log("Capturing the reference-aware AI brief…");
    await page
      .getByRole("link", { name: "Newsletter templates" })
      .first()
      .click();
    await page.getByRole("heading", { name: "Newsletter templates" }).waitFor();

    console.log("Capturing verified personal recent history…");
    await page.getByRole("button", { name: "Recent", exact: true }).click();
    const recentDialog = page.getByRole("dialog", {
      name: "Recently viewed designs",
    });
    await recentDialog.waitFor();
    await recentDialog.getByText(/AirDNA/).waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[8]),
      fullPage: false,
    });
    await recentDialog.getByRole("button", { name: "Close" }).click();

    console.log("Capturing the four-slot comparison flow…");
    await page
      .getByRole("button", { name: /Add .*AirDNA.* to comparison/ })
      .click();
    await page
      .getByRole("button", { name: /Add .*Mount Sapo.* to comparison/ })
      .click();
    const compareTray = page.getByRole("region", {
      name: "Template comparison tray",
    });
    await compareTray
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    const compareDialog = page.getByRole("dialog", {
      name: "Compare newsletter designs",
    });
    await compareDialog.getByRole("table").waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[9]),
      fullPage: false,
    });
    await compareDialog.getByRole("button", { name: "Close" }).click();
    await compareTray.getByRole("button", { name: "Clear" }).click();

    console.log("Capturing an ordered, concurrency-safe collection…");
    await page
      .getByRole("button", { name: "Collections", exact: true })
      .click();
    const collectionsDialog = page.getByRole("dialog", {
      name: "Template collections",
    });
    await collectionsDialog
      .getByRole("button", { name: /Launch-worthy shortlist/ })
      .click();
    await collectionsDialog.getByText("Ordered designs (3/100)").waitFor();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response
            .url()
            .includes(
              `/api/v1/campaign-template-collections/${DEMO_COLLECTION_ID}/items`,
            ),
      ),
      collectionsDialog
        .getByRole("button", { name: "Move down" })
        .first()
        .click(),
    ]);
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[10]),
      fullPage: false,
    });
    await collectionsDialog.getByRole("button", { name: "Close" }).click();

    console.log("Capturing a saved search with fresh run results…");
    await page
      .getByRole("button", { name: "Saved searches", exact: true })
      .click();
    const savedSearchesDialog = page.getByRole("dialog", {
      name: "Saved searches",
    });
    await savedSearchesDialog.getByText("Minimal editorial picks").waitFor();
    await savedSearchesDialog
      .getByRole("button", { name: "Run", exact: true })
      .click();
    await savedSearchesDialog.getByText(/matching designs/).waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[11]),
      fullPage: false,
    });
    await savedSearchesDialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Generate with AI" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog
      .getByLabel("Design brief")
      .fill(
        "Create a sharp weekly AI newsletter for product leaders. Open with one editorial story, add two practical signal cards, then end with one clear CTA. Keep it premium, readable, and confident.",
      );
    await dialog.getByLabel("Tone").fill("Editorial, confident, warm");
    await dialog
      .getByLabel("Audience")
      .fill("Product leaders at growing SaaS companies");
    await dialog.getByRole("button", { name: /AirDNA/ }).click();
    await dialog.getByRole("button", { name: /Mount Sapo/ }).click();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[2]),
      fullPage: false,
    });

    console.log("Capturing immutable revision 1 review…");
    await dialog.getByRole("button", { name: "Generate design" }).click();
    await dialog.getByText("Immutable revision 1", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "Create campaign draft" })
      .waitFor();
    await dialog.locator('iframe[title*="revision 1 preview"]').waitFor();
    await dialog.getByRole("button", { name: "Create revision 2" }).waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[3]),
      fullPage: false,
    });

    console.log("Capturing refinement and immutable history…");
    await dialog
      .getByLabel("Refine this version")
      .fill(
        "Shorten the hero, make the lead more actionable, and add more breathing room between stories.",
      );
    await dialog.getByRole("button", { name: "Create revision 2" }).click();
    await dialog.getByText("Immutable revision 2", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Create revision 3" }).waitFor();
    await dialog.getByRole("button", { name: /v1 · initial/ }).click();
    await dialog.getByText(/Historical revisions are read-only/).waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[4]),
      fullPage: false,
    });
    await dialog.getByRole("button", { name: /v2 · refine/ }).click();
    await dialog.getByText("Immutable revision 2", { exact: true }).waitFor();

    console.log("Capturing exact revision-to-campaign handoff…");
    await dialog
      .getByLabel("Audience (optional)")
      .selectOption("segment:88888888-8888-4888-8888-888888888888");
    await dialog.getByRole("button", { name: "Create campaign draft" }).click();
    await dialog
      .getByText("A campaign draft was created from this exact revision.", {
        exact: true,
      })
      .waitFor();
    await dialog.getByRole("link", { name: "Open campaign draft" }).waitFor();
    await dialog
      .getByRole("button", { name: "Save exact revision as template" })
      .waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[5]),
      fullPage: false,
    });

    console.log("Capturing both independent exact commits…");
    await dialog
      .getByRole("button", { name: "Save exact revision as template" })
      .click();
    await dialog
      .getByText("This exact revision is saved in your template library.", {
        exact: true,
      })
      .waitFor();
    await dialog
      .getByText("A campaign draft was created from this exact revision.", {
        exact: true,
      })
      .waitFor();
    await dialog
      .getByRole("link", { name: "Open campaign draft" })
      .scrollIntoViewIfNeeded();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[6]),
      fullPage: false,
    });

    console.log("Capturing the campaign draft editor handoff…");
    await dialog.getByRole("link", { name: "Open campaign draft" }).click();
    await page.waitForURL(`**/app/campaigns/${DEMO_CAMPAIGN_ID}`);
    await page
      .getByRole("heading", {
        level: 1,
        name: "Signal Stack Weekly — Refined campaign",
      })
      .waitFor();
    await page.getByTestId("save-state").waitFor();
    await settlePage(page);
    await page.screenshot({
      path: resolve(OUTPUT_DIR, screenshotFiles[7]),
      fullPage: false,
    });

    if (browserPreviewLeaks.length) {
      throw new Error(
        `The browser requested upstream preview URLs: ${browserPreviewLeaks.join(", ")}`,
      );
    }
    if (browserErrors.length) {
      throw new Error(
        `The web flow emitted browser errors: ${browserErrors.join(" | ")}`,
      );
    }
    if (browserAPIFailures.length) {
      throw new Error(
        `The web flow received API errors: ${browserAPIFailures.join(" | ")}`,
      );
    }
    if (metrics.violations.length) {
      throw new Error(
        `The durable mock caught contract violations: ${metrics.violations.join(" | ")}`,
      );
    }
    const legacyRequests = metrics.requestLog.filter(
      ({ path }) =>
        path === "/api/v1/campaign-templates/generate" ||
        /^\/api\/v1\/campaign-templates\/[^/]+\/adapt$/.test(path),
    );
    if (legacyRequests.length) {
      throw new Error(
        `The web flow called legacy template routes: ${JSON.stringify(legacyRequests)}`,
      );
    }
    if (metrics.boundaryCommits.length !== 2) {
      throw new Error(
        `Expected save and campaign commits, received ${JSON.stringify(metrics.boundaryCommits)}`,
      );
    }
    const saveCommit = metrics.boundaryCommits.find(
      (commit) => commit.boundary === "save",
    );
    const campaignCommit = metrics.boundaryCommits.find(
      (commit) => commit.boundary === "campaign",
    );
    if (
      !saveCommit ||
      !campaignCommit ||
      saveCommit.revision !== campaignCommit.revision ||
      saveCommit.output_hash !== campaignCommit.output_hash ||
      !HASH_PATTERN.test(saveCommit.output_hash)
    ) {
      throw new Error(
        `Save and campaign did not commit the same immutable revision: ${JSON.stringify(metrics.boundaryCommits)}`,
      );
    }
    for (const commit of metrics.boundaryCommits) {
      if (
        commit.keys.some((key) =>
          ["body_html", "body_mjml", "html", "mjml"].includes(key),
        )
      ) {
        throw new Error(
          `${commit.boundary} boundary accepted caller HTML: ${commit.keys.join(", ")}`,
        );
      }
    }

    const sizes = await Promise.all(
      screenshotFiles.map(async (file) => ({
        file,
        bytes: (await stat(resolve(OUTPUT_DIR, file))).size,
      })),
    );
    console.log(
      `Verified ${catalogueVerification.count.toLocaleString()} summaries across ${catalogueVerification.pages} stable pages.`,
    );
    console.log(
      `Verified ${metrics.assetRequests} hosted asset requests and zero upstream browser preview requests.`,
    );
    console.log(
      `Verified save + campaign commit revision ${saveCommit.revision} at ${saveCommit.output_hash}.`,
    );
    for (const item of sizes) {
      console.log(`${item.file}: ${item.bytes.toLocaleString()} bytes`);
    }
    console.log(`Saved ${screenshotFiles.length} screenshots to ${OUTPUT_DIR}`);
  } finally {
    if (browser) await browser.close();
    if (webProcess) await stopProcess(webProcess);
    await new Promise((resolveClose) => demoServer.close(resolveClose));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
