// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { metadata as confirmMetadata } from "@/app/[locale]/forms/[slug]/confirm/[token]/page";
import { metadata as giftMetadata } from "@/app/[locale]/gift/[token]/page";
import { metadata as preferencesMetadata } from "@/app/[locale]/preferences/[token]/page";
import robots from "@/app/robots";
import { locales } from "@/i18n/locales";

describe("tokenized public URL indexing safety", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("blocks every crawler until a release record is approved", () => {
    vi.stubEnv("POSTWAVE_PUBLIC_RELEASE_APPROVAL", "");
    const rules = robots().rules;
    const defaultRule = Array.isArray(rules) ? rules[0] : rules;
    expect(defaultRule).toMatchObject({ userAgent: "*", disallow: "/" });
  });

  it("blocks every localized token surface in robots.txt", () => {
    vi.stubEnv("POSTWAVE_PUBLIC_RELEASE_APPROVAL", "approved:RELEASE-TEST");
    const rules = robots().rules;
    const defaultRule = Array.isArray(rules) ? rules[0] : rules;
    const disallow = Array.isArray(defaultRule?.disallow)
      ? defaultRule.disallow
      : [defaultRule?.disallow];

    for (const locale of locales) {
      expect(disallow).toContain(`/${locale}/forms/`);
      expect(disallow).toContain(`/${locale}/preferences/`);
      expect(disallow).toContain(`/${locale}/gift/`);
    }

    for (const path of ["/accept-invite", "/browser-auth/", "/cli/auth"]) {
      expect(disallow).toContain(path);
    }
  });

  it("adds a metadata noindex backstop to token-bearing pages", () => {
    for (const metadata of [
      confirmMetadata,
      giftMetadata,
      preferencesMetadata,
    ]) {
      expect(metadata.robots).toMatchObject({
        index: false,
        follow: false,
        nocache: true,
      });
    }
  });
});
