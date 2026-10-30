// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";

import { hiddenText } from "../../src/lint/rules/hidden-text.js";
import { imageRatio } from "../../src/lint/rules/image-ratio.js";
import { missingAlt } from "../../src/lint/rules/missing-alt.js";
import { obfuscatedSpam } from "../../src/lint/rules/obfuscated-spam.js";
import { outlookUnsupported } from "../../src/lint/rules/outlook-unsupported.js";
import { tinyFont } from "../../src/lint/rules/tiny-font.js";
import {
  ALL_RULES,
  MAX_LINT_SOURCE_CHARS,
  runAllRules,
} from "../../src/lint/rules/index.js";

describe("outlook-unsupported", () => {
  const cases: { name: string; src: string; expectMatch: boolean }[] = [
    { name: "flex inline", src: `<div style="display: flex">x</div>`, expectMatch: true },
    { name: "grid inline", src: `<div style="display: grid">x</div>`, expectMatch: true },
    { name: "gap shorthand", src: `<div style="gap: 8px">x</div>`, expectMatch: true },
    { name: "flex-direction", src: `style={{ flexDirection: 'row' }}`, expectMatch: false },
    { name: "no layout css", src: `<div style="color: red">x</div>`, expectMatch: false },
    { name: "grid-template-columns", src: `<div style="grid-template-columns: 1fr 1fr">x</div>`, expectMatch: true },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const found = outlookUnsupported(c.src);
      expect(found.length > 0).toBe(c.expectMatch);
      if (c.expectMatch) expect(found[0]?.ruleId).toBe("postwave/outlook-unsupported");
    });
  }
});

describe("missing-alt", () => {
  it("flags <img> without alt", () => {
    const f = missingAlt(`<img src="x.png" />`);
    expect(f).toHaveLength(1);
    expect(f[0]?.ruleId).toBe("postwave/missing-alt");
  });
  it("flags <Image> without alt", () => {
    expect(missingAlt(`<Image src="x.png" />`).length).toBe(1);
  });
  it("flags <mj-image> without alt", () => {
    expect(missingAlt(`<mj-image src="x.png" />`).length).toBe(1);
  });
  it("accepts an image with alt", () => {
    expect(missingAlt(`<img src="x.png" alt="Hero" />`).length).toBe(0);
  });
  it("flags multiple", () => {
    const src = `<img src="a.png"/><Image src="b.png" /><img src="c.png" alt="ok"/>`;
    expect(missingAlt(src).length).toBe(2);
  });
});

describe("image-ratio", () => {
  it("flags image-heavy doc", () => {
    const src = `<img src="a.png" alt="a"/><img src="b.png" alt="b"/>tiny`;
    expect(imageRatio(src).length).toBe(1);
  });
  it("does not flag text-heavy doc", () => {
    const text = "lorem ipsum dolor sit amet ".repeat(50);
    const src = `<img src="a.png" alt="a"/>${text}`;
    expect(imageRatio(src).length).toBe(0);
  });
  it("does not flag doc with no images", () => {
    expect(imageRatio("just text").length).toBe(0);
  });
});

describe("hidden-text", () => {
  it("flags display none", () => {
    expect(hiddenText(`<div style="display: none">spam</div>`).length).toBeGreaterThan(0);
  });
  it("flags white text", () => {
    expect(hiddenText(`<span style="color: #fff">x</span>`).length).toBeGreaterThan(0);
  });
  it("flags transparent", () => {
    expect(hiddenText(`<span style="color: transparent">x</span>`).length).toBeGreaterThan(0);
  });
  it("ignores ordinary color", () => {
    expect(hiddenText(`<span style="color: #333">x</span>`).length).toBe(0);
  });
});

describe("tiny-font", () => {
  it("flags 4px font", () => {
    const f = tinyFont(`<span style="font-size: 4px">x</span>`);
    expect(f.length).toBe(1);
    expect(f[0]?.ruleId).toBe("postwave/tiny-font");
  });
  it("accepts 14px font", () => {
    expect(tinyFont(`<span style="font-size: 14px">x</span>`).length).toBe(0);
  });
  it("accepts exactly 9px font (boundary)", () => {
    expect(tinyFont(`<span style="font-size: 9px">x</span>`).length).toBe(0);
  });
});

describe("obfuscated-spam", () => {
  it("flags zero-width chars", () => {
    expect(obfuscatedSpam(`F\u200Bree money`).length).toBeGreaterThan(0);
  });
  it("flags numeric entities for letters", () => {
    expect(obfuscatedSpam(`F&#82;EE`).length).toBeGreaterThan(0);
  });
  it("ignores plain text", () => {
    expect(obfuscatedSpam(`Hello world`).length).toBe(0);
  });
});

describe("runAllRules", () => {
  it("aggregates findings across rules", () => {
    const src = `<img src="a.png"><div style="display:flex; font-size: 4px">x</div>`;
    const findings = runAllRules(src);
    const ids = new Set(findings.map((f) => f.ruleId));
    expect(ids.has("postwave/missing-alt")).toBe(true);
    expect(ids.has("postwave/outlook-unsupported")).toBe(true);
    expect(ids.has("postwave/tiny-font")).toBe(true);
  });
  it("exposes 6 rules", () => {
    expect(ALL_RULES.length).toBe(6);
  });
  it("skips oversized documents with a visible diagnostic instead of running all rules", () => {
    const findings = runAllRules("x".repeat(MAX_LINT_SOURCE_CHARS + 1));
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "postwave/document-too-large",
        severity: "info",
      }),
    ]);
  });
});
