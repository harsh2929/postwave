import { describe, expect, it } from "vitest";

import type { UTMTemplate } from "../../lib/api-client";
import {
  EMPTY_UTM_FORM,
  formFromTemplate,
  MAX_UTM_PREVIEW_URL_CHARS,
  MAX_UTM_VALUE_CHARS,
  templateSummary,
  validateUTMForm,
  validateUTMPreviewUrl,
} from "../../components/composer/utm-template-helpers";

function template(overrides: Partial<UTMTemplate> = {}): UTMTemplate {
  return {
    id: "template-1",
    is_default: true,
    enabled: true,
    created_at: "2026-07-16T09:00:00.000Z",
    updated_at: "2026-07-16T09:00:00.000Z",
    ...overrides,
  };
}

describe("UTM template helpers", () => {
  it("summarizes and hydrates every parameter without fabricating values", () => {
    const value = template({
      utm_source: "newsletter",
      utm_campaign: "{{campaign_name}}",
    });
    expect(templateSummary(value)).toBe(
      "utm_source=newsletter · utm_campaign={{campaign_name}}",
    );
    expect(formFromTemplate(value)).toEqual({
      utm_source: "newsletter",
      utm_medium: "",
      utm_campaign: "{{campaign_name}}",
      utm_term: "",
      utm_content: "",
    });
    expect(templateSummary(template())).toBe("(no parameters)");
  });

  it("trims a non-empty form and enforces Unicode-aware field bounds", () => {
    expect(
      validateUTMForm({
        ...EMPTY_UTM_FORM,
        utm_source: "  newsletter  ",
      }),
    ).toEqual({ input: { utm_source: "newsletter" }, ok: true });
    const empty = validateUTMForm(EMPTY_UTM_FORM);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error).toBe("Enter at least one UTM parameter.");
    }
    const oversized = validateUTMForm({
      ...EMPTY_UTM_FORM,
      utm_content: "😀".repeat(MAX_UTM_VALUE_CHARS + 1),
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error).toContain(`${MAX_UTM_VALUE_CHARS} characters`);
    }
  });

  it("accepts only bounded absolute HTTP(S) preview URLs", () => {
    expect(validateUTMPreviewUrl(" https://example.test/a?b=c ")).toEqual({
      ok: true,
      url: "https://example.test/a?b=c",
    });
    const mailto = validateUTMPreviewUrl("mailto:alice@example.test");
    expect(mailto.ok).toBe(false);
    if (!mailto.ok) expect(mailto.error).toContain("http:// or https://");
    const relative = validateUTMPreviewUrl("relative/path");
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.error).toContain("valid absolute URL");
    const oversized = validateUTMPreviewUrl(
      `https://example.test/${"a".repeat(MAX_UTM_PREVIEW_URL_CHARS)}`,
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error).toContain(
        `${MAX_UTM_PREVIEW_URL_CHARS} characters`,
      );
    }
  });
});
