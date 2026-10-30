#!/usr/bin/env node

// Render and verify one local editable draft. This never publishes or changes
// the third-party source catalog. Local images are served from temporary file
// URLs for QA; production MJML still requires hosted Postwave assets.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import mjml from "mjml";
import { chromium } from "playwright";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(directory)) {
  throw new Error("Usage: node scripts/render-template-enhancement.mjs <item-directory>");
}

const sourcePath = join(directory, "template.mjml");
const heroPath = join(directory, "hero.png");
const metadataPath = join(directory, "meta.json");
const [source, metadataRaw] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(metadataPath, "utf8"),
]);
const metadata = JSON.parse(metadataRaw);
const linkVariables = metadata.link_variables ?? {};
if (!linkVariables || typeof linkVariables !== "object" || Array.isArray(linkVariables) ||
    Object.entries(linkVariables).some(([name, label]) => !/^[a-z][a-z0-9_]*_url$/.test(name) ||
      ["cta_url", "unsubscribe_url"].includes(name) || typeof label !== "string" || !label.trim())) {
  throw new Error("Invalid named action URLs");
}
const actionVariables = [...source.matchAll(/<(?:mj-button|a)\b[^>]*\bhref=["']\{\{\s*([a-z][a-z0-9_]*_url)\s*\}\}["']/g)].map((m) => m[1])
  .filter((name) => !["cta_url", "unsubscribe_url"].includes(name));
if (Object.keys(linkVariables).some((name) => !actionVariables.includes(name)) ||
    actionVariables.some((name) => !Object.hasOwn(linkVariables, name))) {
  throw new Error("Named action URL declarations do not match links");
}
const motionFeatures = metadata.motion_features ?? [];
if (!Array.isArray(motionFeatures) || motionFeatures.some((feature) =>
    !/^\.[a-z][a-z0-9-]*(?: img)?$/.test(feature.selector ?? "") ||
    !["transform", "color"].includes(feature.property) || !/^[a-z][a-z0-9-]*$/.test(feature.animation ?? "") ||
    !source.includes(`@keyframes ${feature.animation}`))) throw new Error("Invalid motion metadata");
if (!metadata.catalog_id || !metadata.subject || !metadata.preview_text) {
  throw new Error("Draft metadata is incomplete");
}
const supporting = metadata.supporting_images ?? {};
const visualMode = metadata.visual_mode ?? "generated_images";
if (!["generated_images", "native_text"].includes(visualMode)) {
  throw new Error("Unknown template visual mode");
}
const nativeText = visualMode === "native_text";
const hero = nativeText ? null : await readFile(heroPath);
const backgroundKeys = metadata.background_image_keys ?? [];
const assetKeys = [...(nativeText ? [] : ["hero"]), ...Object.keys(supporting)];
const imageReferenceCounts = metadata.image_reference_counts ?? Object.fromEntries(assetKeys.map((key) => [key, 1]));
if (!imageReferenceCounts || typeof imageReferenceCounts !== "object" || Array.isArray(imageReferenceCounts) ||
    Object.keys(imageReferenceCounts).length !== assetKeys.length || assetKeys.some((key) =>
      !Number.isInteger(imageReferenceCounts[key]) || imageReferenceCounts[key] < 1)) {
  throw new Error("Invalid image reference counts");
}
if (!Array.isArray(backgroundKeys) || new Set(backgroundKeys).size !== backgroundKeys.length ||
    backgroundKeys.some((key) => !assetKeys.includes(key))) {
  throw new Error("Invalid background image keys");
}
const assetMarker = (key) => key === "hero" ? "__HERO_IMAGE_URL__" : `__IMAGE_${key.toUpperCase()}_URL__`;
const backgroundMarkers = [...source.matchAll(/\bbackground-url\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
if (backgroundMarkers.length !== backgroundKeys.length ||
    backgroundMarkers.some((marker) => !backgroundKeys.some((key) => assetMarker(key) === marker))) {
  throw new Error("Background image markup does not match metadata");
}
if (!supporting || typeof supporting !== "object" || Array.isArray(supporting)) {
  throw new Error("supporting_images must be a key-to-PNG object");
}
if (nativeText && (Object.keys(supporting).length || existsSync(heroPath) ||
    /<mj-image\b|<img\b|\bbackground-url\s*=|__HERO_IMAGE_URL__/i.test(source))) {
  throw new Error("Native text templates must have no image assets or image markup");
}
const supportingAssets = [];
const filenames = new Set(["hero.png", "desktop.png", "mobile.png", "mobile-320.png", "images-disabled-320.png"]);
for (const [key, filename] of Object.entries(supporting)) {
  if (!/^[a-z][a-z0-9_]*$/.test(key) || ["hero", "desktop", "mobile"].includes(key)) {
    throw new Error(`Invalid supporting image key: ${key}`);
  }
  if (typeof filename !== "string" || !/^[a-z][a-z0-9-]*\.png$/.test(filename) || filenames.has(filename)) {
    throw new Error(`Invalid supporting image filename: ${filename}`);
  }
  filenames.add(filename);
  const marker = `__IMAGE_${key.toUpperCase()}_URL__`;
  if (source.split(marker).length - 1 !== imageReferenceCounts[key]) throw new Error(`Unexpected supporting image reference count: ${marker}`);
  const path = join(directory, filename);
  const data = await readFile(path);
  supportingAssets.push({ key, marker, path, data });
}
const knownMarkers = new Set(supportingAssets.map((asset) => asset.marker));
for (const marker of source.match(/__IMAGE_[A-Z0-9_]+_URL__/g) ?? []) {
  if (!knownMarkers.has(marker)) throw new Error(`Undeclared supporting image marker: ${marker}`);
}
for (const marker of [...(nativeText ? [] : ["__HERO_IMAGE_URL__"]), "__CTA_URL__", "{{unsubscribe_url}}"] ) {
  if (!source.includes(marker)) throw new Error(`Missing editable MJML marker: ${marker}`);
}
// The library's Blocks surface is built on grapesjs-mjml. Keep drafts within
// its ordinary section/column/content vocabulary so each part remains
// selectable and replaceable, rather than becoming one opaque HTML blob.
const editorTags = new Set([
  "mjml", "mj-head", "mj-title", "mj-preview", "mj-attributes", "mj-all",
  "mj-body", "mj-section", "mj-column", "mj-text", "mj-image", "mj-style",
  "mj-button", "mj-divider", "mj-spacer", "mj-social",
]);
const tags = [...source.matchAll(/<(mj[a-z-]*)\b/g)].map((match) => match[1]);
const unsupportedTags = [...new Set(tags.filter((tag) => !editorTags.has(tag)))];
if (unsupportedTags.length) throw new Error(`Unsupported editor tags: ${unsupportedTags.join(", ")}`);
const blocks = {
  sections: tags.filter((tag) => tag === "mj-section").length,
  text: tags.filter((tag) => tag === "mj-text").length,
  images: tags.filter((tag) => tag === "mj-image").length,
  background_images: backgroundKeys.length,
  buttons: tags.filter((tag) => tag === "mj-button").length,
};
for (const key of assetKeys) {
  const marker = assetMarker(key);
  const foreground = [...source.matchAll(/<mj-image\b[^>]*\bsrc=["']([^"']+)["']/g)].filter((m) => m[1] === marker).length;
  const backgrounds = backgroundMarkers.filter((value) => value === marker).length;
  if (foreground + backgrounds !== imageReferenceCounts[key] || source.split(marker).length - 1 !== imageReferenceCounts[key]) {
    throw new Error(`Image references must belong to editable image or section blocks: ${key}`);
  }
}
if (blocks.sections < 3 || blocks.text < 3 || (!nativeText && blocks.images + blocks.background_images < 1) || blocks.buttons < 1) {
  throw new Error(`Template lacks independently editable content blocks: ${JSON.stringify(blocks)}`);
}
if (hero && (hero.length === 0 || !hero.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))) {
  throw new Error("Hero must be a nonempty PNG image");
}
for (const asset of supportingAssets) {
  if (asset.data.length === 0 || !asset.data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    throw new Error(`Supporting image must be a nonempty PNG: ${asset.path}`);
  }
}

const result = await mjml(source, { validationLevel: "strict" });
if (result.errors?.length) {
  throw new Error(`MJML validation failed: ${JSON.stringify(result.errors)}`);
}
if (!result.html) throw new Error("MJML compiler returned no HTML");
let html = result.html
  .replaceAll("__HERO_IMAGE_URL__", pathToFileURL(heroPath).href)
  .replaceAll("__CTA_URL__", "#")
  .replaceAll("{{ brand_name }}", "Your brand")
  .replaceAll("{{unsubscribe_url}}", "#");
for (const asset of supportingAssets) {
  html = html.replaceAll(asset.marker, pathToFileURL(asset.path).href);
}
for (const name of Object.keys(linkVariables)) html = html.replaceAll(`{{ ${name} }}`, `#${name}`);
const temporaryHTML = join(tmpdir(), `postwave-template-${randomUUID()}.html`);
await writeFile(temporaryHTML, html);
const checks = [];
const backgroundURLs = backgroundKeys.map((key) => pathToFileURL(key === "hero" ? heroPath : supportingAssets.find((asset) => asset.key === key).path).href);
const expectedForegroundImages = Object.values(imageReferenceCounts).reduce((sum, count) => sum + count, 0) - backgroundKeys.length;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [680, 375, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(temporaryHTML).href);
    const motionChecks = [];
    for (const feature of motionFeatures) {
      const target = page.locator(feature.selector).first();
      if (!await target.count()) throw new Error(`Missing animated element: ${feature.selector}`);
      const sample = () => target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), feature.property);
      const first = await sample();
      await page.waitForTimeout(350);
      let second = await sample();
      // A blink or another intermittent animation may hold the same value
      // between events. Observe one complete cycle before judging it static.
      const cycleMs = await target.evaluate(el => Math.max(...getComputedStyle(el).animationDuration.split(',').map(value => {
        const number = parseFloat(value);
        return value.trim().endsWith('ms') ? number : number * 1000;
      })));
      const observationLimit = Math.min(10000, Math.max(500, cycleMs + 200));
      let observedMs = 350;
      while (first === second && observedMs < observationLimit) {
        await page.waitForTimeout(150);
        observedMs += 150;
        second = await sample();
      }
      if (first === second) throw new Error(`Motion did not change: ${feature.animation}`);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reduced = await target.evaluate((el) => getComputedStyle(el).animationName);
      if (reduced !== "none") throw new Error(`Reduced motion ignored: ${feature.animation}`);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      motionChecks.push({ ...feature, changed: true, observation_ms:observedMs, cycle_ms:cycleMs, reduced_motion_disabled: true });
    }
    const imageCheck = await page.locator("img").evaluateAll((images) => ({
      total: images.length,
      broken: images.filter((image) => !image.complete || image.naturalWidth === 0).length,
      withoutAlt: images.filter((image) => !image.getAttribute("alt")?.trim()).length,
    }));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const backgroundCheck = await page.evaluate(async (expected) => {
      const urls = [...new Set([...document.querySelectorAll("*")].flatMap((element) =>
        [...getComputedStyle(element).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)].map((match) => match[1])))];
      const loaded = await Promise.all(expected.map((url) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth > 0);
        img.onerror = () => resolve(false);
        img.src = url;
      })));
      return { total: urls.length, expected_present: expected.every((url) => urls.includes(url)),
        unexpected: urls.some((url) => !expected.includes(url)), broken: loaded.filter((value) => !value).length };
    }, backgroundURLs);
    if (imageCheck.total !== expectedForegroundImages || imageCheck.broken || imageCheck.withoutAlt || overflow ||
        !backgroundCheck.expected_present || backgroundCheck.unexpected || backgroundCheck.broken) {
      throw new Error(`Render failed at ${width}px: ${JSON.stringify({ imageCheck, overflow })}`);
    }
    const screenshot = join(directory, `${width === 680 ? "desktop" : width === 375 ? "mobile" : "mobile-320"}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    checks.push({ width, image_count: imageCheck.total, background_image_count: backgroundCheck.total,
      broken_images: 0, broken_background_images: 0, images_without_alt: 0, horizontal_overflow: false,
      ...(motionFeatures.length ? { motion_checks: motionChecks } : {}), screenshot: basename(screenshot) });
    await page.close();
  }
} finally {
  await browser?.close();
  await unlink(temporaryHTML).catch(() => {});
}

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const report = {
  catalog_id: metadata.catalog_id,
  visual_mode: visualMode,
  background_image_keys: backgroundKeys,
  image_reference_counts: imageReferenceCounts,
  link_variables: linkVariables,
  motion_features: motionFeatures,
  source_sha256: digest(source),
  hero_sha256: hero ? digest(hero) : null,
  supporting_image_sha256: Object.fromEntries(supportingAssets.map((asset) => [asset.key, digest(asset.data)])),
  mjml_valid: true,
  editor_supported_tags: true,
  editable_blocks: blocks,
  renders: checks,
  hosted_asset_ready: false,
  publication_ready: false,
};
await writeFile(join(directory, "qa.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${metadata.catalog_id}: MJML and desktop/mobile renders passed\n`);
