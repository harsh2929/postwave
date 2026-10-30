#!/usr/bin/env node

// Exercise native radio/label galleries in compiled MJML. Local browser proof
// covers pointer, keyboard, independent panels and an explicit static fallback.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mjml from "mjml";
import { chromium } from "playwright";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass an item directory");
const source = await readFile(join(directory, "template.mjml"), "utf8");
const metadata = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
const qa = JSON.parse(await readFile(join(directory, "qa.json"), "utf8"));
const gallery = metadata.interactive_gallery;
assert.deepEqual(gallery?.groups, ["top", "bottom"]);
const ids = gallery.groups.flatMap((group) => Array.from({ length: 6 }, (_, i) => `pw-${group}-${i + 1}`));
assert.deepEqual(gallery.input_ids, ids);
assert.equal(gallery.static_class, "pw-static");
const digest = "sha256:" + createHash("sha256").update(source).digest("hex");
assert.equal(qa.source_sha256, digest, "Template changed after render QA");
let html = (await mjml(source, { validationLevel: "strict" })).html
  .replaceAll("__HERO_IMAGE_URL__", pathToFileURL(join(directory, "hero.png")).href)
  .replaceAll("__CTA_URL__", "#")
  .replaceAll("{{ brand_name }}", "Your brand")
  .replaceAll("{{unsubscribe_url}}", "#");
for (const [key, file] of Object.entries(metadata.supporting_images)) {
  html = html.replaceAll(`__IMAGE_${key.toUpperCase()}_URL__`, pathToFileURL(join(directory, file)).href);
}
for (const name of Object.keys(metadata.link_variables)) html = html.replaceAll(`{{ ${name} }}`, `#${name}`);
const temporary = join(tmpdir(), `postwave-gallery-${randomUUID()}.html`);
await writeFile(temporary, html);
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [680, 375, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    try {
      await page.goto(pathToFileURL(temporary).href);
      const selected = (group) => page.locator(`.pw-${group}-panel .pw-slide`).evaluateAll((slides) =>
        slides.filter((slide) => getComputedStyle(slide).display !== "none").map((slide) => ({
          number: Number(slide.className.match(/pw-slide-(\d+)/)[1]),
          src: slide.querySelector("img").src,
        })));
      const expectedSources = ["hero.png", ...Array.from({ length: 5 }, (_, i) => metadata.supporting_images[`style_${i + 2}`])]
        .map((file) => pathToFileURL(join(directory, file)).href);
      const checkCaption = async (group, number) => {
        const captions = await page.locator(`.pw-${group}-panel .pw-caption`).evaluateAll((elements) =>
          elements.filter((el) => getComputedStyle(el).display !== "none").map((el) => ({
            number: Number(el.className.match(/pw-caption-(\d+)/)[1]), text: el.textContent.trim(),
          })));
        assert.equal(captions.length, 1);
        assert.equal(captions[0].number, number);
        assert.ok(captions[0].text.startsWith(group === "top" ? "Upper detail" : "Lower detail"));
      };
      assert.deepEqual(await selected("top"), [{ number: 1, src: expectedSources[0] }]);
      assert.deepEqual(await selected("bottom"), [{ number: 1, src: expectedSources[0] }]);
      const tested = [];
      let minimumHeight = Infinity;
      let minimumWidth = Infinity;
      for (const group of gallery.groups) {
        const other = group === "top" ? "bottom" : "top";
        const otherBefore = await selected(other);
        for (let number = 1; number <= 6; number++) {
          const id = `pw-${group}-${number}`;
          const control = page.locator(`label[for="${id}"]`);
          const bounds = await control.boundingBox();
          assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44, `Small gallery control: ${id}`);
          minimumHeight = Math.min(minimumHeight, bounds.height);
          minimumWidth = Math.min(minimumWidth, bounds.width);
          await control.click();
          assert.equal(await page.locator(`#${id}`).isChecked(), true);
          assert.deepEqual(await selected(group), [{ number, src: expectedSources[number - 1] }]);
          await checkCaption(group, number);
          assert.deepEqual(await selected(other), otherBefore, "The other panel changed");
          assert.equal(await control.evaluate((el) => getComputedStyle(el).borderTopColor), "rgb(32, 183, 222)");
          tested.push(id);
        }
      }
      await page.locator('label[for="pw-top-4"]').click();
      await page.screenshot({ path: join(directory, `gallery-selected-${width}.png`), fullPage: true });
      // Reach both radio groups using Tab, then use native arrow navigation.
      await page.goto(pathToFileURL(temporary).href);
      for (let step = 0; step < 10; step++) {
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => document.activeElement.id === "pw-top-1")) break;
      }
      assert.equal(await page.evaluate(() => document.activeElement.id), "pw-top-1");
      await page.keyboard.press("ArrowRight");
      assert.deepEqual(await selected("top"), [{ number: 2, src: expectedSources[1] }]);
      assert.deepEqual(await selected("bottom"), [{ number: 1, src: expectedSources[0] }]);
      assert.equal(await page.locator('label[for="pw-top-2"]').evaluate((el) => getComputedStyle(el).outlineWidth), "3px");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "pw-bottom-1");
      await page.keyboard.press("ArrowRight");
      assert.deepEqual(await selected("bottom"), [{ number: 2, src: expectedSources[1] }]);
      assert.deepEqual(await selected("top"), [{ number: 2, src: expectedSources[1] }]);
      // Disable enhancement after selecting other images: the first pair must
      // still display, with a visible full-gallery destination.
      await page.evaluate((className) => document.body.classList.add(className), gallery.static_class);
      await page.locator('label[for="pw-top-5"]').click();
      for (const group of gallery.groups) {
        assert.deepEqual(await selected(group), [{ number: 1, src: expectedSources[0] }]);
        await checkCaption(group, 1);
      }
      assert.equal(await page.locator('a[href="#gallery_url"]').isVisible(), true);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false);
      await page.screenshot({ path: join(directory, `gallery-static-${width}.png`), fullPage: true });
      checks.push({ width, control_ids_checked: tested, independent_panels: true,
        keyboard_navigation: true, keyboard_focus_visible: true, static_fallback: true, native_captions: true,
        full_gallery_link_visible: true, minimum_control_height: minimumHeight,
        minimum_control_width: minimumWidth, horizontal_overflow: false });
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await unlink(temporary);
}
qa.interactive_gallery = { passed: true, source_sha256: digest, input_ids: ids,
  inspected_widths: checks.map((check) => check.width), checks };
await writeFile(join(directory, "qa.json"), JSON.stringify(qa, null, 2) + "\n");
process.stdout.write(`${metadata.catalog_id}: pointer, keyboard, independent panels and static gallery passed\n`);
