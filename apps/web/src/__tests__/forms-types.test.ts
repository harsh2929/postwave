import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  DEFAULT_STRUCTURE,
  compileFormHtml,
  isSurvey,
  safeFormSuccessRedirectUrl,
  safeCustomFieldKey,
  slugify,
  validateFormSlug,
} from "@/lib/forms-types";

describe("slugify", () => {
  it("keeps generated slugs URL-safe", () => {
    expect(slugify(" Jane's Newsletter! ")).toBe("janes-newsletter");
  });

  it("validates the same URL-unreserved slug shape as the gateway", () => {
    expect(validateFormSlug("launch_2026~v2")).toBeNull();
    expect(validateFormSlug("launch/signup")).toMatch(/only letters/i);
    expect(validateFormSlug(" ")).toBe("Slug is required.");
    expect(validateFormSlug("x".repeat(129))).toMatch(/128/);
  });
});

describe("safeFormSuccessRedirectUrl", () => {
  it("allows https, local development http, and root-relative redirects", () => {
    expect(safeFormSuccessRedirectUrl("https://example.com/thanks#frag")).toBe(
      "https://example.com/thanks",
    );
    expect(safeFormSuccessRedirectUrl("http://localhost:3000/thanks")).toBe(
      "http://localhost:3000/thanks",
    );
    expect(safeFormSuccessRedirectUrl("/forms/success?ok=1")).toBe(
      "/forms/success?ok=1",
    );
  });

  it("rejects unsafe success redirects", () => {
    expect(safeFormSuccessRedirectUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeFormSuccessRedirectUrl("https://u:p@example.com/thanks"),
    ).toBeNull();
    expect(safeFormSuccessRedirectUrl("//evil.example/thanks")).toBeNull();
    expect(
      safeFormSuccessRedirectUrl("/bad\nLocation: https://evil.example"),
    ).toBeNull();
    expect(
      safeFormSuccessRedirectUrl("/bad%0d%0aLocation:https://evil.example"),
    ).toBeNull();
  });
});

describe("compileFormHtml", () => {
  it("renders the configured reCAPTCHA checkbox before submit", () => {
    const html = compileFormHtml({
      id: "form_1",
      tenantId: "tenant_1",
      slug: "launch",
      name: "Launch",
      optInMode: "single",
      structure: DEFAULT_STRUCTURE,
      settings: DEFAULT_SETTINGS,
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
      captchaRequired: true,
      recaptchaSiteKey: 'site-key"><script>',
    });
    expect(html).toContain('class="g-recaptcha"');
    expect(html).toContain('data-sitekey="site-key&quot;&gt;&lt;script&gt;"');
    expect(html).toContain("https://www.google.com/recaptcha/api.js");
    expect(html.indexOf("g-recaptcha")).toBeLessThan(html.indexOf("pw-submit"));
  });

  it("uses one canonical custom-field key sanitizer", () => {
    expect(safeCustomFieldKey("  Favorite color / shade  ")).toBe(
      "Favorite_color_shade",
    );
  });
  it("routes file-upload forms through the survey renderer", () => {
    expect(
      isSurvey({
        fields: [
          {
            id: "resume",
            kind: "file_upload",
            label: "Resume",
            required: true,
          },
        ],
      }),
    ).toBe(true);
  });

  it("encodes hosted form slugs in the default action URL", () => {
    const html = compileFormHtml({
      id: "form_1",
      tenantId: "tenant_1",
      slug: "launch/signup?x=1",
      name: "Launch",
      optInMode: "single",
      structure: DEFAULT_STRUCTURE,
      settings: DEFAULT_SETTINGS,
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
    });

    expect(html).toContain(
      'action="/api/public/forms/launch%2Fsignup%3Fx%3D1/submit"',
    );
  });

  it("escapes field text and clamps malformed scale ranges", () => {
    const html = compileFormHtml({
      id: "form_1",
      tenantId: "tenant_1",
      slug: "launch",
      name: "Launch",
      optInMode: "single",
      structure: {
        fields: [
          {
            id: "heading",
            kind: "heading",
            label: "Heading",
            content: `<script>alert("x")</script>`,
            required: false,
          },
          {
            id: "scale",
            kind: "scale",
            label: `Score <img src=x onerror=alert(1)>`,
            required: true,
            scaleMin: -50,
            scaleMax: 5000,
          },
        ],
      },
      settings: {
        ...DEFAULT_SETTINGS,
        styleClass: `" onclick="alert(1)`,
      },
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onclick="alert(1)');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html.match(/class="pw-scale-opt"/g)).toHaveLength(11);
    expect(html).toContain('value="0"');
    expect(html).toContain('value="10"');
    expect(html).not.toContain('value="11"');
  });

  it("explains empty authored choice fields without injecting localized copy", () => {
    const html = compileFormHtml(
      {
        id: "form_empty_choices",
        tenantId: "tenant_1",
        slug: "empty-choices",
        name: "Empty choices",
        optInMode: "single",
        structure: {
          fields: [
            {
              id: "radio",
              kind: "radio",
              label: "Pick one",
              required: true,
              options: [],
            },
            {
              id: "select",
              kind: "select",
              label: "Pick another",
              required: true,
              options: [],
            },
          ],
        },
        settings: DEFAULT_SETTINGS,
        status: "published",
        createdAt: "2026-05-20T00:00:00Z",
        updatedAt: "2026-05-20T00:00:00Z",
      },
      { noOptionsMessage: `No options <script>alert("x")</script>` },
    );

    expect(html.match(/class="pw-field-error"/g)).toHaveLength(2);
    expect(html).toContain(
      "No options &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(html).not.toContain("<script>alert");
  });

  it("sanitizes custom field names and file accept lists in compiled HTML", () => {
    const html = compileFormHtml({
      id: "form_1",
      tenantId: "tenant_1",
      slug: "launch",
      name: "Launch",
      optInMode: "single",
      structure: {
        fields: [
          {
            id: `bad key"><script>`,
            kind: "custom",
            label: "Custom",
            required: false,
            customKey: `tier"><img src=x>`,
            placeholder: "x".repeat(700),
          },
          {
            id: "asset",
            kind: "file_upload",
            label: "Asset",
            required: false,
            customKey: "asset",
            acceptMime: [
              "image/png",
              "text/html,onchange=alert(1)",
              ".PDF",
              "application/pdf",
              "image/png",
            ],
          },
        ],
      },
      settings: DEFAULT_SETTINGS,
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
    });

    expect(html).toContain('name="cf_tier_img_src_x"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onchange");
    expect(html).toContain('accept="image/png,.pdf,application/pdf"');
    expect(html).not.toContain("x".repeat(600));
  });

  it("caps compiled field and option counts", () => {
    const manyFieldsHtml = compileFormHtml({
      id: "form_1",
      tenantId: "tenant_1",
      slug: "launch",
      name: "Launch",
      optInMode: "single",
      structure: {
        fields: [
          ...Array.from({ length: 120 }, (_, i) => ({
            id: `field_${i}`,
            kind: "custom" as const,
            label: `Field ${i}`,
            required: false,
            customKey: `field_${i}`,
          })),
        ],
      },
      settings: DEFAULT_SETTINGS,
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
    });

    expect(manyFieldsHtml.match(/class="pw-field"/g)).toHaveLength(100);
    expect(manyFieldsHtml).toContain('name="cf_field_99"');
    expect(manyFieldsHtml).not.toContain('name="cf_field_100"');

    const manyOptionsHtml = compileFormHtml({
      id: "form_2",
      tenantId: "tenant_1",
      slug: "launch",
      name: "Launch",
      optInMode: "single",
      structure: {
        fields: [
          {
            id: "many_options",
            kind: "select",
            label: "Many",
            required: false,
            options: Array.from({ length: 140 }, (_, i) => ({
              label: `Option ${i}`,
            })),
          },
        ],
      },
      settings: DEFAULT_SETTINGS,
      status: "published",
      createdAt: "2026-05-20T00:00:00Z",
      updatedAt: "2026-05-20T00:00:00Z",
    });

    expect(manyOptionsHtml).toContain(">Option 99</option>");
    expect(manyOptionsHtml).not.toContain(">Option 100</option>");
  });
});
