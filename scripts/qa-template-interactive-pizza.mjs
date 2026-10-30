#!/usr/bin/env node

// Exercise the actual native controls before and after Blocks edits. This is
// browser interaction evidence; email-client support remains a release review.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import mjml from "mjml";
import { chromium } from "playwright";

const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass an item directory");
const source = await readFile(join(directory, "template.mjml"), "utf8");
const metadata = JSON.parse(await readFile(join(directory, "meta.json"), "utf8"));
const qa = JSON.parse(await readFile(join(directory, "qa.json"), "utf8"));
const pizza = metadata.interactive_pizza;
const keys = ["sauce", "cheese", "pepperoni", "sausage", "olives", "jalapenos", "pineapple"];
const toppingIds = keys.map((key) => `pw-pizza-${key}`);
const ids = [...toppingIds, "pw-pizza-slice"];
assert.deepEqual(pizza?.topping_ids, toppingIds);
assert.equal(pizza.slice_id, ids.at(-1));
assert.equal(pizza.static_class, "pw-pizza-static");
assert.equal(pizza.builder_variable, "pizza_builder_url");
const digest = "sha256:" + createHash("sha256").update(source).digest("hex");
assert.equal(qa.source_sha256, digest, "Template changed after render QA");
assert.equal(qa.editor_roundtrip.passed, true);
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  const editorPage = await browser.newPage();
  let exported;
  try {
    await editorPage.setContent('<div id="editor"></div>');
    await editorPage.addScriptTag({ path: resolve("node_modules/grapesjs/dist/grapes.min.js") });
    await editorPage.addScriptTag({ path: resolve("node_modules/grapesjs-mjml/dist/index.js") });
    exported = await editorPage.evaluate((source) => {
      const editor = window.grapesjs.init({ container: "#editor", storageManager: false,
        plugins: [window["grapesjs-mjml"]], components: source });
      try {
        const wrapper = editor.getWrapper();
        const footer = wrapper.findType("mj-text").find((block) => block.toHTML().includes("Add your mailing address"));
        if (!footer) throw new Error("Missing editable footer");
        footer.set("content", "Editor address proof");
        const marker = "{{ pizza_builder_url }}";
        const url = "https://example.test/pizza-builder";
        for (const block of wrapper.findType("mj-button")) {
          if (block.getAttributes().href === marker) block.addAttributes({ href: url });
        }
        for (const block of wrapper.findType("mj-text")) {
          if (block.toHTML().includes(`href="${marker}"`)) {
            const inner = block.toHTML().replace(/^<mj-text\b[^>]*>/, "").replace(/<\/mj-text>$/, "");
            block.components(inner.replaceAll(marker, url));
          }
        }
        return editor.getHtml();
      } finally { editor.destroy(); }
    }, source);
  } finally { await editorPage.close(); }
  for (const [variant, candidate] of [["source", source], ["blocks_export", exported]]) {
    let html = (await mjml(candidate, { validationLevel: "strict" })).html
      .replaceAll("__CTA_URL__", "#")
      .replaceAll("{{ brand_name }}", "Your brand")
      .replaceAll("{{unsubscribe_url}}", "#")
      .replaceAll("{{ pizza_builder_url }}", "https://example.test/pizza-builder");
    for (const name of Object.keys(metadata.link_variables)) html = html.replaceAll(`{{ ${name} }}`, `#${name}`);
    await writeFile(join(directory, `pizza-${variant}-proof.html`), html);
    for (const width of [680, 375, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.setContent(html);
        const visible = () => page.locator(".pw-pizza-layer").evaluateAll((elements) =>
          elements.filter((el) => getComputedStyle(el).display !== "none")
            .map((el) => [...el.classList].find((name) => name !== "pw-pizza-layer")).sort());
        assert.deepEqual(await visible(), []);
        let minimumHeight = Infinity, minimumWidth = Infinity;
        for (const id of ids) {
          const label = page.locator(`label[for="${id}"]`);
          const bounds = await label.boundingBox();
          assert.ok(bounds && bounds.height >= 44 && bounds.width >= 44, `Small control: ${id}`);
          minimumHeight = Math.min(minimumHeight, bounds.height);
          minimumWidth = Math.min(minimumWidth, bounds.width);
          await label.click();
          assert.equal(await page.locator(`#${id}`).isChecked(), true);
          if (id !== pizza.slice_id) assert.deepEqual(await visible(), [id]);
          else assert.equal(await page.locator(".pw-pizza-slice-mask").isVisible(), true);
          await label.click();
          assert.deepEqual(await visible(), []);
          assert.equal(await page.locator(".pw-pizza-slice-mask").isVisible(), false);
        }
        for (const id of toppingIds) await page.locator(`label[for="${id}"]`).click();
        assert.deepEqual(await visible(), [...toppingIds].sort());
        await page.locator(`label[for="${pizza.slice_id}"]`).click();
        assert.deepEqual(await visible(), [...toppingIds].sort());
        assert.equal(await page.locator(".pw-pizza-slice-mask").isVisible(), true);
        if (variant === "source") await page.screenshot({ path: join(directory, `pizza-all-selected-${width}.png`), fullPage: true });
        for (const id of ["pw-pizza-cheese", "pw-pizza-sausage", "pw-pizza-jalapenos"]) await page.locator(`label[for="${id}"]`).click();
        const mixed = toppingIds.filter((id) => !["pw-pizza-cheese", "pw-pizza-sausage", "pw-pizza-jalapenos"].includes(id)).sort();
        assert.deepEqual(await visible(), mixed);
        assert.equal(await page.locator(".pw-pizza-slice-mask").isVisible(), true);
        await page.setContent(html);
        for (let step = 0; step < 12; step++) {
          await page.keyboard.press("Tab");
          if (await page.evaluate(() => document.activeElement.id === "pw-pizza-sauce")) break;
        }
        assert.equal(await page.evaluate(() => document.activeElement.id), ids[0]);
        for (const id of ids) {
          assert.equal(await page.evaluate(() => document.activeElement.id), id);
          const outline = await page.locator(`label[for="${id}"]`).evaluate((el) => getComputedStyle(el).outlineWidth);
          assert.equal(outline, "3px");
          await page.keyboard.press("Space");
          assert.equal(await page.locator(`#${id}`).isChecked(), true);
          await page.keyboard.press("Tab");
        }
        assert.deepEqual(await visible(), [...toppingIds].sort());
        await page.evaluate((name) => document.body.classList.add(name), pizza.static_class);
        assert.deepEqual(await visible(), ["pw-pizza-cheese", "pw-pizza-sauce"]);
        assert.equal(await page.locator(".pw-pizza-slice-mask").isVisible(), false);
        assert.equal(await page.locator(".pw-pizza-static-note").isVisible(), true);
        assert.equal(await page.getByRole("link", { name: "OPEN THE PIZZA NOTEBOOK", exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("link", { name: "OPEN THE PIZZA NOTEBOOK", exact: true }).getAttribute("href"), "https://example.test/pizza-builder");
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false);
        if (variant === "source") await page.screenshot({ path: join(directory, `pizza-static-${width}.png`), fullPage: true });
        checks.push({ variant, width, control_ids_checked: ids, independent_toppings: true,
          combined_and_mixed_states: true, slice_preserves_toppings: true,
          keyboard_navigation: true, keyboard_focus_visible: true, static_fallback: true,
          builder_link_visible: true, minimum_control_height: minimumHeight,
          minimum_control_width: minimumWidth, horizontal_overflow: false });
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
qa.interactive_pizza = { passed: true, source_sha256: digest, input_ids: ids,
  inspected_widths: [680, 375, 320], template_variants: ["source", "blocks_export"],
  editor_export_interaction: true, checks };
await writeFile(join(directory, "qa.json"), JSON.stringify(qa, null, 2) + "\n");
process.stdout.write(`${metadata.catalog_id}: eight pointer/keyboard controls, combined states, slice and static fallback passed before and after Blocks edits\n`);
