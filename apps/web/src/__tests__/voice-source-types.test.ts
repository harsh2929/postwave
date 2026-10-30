// SPDX-License-Identifier: AGPL-3.0-only
//
// The quickstart ships a copy-paste curl that adds a voice source:
//
//   -d '{ "type": "blog_rss", "params": { … } }'
//
// It used to send "rss", which is not a SourceType — the enum in
// services/voice/internal/ingest/source.go is newsletter_archive, twitter,
// blog_rss, podcast_transcript, linkedin_export, paste_in. The dashboard's
// own voice-sources card already used blog_rss, so the docs were the only
// place teaching a value the service does not accept.
//
// Same failure shape as the dead sending endpoints and the body-only webhook
// signature: an instruction that fails the first time someone runs it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

/** SourceType constants declared by the voice service. */
function sourceTypes(): string[] {
  const go = readFileSync(
    join(REPO, "services/voice/internal/ingest/source.go"),
    "utf8",
  );
  return [...go.matchAll(/SourceType\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("voice source types in the docs", () => {
  const valid = sourceTypes();

  it("reads the enum", () => {
    // Guard the guard: an empty enum would accept anything below.
    expect(valid).toContain("blog_rss");
    expect(valid.length).toBeGreaterThan(3);
  });

  it("passes every variable the quoted sequence template requires", () => {
    // The sequence sample posted { "template_id": "tpl_welcome_3", variables:
    // { founder_name, product_name } }. No template has that id — ids are
    // UUIDs assigned at seed time, slugs are the stable handle — and neither
    // variable exists on any template. welcome-3-email actually requires five.
    const quickstart = readFileSync(
      join(SRC, "app/(docs)/docs/quickstart/page.tsx"),
      "utf8",
    );
    const slug = /select\(\.slug == "([a-z0-9-]+)"\)/.exec(quickstart);
    expect(slug).not.toBeNull();

    const template = JSON.parse(
      readFileSync(
        join(
          REPO,
          "services/voice/internal/templates/embedded",
          `${slug![1]}.json`,
        ),
        "utf8",
      ),
    ) as { variables: { key: string; required?: boolean }[] };

    const required = template.variables
      .filter((v) => v.required)
      .map((v) => v.key);
    expect(required.length).toBeGreaterThan(0);
    // Match on the key name alone: the sample lives inside a TS template
    // literal, so its quotes are backslash-escaped in the source and any
    // assumption about the exact escaping depth is fragile.
    const missing = required.filter((k) => !quickstart.includes(k));
    expect(missing).toEqual([]);

    // And no invented identifier shape.
    expect(quickstart).not.toMatch(/tpl_[a-z0-9_]+/);
  });

  it("only sends values the service accepts", () => {
    const quickstart = readFileSync(
      join(SRC, "app/(docs)/docs/quickstart/page.tsx"),
      "utf8",
    );
    // The voice-source call is the one posting to /api/v1/voice/sources.
    const call = /voice\/sources[\s\S]{0,400}?"type":\s*\\?"([a-z_]+)\\?"/.exec(
      quickstart,
    );
    expect(call).not.toBeNull();
    expect(valid).toContain(call![1]!);
  });
});
