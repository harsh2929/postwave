import { describe, expect, it } from "vitest";

import {
  TEMPLATE_GEN_BRIEF_MAX,
  TEMPLATE_GEN_TONE_MAX,
  buildTemplateGenerateBody,
  filterVoiceTemplates,
  generatedTemplatePromptText,
  parseGeneratedTemplate,
  parseVoiceTemplates,
  voiceTemplateCategoryLabel,
  voiceTemplateEmailLines,
  voiceTemplateHasPrompt,
  voiceTemplatePromptText,
  voiceTemplateSummary,
  voiceTemplateTitle,
  voiceTemplateVariableLines,
  voiceTemplateWriteErrorMessage,
  voiceTemplatesErrorMessage,
} from "./voiceTemplates";

describe("parseVoiceTemplates", () => {
  it("reads the BARE ARRAY the server actually sends", () => {
    // listTemplates does writeJSON(w, 200, rows) — no envelope. Desktop's
    // client only understands {templates|items|data}, so this is the case a
    // copied desktop parser would render as an empty library.
    const rows = parseVoiceTemplates([
      { id: "a", name: "Welcome" },
      { id: "b", name: "Launch" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("Welcome");
  });

  it("also reads each envelope key desktop hedges over", () => {
    for (const key of ["templates", "items", "data"]) {
      const rows = parseVoiceTemplates({ [key]: [{ id: "x" }] });
      expect(rows).toHaveLength(1);
    }
  });

  it("drops rows with no id rather than rendering a tile that cannot open", () => {
    const rows = parseVoiceTemplates([
      { id: "keep" },
      { id: "   " },
      { name: "no id" },
      null,
      "string",
    ]);
    expect(rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("answers an empty list for junk instead of throwing", () => {
    expect(parseVoiceTemplates(null)).toEqual([]);
    expect(parseVoiceTemplates(42)).toEqual([]);
    expect(parseVoiceTemplates({ templates: "nope" })).toEqual([]);
  });
});

describe("category labels", () => {
  it("uses the server's vocabulary", () => {
    expect(voiceTemplateCategoryLabel("re_engagement")).toBe("Re-engagement");
    expect(voiceTemplateCategoryLabel("saas_onboarding")).toBe(
      "SaaS onboarding",
    );
  });

  it("title-cases a category the server adds later instead of hiding it", () => {
    expect(voiceTemplateCategoryLabel("holiday_promo")).toBe("Holiday promo");
    expect(voiceTemplateCategoryLabel("")).toBe("Uncategorised");
  });
});

describe("voiceTemplateSummary", () => {
  it("counts the emails the template CARRIES, not the declared length", () => {
    // `length` is metadata; emails[] is what a reader can act on. When they
    // disagree the carried array wins.
    const summary = voiceTemplateSummary({
      category: "welcome",
      length: 9,
      emails: [{ position: 1 }, { position: 2 }],
    });
    expect(summary).toBe("Welcome · 2 emails");
  });

  it("falls back to the declared length when emails are absent", () => {
    expect(voiceTemplateSummary({ category: "crisis", length: 1 })).toBe(
      "Crisis · 1 email",
    );
  });

  it("says only the category when neither count exists", () => {
    expect(voiceTemplateSummary({ category: "sales" })).toBe("Sales");
  });
});

describe("prompt assembly", () => {
  const template = {
    id: "t1",
    name: "Welcome, 2 emails",
    description: "Say hello.",
    emails: [
      { position: 2, subject_skeleton: "Second", body_skeleton: "Body two" },
      {
        position: 1,
        subject_skeleton: "First {{name}}",
        body_skeleton: "Body one",
        notes: "Keep it short",
      },
    ],
    variables: [
      { key: "name", label: "Recipient name", required: true },
      { key: "topic", label: "Topic" },
      { label: "no key — dropped" },
    ],
  };

  it("orders emails by position, not array order", () => {
    expect(voiceTemplateEmailLines(template).map((e) => e.position)).toEqual([
      1, 2,
    ]);
  });

  it("puts every slot and every variable into the copied text", () => {
    const text = voiceTemplatePromptText(template);
    expect(text).toContain("Subject: First {{name}}");
    expect(text).toContain("Body two");
    expect(text).toContain("Note: Keep it short");
    expect(text).toContain("{{name}} — Recipient name (required)");
    expect(text).toContain("{{topic}} — Topic");
    // A variable with no key cannot be substituted, so it is not advertised.
    expect(text).not.toContain("no key — dropped");
    // The first email must come first in the text, mirroring the render.
    expect(text.indexOf("First {{name}}")).toBeLessThan(
      text.indexOf("Second"),
    );
  });

  it("knows when there is nothing to copy", () => {
    expect(voiceTemplateHasPrompt(template)).toBe(true);
    expect(
      voiceTemplateHasPrompt({ id: "x", emails: [{ position: 1 }] }),
    ).toBe(false);
    expect(voiceTemplateHasPrompt({ id: "x" })).toBe(false);
  });

  it("never renders a blank title", () => {
    expect(voiceTemplateTitle({ id: "abc" })).toBe("abc");
    expect(voiceTemplateTitle({ id: "abc", slug: "welcome-3" })).toBe(
      "welcome-3",
    );
    expect(voiceTemplateVariableLines({ id: "x" })).toEqual([]);
  });
});

describe("filterVoiceTemplates", () => {
  const rows = [
    { id: "a", category: "welcome" },
    { id: "b", category: "sales" },
    { id: "c" },
  ];

  it("returns everything for the empty filter", () => {
    expect(filterVoiceTemplates(rows, "")).toHaveLength(3);
    expect(filterVoiceTemplates(rows, "   ")).toHaveLength(3);
  });

  it("matches the category exactly", () => {
    expect(filterVoiceTemplates(rows, "welcome").map((r) => r.id)).toEqual([
      "a",
    ]);
  });
});

describe("buildTemplateGenerateBody", () => {
  it("refuses an empty brief before spending a quota unit", () => {
    const built = buildTemplateGenerateBody("   ", "newsletter", "");
    expect(built.ok).toBe(false);
    expect(built.error).toContain("Describe what to write");
  });

  it("enforces the handler's rune caps, counting CODE POINTS", () => {
    // utf8.RuneCountInString counts runes, so an emoji is ONE character to the
    // server. Measuring .length here would reject a brief the server accepts.
    const emoji = "🙂".repeat(TEMPLATE_GEN_BRIEF_MAX);
    expect(buildTemplateGenerateBody(emoji, "promo", "").ok).toBe(true);
    expect(
      buildTemplateGenerateBody("🙂".repeat(TEMPLATE_GEN_BRIEF_MAX + 1), "promo", "")
        .ok,
    ).toBe(false);
    expect(
      buildTemplateGenerateBody("ok", "promo", "x".repeat(TEMPLATE_GEN_TONE_MAX))
        .ok,
    ).toBe(true);
    expect(
      buildTemplateGenerateBody(
        "ok",
        "promo",
        "x".repeat(TEMPLATE_GEN_TONE_MAX + 1),
      ).ok,
    ).toBe(false);
  });

  it("requires one of the three kinds the server accepts", () => {
    expect(buildTemplateGenerateBody("brief", "", "").ok).toBe(false);
    expect(buildTemplateGenerateBody("brief", "digest", "").ok).toBe(false);
    // The handler lower-cases before checking, so this must be accepted.
    const built = buildTemplateGenerateBody("brief", "  PROMO ", " Warm ");
    expect(built.ok).toBe(true);
    expect(built.body).toEqual({
      brief: "brief",
      kind: "promo",
      tone: "Warm",
    });
  });

  it("omits tone entirely when it is blank", () => {
    const built = buildTemplateGenerateBody("brief", "announcement", "  ");
    expect(built.ok).toBe(true);
    expect(built.body && "tone" in built.body).toBe(false);
  });
});

describe("parseGeneratedTemplate", () => {
  it("accepts a draft with either half present", () => {
    expect(parseGeneratedTemplate({ subject: "Hi" })?.subject).toBe("Hi");
    expect(parseGeneratedTemplate({ body_html: "<p>x</p>" })?.bodyHtml).toBe(
      "<p>x</p>",
    );
  });

  it("treats a 200 carrying nothing usable as no draft at all", () => {
    expect(parseGeneratedTemplate({ name: "Only a name" })).toBeNull();
    expect(parseGeneratedTemplate(null)).toBeNull();
    expect(parseGeneratedTemplate([])).toBeNull();
  });

  it("copies the whole draft", () => {
    const text = generatedTemplatePromptText({
      name: "Spring",
      subject: "Hello",
      bodyHtml: "<p>Body</p>",
    });
    expect(text).toBe("Spring\n\nSubject: Hello\n\n<p>Body</p>");
  });
});

describe("failure sentences", () => {
  it("separates 'no access' from 'not deployed' from 'service down'", () => {
    expect(voiceTemplatesErrorMessage(403)).toContain("campaign read access");
    expect(voiceTemplatesErrorMessage(404)).toContain("doesn't ship");
    expect(voiceTemplatesErrorMessage(503)).toContain("voice service");
  });

  it("prefers the server's own sentence for anything unclassified", () => {
    expect(voiceTemplatesErrorMessage(400, "slug is invalid")).toBe(
      "slug is invalid",
    );
    expect(voiceTemplatesErrorMessage(400, "   ")).toContain("Couldn't load");
  });

  it("names the daily AI budget on a 429 rather than saying 'try again'", () => {
    expect(voiceTemplateWriteErrorMessage(429)).toContain("daily AI budget");
    expect(voiceTemplateWriteErrorMessage(403)).toContain("Only an admin");
    expect(voiceTemplateWriteErrorMessage(503)).toContain(
      "Nothing was changed",
    );
  });
});
