// SPDX-License-Identifier: AGPL-3.0-only
//
// Each migration adapter declares what it can carry across as `Supports.*`
// booleans, and each source has a docs guide with a `migrates:` list. Nothing
// connected the two, so guides promised resources the adapter never fetches:
//
//   * ConvertKit "Forms (recreated as hosted Moosewave forms)" and, on the
//     marketing page, "Forms and landing pages" plus "Visual Automations
//     (canonical translations)" — the adapter sets Supports.Forms = false and
//     Supports.LandingPages = false, has no ListForms/ListLandingPages at all,
//     and ListAutomations reads /sequences, never the visual-builder graph.
//   * Brevo "Transactional templates (HTML preserved, dynamic placeholders
//     mapped to Moosewave variables)" — Supports.Templates = false, and
//     /v3/smtp/templates is queried only to produce a discovery count.
//
// Counting a resource during discovery is not migrating it, and that is
// exactly the distinction the copy kept losing. A `migrates:` entry for a
// resource the adapter declares unsupported fails here.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const DOCS = join(SRC, "app/(docs)/docs/migrations/[source]/page.tsx");

/** Capability flags a source adapter declares, e.g. {Forms: false}. */
function adapterSupports(slug: string): Record<string, boolean> {
  const file = join(REPO, "packages/migrate", slug, "adapter.go");
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const out: Record<string, boolean> = {};
  for (const m of text.matchAll(/Supports\.(\w+)\s*=\s*(true|false)/g)) {
    out[m[1]!] = m[2] === "true";
  }
  return out;
}

/** slug → the guide's `migrates:` bullet list. */
function migratesClaims(): Map<string, string[]> {
  const whole = readFileSync(DOCS, "utf8");
  const start = whole.search(/^const GUIDES[^=]*=\s*\{/m);
  const text = start === -1 ? whole : whole.slice(start);
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/^ {2}"?([a-z0-9-]+)"?:\s*\{(.*?)^ {2}\},/gms)) {
    const key = m[1]!;
    const body = m[2]!;
    if (!new RegExp(`slug:\\s*"${key}"`).test(body)) continue;
    const list = /migrates:\s*\[(.*?)\]/s.exec(body);
    if (!list) continue;
    out.set(key, [...list[1]!.matchAll(/"([^"]+)"/g)].map((e) => e[1]!));
  }
  return out;
}

// A claim counts as "this resource migrates" only when the bullet leads with
// the resource. "Form and ecommerce-shop metadata as source-archive evidence"
// is an honest description of preserved evidence, not a migration promise.
const RESOURCES: { flag: string; leads: RegExp }[] = [
  { flag: "Forms", leads: /^forms?\b(?!.*\bmetadata\b)/i },
  { flag: "LandingPages", leads: /^landing pages?\b(?!.*\bmetadata\b)/i },
  { flag: "Templates", leads: /^(?:transactional )?templates?\b(?!.*\bmetadata\b)/i },
];

describe("migration guides only promise what the adapter supports", () => {
  const claims = migratesClaims();

  it("parses guides and adapters", () => {
    // Guard the guard: empty maps would make the sweep below vacuous.
    expect(claims.size).toBeGreaterThan(8);
    expect(Object.keys(adapterSupports("convertkit")).length).toBeGreaterThan(3);
  });

  it("never lists a resource the adapter declares unsupported", () => {
    const overclaims: string[] = [];
    for (const [slug, bullets] of claims) {
      const supports = adapterSupports(slug);
      for (const bullet of bullets) {
        for (const { flag, leads } of RESOURCES) {
          if (supports[flag] !== false) continue;
          if (!leads.test(bullet.trim())) continue;
          overclaims.push(`${slug}: Supports.${flag}=false but migrates "${bullet}"`);
        }
      }
    }
    expect(overclaims.sort()).toEqual([]);
  });

  it("keeps the docs migrations index consistent with the guides", () => {
    // A third list, covered by neither the `migrates:` sweep nor the marketing
    // parity test: /docs/migrations renders its own SOURCES array of blurbs.
    // It still said ConvertKit was an "API key import" after the guide was
    // corrected to OAuth, and still claimed Brevo brought across transactional
    // templates after that claim was removed for Supports.Templates = false.
    const index = readFileSync(
      join(SRC, "app/(docs)/docs/migrations/page.tsx"),
      "utf8",
    );
    const blurb = (slug: string): string =>
      new RegExp(`slug: "${slug}"[\\s\\S]*?blurb:\\s*\\n?\\s*"([^"]+)"`).exec(
        index,
      )?.[1] ?? "";

    // ConvertKit's adapter declares oauth2; the index must not call it an
    // API-key import as though that were the primary path.
    const ck = blurb("convertkit");
    expect(ck).not.toBe("");
    expect(/^API key import/i.test(ck)).toBe(false);

    // Brevo templates are unsupported, so the blurb may mention them only to
    // say they do not come across.
    const brevo = blurb("brevo");
    expect(brevo).not.toBe("");
    if (/templates/i.test(brevo)) {
      expect(/not imported|counted, not/i.test(brevo)).toBe(true);
    }
  });

  it("never claims ConvertKit Visual Automations are translated", () => {
    // This one survived in three separate files after the first fix: the
    // marketing guide's `preserves` list, its FAQ answer (which is also
    // emitted as schema.org JSON-LD, so search engines were served it too),
    // and the /vs/convertkit migration steps. ListAutomations reads
    // /sequences and /sequences/{id}/emails — the visual-builder node graph
    // is never fetched, so no translation of it can exist.
    const adapter = readFileSync(
      join(REPO, "packages/migrate/convertkit/adapter.go"),
      "utf8",
    );
    // Guard the guard: if the adapter ever does read the automations graph,
    // this assertion is what tells us the copy may be updated.
    expect(adapter).not.toMatch(/"\/automations/);

    const offenders: string[] = [];
    for (const rel of [
      "app/(marketing)/migrations/[from]/page.tsx",
      "app/(marketing)/migrations/page.tsx",
      "app/(marketing)/vs/convertkit/page.tsx",
      "app/(docs)/docs/migrations/[source]/page.tsx",
    ]) {
      const text = readFileSync(join(SRC, rel), "utf8").replace(
        /\{\s*\/\*[\s\S]*?\*\/\s*\}/g,
        "",
      );
      if (/visual automations? (?:are )?translated|translates visual automation/i.test(text)) {
        offenders.push(rel);
      }
      // The migrations index listed ConvertKit as bringing across "sequences,
      // custom fields, automations" — a bare "automations" in a ConvertKit
      // capability note reads as the visual builder, which is never exported.
      // Only flag it when the sentence does not already say they are not
      // imported.
      for (const m of text.matchAll(/name: "ConvertKit[^"]*",\s*note: "([^"]*)"/g)) {
        const note = m[1]!;
        if (/\bautomations\b/i.test(note) && !/not imported|rebuild/i.test(note)) {
          offenders.push(`${rel} (ConvertKit note)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
