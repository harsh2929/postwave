// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure contracts behind the forms parity extras: the spam-settings jsonb
// round-trip (shared with desktop FormSpamSettings), the canonical-embed
// validator (ported from desktop canonicalEmbedFromResponse), and the chart
// CSV builders (spreadsheet-safe, zero-filled UTC windows).
import { describe, expect, it } from "vitest";

import {
  applySpamSettings,
  dailySubmissionVolume,
  parseCanonicalEmbed,
  parseSpamSettings,
  submissionStatusMix,
  validateSpamSettings,
  visitsCsv,
} from "@/lib/forms-extras-api";
import type { FormSettings, FormSubmission } from "@/lib/forms-types";

const BASE: FormSettings = { successMessage: "Thanks!", targetListId: "7" };

describe("spam settings round-trip", () => {
  it("defaults the honeypot on and reads web's older reCAPTCHA toggle as the provider", () => {
    expect(parseSpamSettings(BASE)).toEqual({
      honeypotEnabled: true,
      captchaProvider: "",
      captchaSiteKey: "",
      rateLimitPerMin: "",
    });
    expect(
      parseSpamSettings({
        ...BASE,
        captchaRequired: true,
        recaptchaSiteKey: "6Lc",
      }),
    ).toMatchObject({ captchaProvider: "recaptcha", captchaSiteKey: "6Lc" });
  });

  it("keeps every unrelated key and clears the enforced reCAPTCHA keys for other providers", () => {
    const prior = {
      ...BASE,
      captchaRequired: true,
      recaptchaSiteKey: "6Lc",
    } as FormSettings;
    const next = applySpamSettings(prior, {
      honeypotEnabled: true,
      captchaProvider: "hcaptcha",
      captchaSiteKey: " hc-key ",
      rateLimitPerMin: "",
    });
    expect(next).toEqual({
      successMessage: "Thanks!",
      targetListId: "7",
      honeypotEnabled: true,
      captchaProvider: "hcaptcha",
      captchaSiteKey: "hc-key",
      captchaRequired: false,
    });
  });

  it("drops the provider keys entirely for None", () => {
    const next = applySpamSettings(
      { ...BASE, captchaProvider: "turnstile", captchaSiteKey: "x" } as FormSettings,
      {
        honeypotEnabled: false,
        captchaProvider: "",
        captchaSiteKey: "x",
        rateLimitPerMin: 0,
      },
    );
    expect(next).not.toHaveProperty("captchaProvider");
    expect(next).not.toHaveProperty("captchaSiteKey");
    expect(next).not.toHaveProperty("rateLimitPerMin");
    expect(next.captchaRequired).toBe(false);
  });

  it("validates the rate limit and site key", () => {
    const ok = {
      honeypotEnabled: true,
      captchaProvider: "recaptcha" as const,
      captchaSiteKey: "6Lc",
      rateLimitPerMin: 60 as const,
    };
    expect(validateSpamSettings(ok)).toBeNull();
    expect(validateSpamSettings({ ...ok, rateLimitPerMin: 1.5 })?.rateLimit).toBeTruthy();
    expect(validateSpamSettings({ ...ok, rateLimitPerMin: 1001 })?.rateLimit).toBeTruthy();
    expect(validateSpamSettings({ ...ok, captchaSiteKey: "a b" })?.siteKey).toBeTruthy();
  });
});

describe("parseCanonicalEmbed", () => {
  const good = {
    flavor: "script",
    snippet: "<script></script>",
    language: "html",
    instructions: "Paste it.",
    public_host: "https://forms.acme.test",
    public_url: "https://forms.acme.test/forms/news",
  };

  it("accepts the canonical contract", () => {
    expect(parseCanonicalEmbed(good, "script")).toEqual({
      flavor: "script",
      snippet: "<script></script>",
      language: "html",
      instructions: "Paste it.",
      publicHost: "https://forms.acme.test",
      publicUrl: "https://forms.acme.test/forms/news",
    });
    expect(
      parseCanonicalEmbed(
        { ...good, public_host: "http://localhost:3000", public_url: "http://localhost:3000/forms/news" },
        "script",
      ),
    ).not.toBeNull();
  });

  it.each([
    ["a flavor the request did not ask for", { flavor: "iframe" }],
    ["a blank snippet", { snippet: "  " }],
    ["plaintext off loopback", { public_host: "http://forms.acme.test", public_url: "http://forms.acme.test/forms/news" }],
    ["a cross-origin URL", { public_url: "https://evil.test/forms/news" }],
    ["credentials in the URL", { public_url: "https://u:p@forms.acme.test/forms/news" }],
    ["a URL outside /forms/", { public_url: "https://forms.acme.test/admin" }],
  ])("refuses %s", (_label, patch) => {
    expect(parseCanonicalEmbed({ ...good, ...patch }, "script")).toBeNull();
  });
});

describe("chart CSV builders", () => {
  const now = Date.parse("2026-09-12T12:00:00Z");
  const subs = [
    { submittedAt: "2026-09-12T00:00:00Z", status: "pending" },
    { submittedAt: "2026-09-11T23:59:59Z", status: "confirmed" },
    { submittedAt: "2026-09-09T23:59:59Z", status: "confirmed" },
    { submittedAt: "not a date", status: "confirmed" },
  ] as FormSubmission[];

  it("zero-fills the UTC window and excludes rows before it", () => {
    expect(dailySubmissionVolume(subs, 3, now)).toEqual([
      { date: "2026-09-10", submissions: 0 },
      { date: "2026-09-11", submissions: 1 },
      { date: "2026-09-12", submissions: 1 },
    ]);
    expect(submissionStatusMix(subs, 3, now).map((m) => [m.status, m.submissions, m.share])).toEqual([
      ["confirmed", 1, 50],
      ["pending", 1, 50],
      ["unsubscribed", 0, 0],
    ]);
  });

  it("neutralises a formula smuggled in through wire data", () => {
    expect(visitsCsv([{ date: "=HYPERLINK(\"x\")", count: 1 }])).toBe(
      "Date,Visits\r\n\"'=HYPERLINK(\"\"x\"\")\",1",
    );
  });
});
