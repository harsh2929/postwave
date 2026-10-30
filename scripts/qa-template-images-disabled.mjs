#!/usr/bin/env node

// Verify that the email's heading and native actions survive disabled images.
// This is a local browser check; it does not claim email-client coverage.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import mjml from "mjml";
import { chromium } from "playwright";

const directories = process.argv.slice(2).map((path) => resolve(path));
if (!directories.length) throw new Error("Pass one or more item directories");
const browser = await chromium.launch({ headless: true });
try {
  for (const directory of directories) {
    const source = await readFile(join(directory, "template.mjml"), "utf8");
    const metadata = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
    if (Object.values(metadata.supporting_images ?? {}).includes("images-disabled-320.png")) {
      throw new Error("A supporting asset uses the reserved images-disabled screenshot path");
    }
    const qa = JSON.parse(await readFile(join(directory, "qa.json"), "utf8"));
    const sourceDigest = "sha256:" + createHash("sha256").update(source).digest("hex");
    if (qa.source_sha256 !== sourceDigest) throw new Error("Template changed after render QA");
    const compiled = await mjml(source, { validationLevel: "strict" });
    const html = compiled.html
      .replace(/__(?:HERO_IMAGE|IMAGE_[A-Z0-9_]+)_URL__/g, "https://assets.example.test/blocked.png")
      .replaceAll("__CTA_URL__", "#")
      .replaceAll("{{ brand_name }}", "Your brand")
      .replaceAll("{{unsubscribe_url}}", "#");
    const buttonContents = [...source.matchAll(/<mj-button\b[^>]*>([\s\S]*?)<\/mj-button>/g)].map((match) => match[1]);
    const page = await browser.newPage({ viewport: { width: 320, height: 1100 } });
    try {
      await page.route("**/*", (route) => route.request().resourceType() === "image" ? route.abort() : route.continue());
      await page.setContent(html, { waitUntil: "load" });
      const heading = page.locator("h1").first();
      if (!await heading.isVisible()) throw new Error("Native primary heading is not visible");
      const labels = await page.evaluate((contents) => contents.map((content) => {
        const element = document.createElement("div");
        element.innerHTML = content;
        element.querySelectorAll('[aria-hidden="true"]').forEach((decoration) => decoration.remove());
        return element.textContent.trim();
      }), buttonContents);
      let minHeight = Infinity;
      for (const label of labels) {
        const button = page.getByRole("link", { name: label, exact: true }).first();
        const bounds = await button.boundingBox();
        if (!await button.isVisible() || !bounds || bounds.height < 44) {
          throw new Error(`Action is not visible or has a target smaller than 44px: ${label}`);
        }
        minHeight = Math.min(minHeight, bounds.height);
      }
      if (!labels.length) throw new Error("No native action buttons");
      let galleryCaptionsVisible;
      if (metadata.interactive_gallery) {
        const captions = await page.locator(".pw-caption").evaluateAll((elements) =>
          elements.filter((el) => getComputedStyle(el).display !== "none").map((el) => el.textContent.trim()));
        if (captions.length !== 2 || !captions[0].startsWith("Upper detail") || !captions[1].startsWith("Lower detail")) {
          throw new Error("Native gallery captions are missing with images disabled");
        }
        galleryCaptionsVisible = true;
      }
      const state = await page.evaluate(() => ({
        horizontal_overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        loaded_images: [...document.images].filter((image) => image.naturalWidth > 0).length,
      }));
      if (state.horizontal_overflow || state.loaded_images) throw new Error("Disabled-image render failed");
      await page.screenshot({ path: join(directory, "images-disabled-320.png"), fullPage: true });
      qa.images_disabled_320 = {
        passed: true, width: 320, source_sha256: sourceDigest,
        heading_text: await heading.innerText(), visible_buttons: labels.length,
        minimum_button_height: Math.round(minHeight * 10) / 10,
        horizontal_overflow: false, loaded_images: 0,
        screenshot: "images-disabled-320.png",
        ...(galleryCaptionsVisible ? { native_gallery_captions_visible: true } : {}),
      };
      await writeFile(join(directory, "qa.json"), JSON.stringify(qa, null, 2) + "\n");
      process.stdout.write(`${qa.catalog_id}: disabled-image heading and actions passed\n`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
