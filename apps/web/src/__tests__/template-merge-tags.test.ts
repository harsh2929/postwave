// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  extractConditionalKeys,
  extractMergeTags,
  runTemplatePreflight,
  templateVariableEntries,
} from "@/lib/template-merge-tags";

describe("extractConditionalKeys", () => {
  it("finds distinct truthy audience conditions", () => {
    expect(extractConditionalKeys("{% if vip %}A{% endif %}{% if subscriber.segment %}B{% endif %}{% if vip %}C{% endif %}"))
      .toEqual(["subscriber.segment", "vip"]);
  });
  it("ignores unsupported comparison expressions", () => {
    expect(extractConditionalKeys("{% if vip == true %}A{% endif %}")).toEqual([]);
  });
});

describe("extractMergeTags", () => {
  it("collects unique `{{ tag }}` keys and sorts them", () => {
    const html =
      '<a href="{{ unsubscribe_url }}">{{first_name}}</a> {{ first_name }} {{company}}';
    expect(extractMergeTags(html)).toEqual([
      "company",
      "first_name",
      "unsubscribe_url",
    ]);
  });

  it("keeps dotted and hyphenated keys", () => {
    expect(extractMergeTags("{{ user.name }} {{ utm-source }}")).toEqual([
      "user.name",
      "utm-source",
    ]);
  });

  it("ignores Handlebars block, section, partial, and comment syntax", () => {
    const html =
      "{{#if x}}{{ name }}{{/if}} {{> header}} {{! comment }} {{^unless}}";
    expect(extractMergeTags(html)).toEqual(["name"]);
  });

  it("takes the leading token of a helper expression", () => {
    // `{{ name fallback }}` — the merge key is the first token.
    expect(extractMergeTags("{{ name fallback }}")).toEqual(["name"]);
    expect(extractMergeTags("{{name|upper}} {{ company | trim }}")).toEqual(["company", "name"]);
  });

  it("returns an empty array when there are no tags", () => {
    expect(extractMergeTags("<p>Hello</p>")).toEqual([]);
  });
});

describe("templateVariableEntries", () => {
  it("reads key + default/example/value across shapes and preserves order", () => {
    const entries = templateVariableEntries([
      { key: "first_name", default: "Ada" },
      { name: "company", example: "Moosewave" },
      { key: "cta", value: "Read more" },
      { key: "empty" },
      { label: "no-key" },
    ]);
    expect(entries).toEqual([
      { key: "first_name", value: "Ada" },
      { key: "company", value: "Moosewave" },
      { key: "cta", value: "Read more" },
      { key: "empty", value: "" },
    ]);
  });

  it("returns an empty list for missing variables", () => {
    expect(templateVariableEntries(undefined)).toEqual([]);
    expect(templateVariableEntries([])).toEqual([]);
  });
});

describe("runTemplatePreflight", () => {
  it("warns for unsafe links and unsupported conditional expressions", () => {
    const checks = runTemplatePreflight('<a href="javascript:alert(1)">Bad</a>{% if vip == true %}Offer{% endif %}');
    expect(checks.find((item) => item.id === "unsafe-links")?.status).toBe("warn");
    expect(checks.find((item) => item.id === "conditional-syntax")?.status).toBe("warn");
    const safe = runTemplatePreflight('<a href="https://example.invalid">Read</a>{% if vip %}Offer{% endif %}');
    expect(safe.find((item) => item.id === "unsafe-links")?.status).toBe("pass");
    expect(safe.find((item) => item.id === "conditional-syntax")?.status).toBe("pass");
    const incomplete = runTemplatePreflight('{% if vip');
    expect(incomplete.find((item) => item.id === "conditional-syntax")?.status).toBe("warn");
  });
  it("catches empty and vague links without flagging meaningful image alt text", () => {
    const bad = runTemplatePreflight('<a href="https://example.invalid">Click here</a><a href="https://example.invalid"><img alt=""></a>');
    expect(bad.find((item) => item.id === "link-text")?.status).toBe("warn");
    const good = runTemplatePreflight('<a href="https://example.invalid"><img alt="View the autumn collection"></a>');
    expect(good.find((item) => item.id === "link-text")?.status).toBe("pass");
  });
  it("warns when no unsubscribe link is present and passes when it is", () => {
    const warn = runTemplatePreflight("<p>no footer here</p>");
    expect(warn.find((c) => c.id === "unsubscribe")?.status).toBe("warn");

    const ok = runTemplatePreflight(
      '<a href="{{ unsubscribe_url }}">Unsubscribe</a>',
    );
    expect(ok.find((c) => c.id === "unsubscribe")?.status).toBe("pass");
    const listmonkSpelling = runTemplatePreflight(
      '<a href="{{UnsubscribeURL}}">Leave</a>',
    );
    expect(listmonkSpelling.find((c) => c.id === "unsubscribe")?.status).toBe(
      "pass",
    );
  });

  it("does not pass a fixed unsubscribe link or footer wording the send gate refuses", () => {
    for (const source of [
      '<a href="https://example.com/unsubscribe">Unsubscribe</a>',
      "<p>To unsubscribe, manage preferences in your account.</p>",
      '<a href="{{ unsubscribe_link }}">Unsubscribe</a>',
    ]) {
      const check = runTemplatePreflight(source).find(
        (c) => c.id === "unsubscribe",
      );
      expect(check?.status, source).toBe("warn");
      expect(check?.detail).toContain("{{ unsubscribe_url }}");
    }
  });

  it("warns about images missing alt text and counts them", () => {
    const html = '<img src="a.png"><img src="b.png" alt="ok">';
    const check = runTemplatePreflight(html).find((c) => c.id === "image-alt");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("1");
  });

  it("checks MJML images before they are compiled into HTML", () => {
    const source =
      '<mj-image src="https://example.com/a.png" /><mj-image src="https://example.com/b.png" alt="Map" />';
    const check = runTemplatePreflight(source).find(
      (item) => item.id === "image-alt",
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("1 of 2");
  });

  it("passes image-alt when every image has non-empty alt", () => {
    const html = '<img src="a.png" alt="A"><img src="b.png" alt="B">';
    const check = runTemplatePreflight(html).find((c) => c.id === "image-alt");
    expect(check?.status).toBe("pass");
  });

  it("accepts empty alt for a decorative image but not a missing attribute", () => {
    const decorative = runTemplatePreflight('<img src="divider.png" alt="">');
    expect(decorative.find((item) => item.id === "image-alt")?.status).toBe("pass");
    const missing = runTemplatePreflight('<img src="divider.png">');
    expect(missing.find((item) => item.id === "image-alt")?.status).toBe("warn");
  });

  it("checks inbox metadata and only sizes a current compiled render", () => {
    const source = '<p>Hi</p><a href="{{ unsubscribe_url }}">Leave</a>';
    const draft = runTemplatePreflight(source, {
      subject: "",
      previewText: "",
      compiledHtml: null,
    });
    for (const id of ["subject", "preview-text", "compiled-render", "message-size"]) {
      expect(draft.find((item) => item.id === id)?.status).toBe("warn");
    }
    const ready = runTemplatePreflight(source, {
      subject: "A useful update",
      previewText: "This week at Moosewave",
      compiledHtml: source,
    });
    for (const id of ["subject", "preview-text", "compiled-render", "message-size"]) {
      expect(ready.find((item) => item.id === id)?.status).toBe("pass");
    }
  });

  it("reports the merge variables the template expects", () => {
    const check = runTemplatePreflight("{{ first_name }} {{ company }}").find(
      (c) => c.id === "merge-tags",
    );
    expect(check?.detail).toContain("company");
    expect(check?.detail).toContain("first_name");
  });

  it("warns when mustache braces are unbalanced", () => {
    const check = runTemplatePreflight("{{ oops }").find(
      (c) => c.id === "malformed-tags",
    );
    expect(check?.status).toBe("warn");
  });

  it("catches starter CTA links that must be replaced before send", () => {
    const check = runTemplatePreflight(
      '<mj-button href="https://example.com">Go</mj-button>',
    ).find((item) => item.id === "placeholder-links");
    expect(check?.status).toBe("warn");
  });
});
