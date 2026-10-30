#!/usr/bin/env node

// Exercise the same GrapesJS MJML plugin as the Blocks editor. Strict MJML
// compilation alone cannot prove that the canvas can select and change the
// content. Edits here stay in memory and are never written to a template.

import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import mjml from "mjml";
import { chromium } from "playwright";

const root = resolve(process.argv[2] ?? "output/template-enhancement/items");
if (!existsSync(root)) throw new Error(`Missing item directory: ${root}`);
const directories = existsSync(join(root, "template.mjml"))
  ? [root]
  : (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
if (!directories.length) throw new Error("No item drafts found");

const browser = await chromium.launch({ headless: true });
let passed = 0;
try {
  for (const directory of directories) {
    const sourcePath = join(directory, "template.mjml");
    const qaPath = join(directory, "qa.json");
    if (!existsSync(sourcePath) || !existsSync(qaPath)) continue;
    const [source, reportRaw, metadataRaw] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readFile(qaPath, "utf8"),
      readFile(join(directory, "meta.json"), "utf8"),
    ]);
    // The checked-in drafts should be portable to MJML editors even without
    // Postwave's editor-load normalization.
    if (/<mj-[a-z0-9-]+\b[^<>]*\/>/i.test(source)) {
      throw new Error(`${directory}: use explicit closing MJML tags`);
    }
    const report = JSON.parse(reportRaw);
    const metadata = JSON.parse(metadataRaw);
    const nativeText = metadata.visual_mode === "native_text";
    const backgroundKeys = metadata.background_image_keys ?? [];
    const linkVariables = metadata.link_variables ?? {};
    const motionFeatures = metadata.motion_features ?? [];
    const expectedBackgrounds = backgroundKeys.length;
    const expectedImages = (source.match(/<mj-image\b/g) ?? []).length;
    const assetMarkers = Object.fromEntries([...(nativeText ? [] : ["hero"]), ...Object.keys(metadata.supporting_images ?? {})]
      .map((key) => [key, key === "hero" ? "__HERO_IMAGE_URL__" : `__IMAGE_${key.toUpperCase()}_URL__`]));
    const supportingMarkers = Object.keys(metadata.supporting_images ?? {}).map(
      (key) => `__IMAGE_${key.toUpperCase()}_URL__`,
    );
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="editor"></div>');
      await page.addScriptTag({ path: resolve("node_modules/grapesjs/dist/grapes.min.js") });
      await page.addScriptTag({ path: resolve("node_modules/grapesjs-mjml/dist/index.js") });
      const result = await page.evaluate(({ source, expectedImages, expectedBackgrounds, linkVariables, assetMarkers }) => {
        const editor = window.grapesjs.init({
          container: "#editor",
          height: "600px",
          storageManager: false,
          plugins: [window["grapesjs-mjml"]],
          components: source,
        });
        try {
          const wrapper = editor.getWrapper();
          const text = wrapper.findType("mj-text").find((block) =>
            !/\bhref=/.test(block.toHTML()));
          const images = wrapper.findType("mj-image");
          const backgrounds = wrapper.findType("mj-section").filter((section) => section.getAttributes()["background-url"]);
          const imageReferenceEditCounts = Object.fromEntries(Object.entries(assetMarkers).map(([key, marker]) => [key,
            images.filter((block) => block.getAttributes().src === marker).length +
            backgrounds.filter((block) => block.getAttributes()["background-url"] === marker).length]));
          // A named action may appear first (for example, add to calendar).
          // Exercise the generic action separately so its edit cannot erase
          // a named destination before the named actions are selected.
          const button = wrapper.findType("mj-button").find((block) =>
            block.getAttributes().href === "__CTA_URL__");
          const genericLinkText = wrapper.findType("mj-text").find((block) =>
            block.toHTML().includes('href="__CTA_URL__"'));
          const initial = editor.getHtml();
          // Native diagrams and long articles live inside mj-text blocks.
          // Compare every block, including its nested HTML, before and after
          // edits so a successful button/image check cannot hide lost content.
          const nativeBlocks = (mjmlSource, normalizeEdits = false) => [...mjmlSource.matchAll(/<mj-text\b[^>]*>([\s\S]*?)<\/mj-text>/g)]
            .map((match) => {
              const fragment = document.createElement("template");
              fragment.innerHTML = match[1];
              return {
                text: fragment.content.textContent.replace(/\s+/g, " ").trim(),
                structure: [...fragment.content.querySelectorAll("*")].map((node) => ({
                  tag: node.tagName,
                  attributes: node.getAttributeNames().sort().map((name) => {
                    let value = node.getAttribute(name);
                    if (name === "style") value = [...node.style].sort().map((property) =>
                      [property, node.style.getPropertyValue(property), node.style.getPropertyPriority(property)]);
                    if (name === "class") value = value.split(/\s+/).filter(Boolean).sort();
                    if (normalizeEdits && name === "href") {
                      if (value === "https://example.test/editor-action") value = "__CTA_URL__";
                      for (const variable of Object.keys(linkVariables)) {
                        if (value === `https://example.test/editor-${variable}`) value = `{{ ${variable} }}`;
                      }
                    }
                    return [name, value];
                  }),
                })),
              };
            });
          const sourceNativeBlocks = nativeBlocks(source);
          const initialNativeBlocks = nativeBlocks(initial);
          if (JSON.stringify(sourceNativeBlocks) !== JSON.stringify(initialNativeBlocks)) {
            return { error: "Canvas lost native text or HTML structure during import" };
          }
          if (!text || (expectedImages > 0 && !images.length) || backgrounds.length !== expectedBackgrounds ||
              !wrapper.findType("mj-button").length || (!button && !genericLinkText)) {
            return { error: "Missing selectable text, image, or button block" };
          }
          text.set("content", "Editor roundtrip proof");
          const editedImageUrls = images.map((image, index) => {
            const url = `https://assets.example.test/editor-image-${index}.png`;
            image.addAttributes({ src: url });
            return url;
          });
          const editedBackgroundUrls = backgrounds.map((section, index) => {
            const url = `https://assets.example.test/editor-background-${index}.png`;
            section.addAttributes({ "background-url": url });
            return url;
          });
          const editNativeLink = (block, marker, url) => {
            const inner = block.toHTML().replace(/^<mj-text\b[^>]*>/, "").replace(/<\/mj-text>$/, "");
            block.components(inner.replaceAll(marker, url));
          };
          if (button) button.addAttributes({ href: "https://example.test/editor-action" });
          else editNativeLink(genericLinkText, "__CTA_URL__", "https://example.test/editor-action");
          const editedLinkUrls = [];
          const selectableLinkVariables = [];
          const linkVariableEditCounts = {};
          for (const name of Object.keys(linkVariables)) {
            const marker = `{{ ${name} }}`;
            const choices = wrapper.findType("mj-button").filter((block) =>
              block.getAttributes().href === `{{ ${name} }}`);
            const nativeLinks = wrapper.findType("mj-text").filter((block) =>
              block.toHTML().includes(`href="${marker}"`));
            if (!choices.length && !nativeLinks.length) return { error: `Missing selectable action: ${name}` };
            selectableLinkVariables.push(name);
            const url = `https://example.test/editor-${name}`;
            choices.forEach((block) => block.addAttributes({ href: url }));
            linkVariableEditCounts[name] = { buttons: choices.length, native_text_links:
              nativeLinks.reduce((sum, block) => sum + block.toHTML().split(`href="${marker}"`).length - 1, 0) };
            nativeLinks.forEach((block) => editNativeLink(block, marker, url));
            editedLinkUrls.push(url);
          }
          const edited = editor.getHtml();
          const editedNativeBlocks = nativeBlocks(edited, true);
          const proofTextIndex = wrapper.findType("mj-text").indexOf(text);
          if (editedNativeBlocks.length !== sourceNativeBlocks.length || sourceNativeBlocks.some((block, index) =>
              index !== proofTextIndex && JSON.stringify(block) !== JSON.stringify(editedNativeBlocks[index]))) {
            return { error: "Canvas lost native text or HTML structure during edits" };
          }
          return {
            initial,
            edited,
            editedImageUrls,
            editedBackgroundUrls,
            editedLinkUrls,
            selectableLinkVariables,
            linkVariableEditCounts,
            imageReferenceEditCounts,
            native_text_blocks_checked: sourceNativeBlocks.length,
            native_structured_blocks_checked: sourceNativeBlocks.filter((block) => block.structure.length).length,
            selectable_text_blocks: wrapper.findType("mj-text").length,
            selectable_image_blocks: wrapper.findType("mj-image").length,
            selectable_background_blocks: backgrounds.length,
            selectable_button_blocks: wrapper.findType("mj-button").length,
          };
        } finally {
          editor.destroy();
        }
      }, { source, expectedImages, expectedBackgrounds, linkVariables, assetMarkers });
      if (result.error) throw new Error(result.error);
      if (result.selectable_image_blocks !== expectedImages) {
        throw new Error(`Expected ${expectedImages} editable image blocks`);
      }
      if (result.selectable_background_blocks !== expectedBackgrounds) {
        throw new Error(`Expected ${expectedBackgrounds} editable section backgrounds`);
      }
      for (const marker of [...(nativeText ? [] : ["__HERO_IMAGE_URL__"]), ...supportingMarkers, "__CTA_URL__", "{{unsubscribe_url}}", ...Object.keys(linkVariables).map((name) => `{{ ${name} }}`)] ) {
        if (!result.initial.includes(marker)) throw new Error(`Canvas lost ${marker}`);
      }
      for (const marker of [
        "Editor roundtrip proof",
        ...result.editedImageUrls,
        ...result.editedBackgroundUrls,
        ...result.editedLinkUrls,
        "https://example.test/editor-action",
      ]) {
        if (!result.edited.includes(marker)) throw new Error(`Canvas could not edit ${marker}`);
      }
      if (/<mj-style\b/.test(source)) {
        const styles = (text) => [...text.matchAll(/<mj-style\b[^>]*>([\s\S]*?)<\/mj-style>/g)]
          .map((m) => m[1].replace(/\s+/g, ""));
        for (const stylesheet of styles(source)) {
          if (!styles(result.initial).includes(stylesheet) || !styles(result.edited).includes(stylesheet)) {
            throw new Error("Canvas lost native styles");
          }
        }
      }
      for (const [name, sourceToCompile] of [
        ["initial", result.initial],
        ["edited", result.edited],
      ]) {
        const compiled = await mjml(sourceToCompile, { validationLevel: "strict" });
        if (!compiled.html || compiled.errors?.length) {
          throw new Error(`${name} canvas MJML does not compile: ${JSON.stringify(compiled.errors)}`);
        }
      }
      report.editor_roundtrip = {
        passed: true,
        selectable_text_blocks: result.selectable_text_blocks,
        selectable_image_blocks: result.selectable_image_blocks,
        selectable_background_blocks: result.selectable_background_blocks,
        selectable_button_blocks: result.selectable_button_blocks,
        image_reference_edit_counts: result.imageReferenceEditCounts,
        text_and_button_edits_compile: true,
        native_text_blocks_preserved: true,
        native_html_structure_preserved: true,
        native_html_attributes_preserved: true,
        native_text_blocks_checked: result.native_text_blocks_checked,
        native_structured_blocks_checked: result.native_structured_blocks_checked,
        ...(nativeText ? {} : { text_image_and_button_edits_compile: true }),
        ...(expectedBackgrounds ? { background_edits_compile: true } : {}),
        ...(Object.keys(linkVariables).length ? { selectable_link_variables: result.selectableLinkVariables,
          link_variable_edits_compile: true, link_variable_edit_counts: result.linkVariableEditCounts } : {}),
        ...(motionFeatures.length ? { motion_styles_preserved: true } : {}),
        ...(/<mj-style\b/.test(source) ? { native_styles_preserved: true } : {}),
      };
      await writeFile(qaPath, `${JSON.stringify(report, null, 2)}\n`);
      passed++;
      process.stdout.write(`${report.catalog_id}: block editor roundtrip passed\n`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
process.stdout.write(`${passed} item drafts passed block editor roundtrip\n`);
