// SPDX-License-Identifier: AGPL-3.0-only
//
// /migrate-anywhere documents an actual Go module, so its install and
// contributor instructions have to match what the module declares.
//
//   * It said "Go 1.23 or later" while go.mod requires go 1.25.0 — anyone
//     following the page on 1.23 cannot build it.
//   * It told contributors to implement "GetArchive", which is not a method on
//     the Adapter interface; the real one is ListCampaignArchive, and the
//     required Capabilities and Discover methods were not mentioned at all.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const MIGRATE = join(REPO, "packages/migrate");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/migrate-anywhere/page.tsx"),
  "utf8",
);
const GO_MOD = readFileSync(join(REPO, "packages/migrate/go.mod"), "utf8");
const ADAPTER = readFileSync(
  join(REPO, "packages/migrate/adapter/adapter.go"),
  "utf8",
);

/** Method names declared on the exported Adapter interface. */
function adapterMethods(): string[] {
  const block = /type Adapter interface \{([\s\S]*?)\}/.exec(ADAPTER);
  if (!block) return [];
  return [...block[1]!.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]!);
}

/**
 * Source platforms the module actually ships, read from the `adapter.Register`
 * call every adapter package makes in its init(). Deriving this is the point:
 * the page fell eleven adapters behind the module while a hardcoded list of
 * eight sat in this file, and AWeber was published as something still to be
 * contributed months after its adapter shipped.
 */
function registeredSources(): { dir: string; constant: string }[] {
  const out: { dir: string; constant: string }[] = [];
  for (const entry of readdirSync(MIGRATE)) {
    const file = join(MIGRATE, entry, "adapter.go");
    if (!statSync(join(MIGRATE, entry)).isDirectory()) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const m = /adapter\.Register\(\s*canonical\.(Source\w+)/.exec(text);
    if (m) out.push({ dir: entry, constant: m[1]! });
  }
  return out;
}

/** "Constant Contact" and "constant-contact" have to compare equal. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The `source:` labels in the page's capability table. */
function tableSources(): string[] {
  return [...PAGE.matchAll(/^\s*source:\s*"([^"]+)",/gm)].map((m) => m[1]!);
}

describe("@postwave/migrate page matches the module", () => {
  it("reads the module metadata", () => {
    // Guard the guard: a moved go.mod or renamed interface must fail loudly.
    expect(GO_MOD).toMatch(/^module /m);
    expect(adapterMethods().length).toBeGreaterThan(4);
  });

  it("names the module path the module declares", () => {
    const declared = /^module\s+(\S+)/m.exec(GO_MOD)![1]!;
    expect(PAGE).toContain(declared);
  });

  it("states a Go version the module can actually build on", () => {
    const required = /^go\s+(\d+)\.(\d+)/m.exec(GO_MOD)!;
    const claimed = /Go (\d+)\.(\d+) or later/.exec(PAGE);
    expect(claimed).not.toBeNull();
    const asNumber = (major: string, minor: string): number =>
      Number(major) * 1000 + Number(minor);
    expect(asNumber(claimed![1]!, claimed![2]!)).toBeGreaterThanOrEqual(
      asNumber(required[1]!, required[2]!),
    );
  });

  it("states the number of platforms the module registers", () => {
    // registeredSources() was already derived here for the capability rows,
    // but nothing asserted the headline count beside it — the exact shape
    // (a hardcoded number next to a derivable list) that has produced most of
    // the drift found in this audit. It is right today: 20 packages call
    // adapter.Register, and the FAQ's own breakdown resolves to the same
    // total (10 named API sources + Sendy + 8 CSV-export platforms + the
    // generic CSV fallback).
    const registered = registeredSources();
    expect(registered.length).toBeGreaterThan(10); // guard the guard
    const claims = [...PAGE.matchAll(/(\d+) newsletter and CRM platforms/g)].map(
      (m) => Number(m[1]),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(registered.length);
  });

  it("names no source platform the module does not register", () => {
    // The intro enumerates a subset by name. A name here that no adapter
    // backs is a platform a reader would pick Moosewave for and then not find.
    const known = new Set(registeredSources().map((s) => squash(s.dir)));
    const intro =
      /MIT-licensed Go module that reads from \d+ newsletter and CRM platforms — ([^"]+?) — into/.exec(
        PAGE,
      );
    expect(intro, "intro enumeration not found").not.toBeNull();
    const named = intro![1]!
      .split(",")
      .map((n) => n.replace(/^\s*and\s+/, "").trim())
      .filter((n) => n && !/csv exports?/i.test(n));
    expect(named.length).toBeGreaterThan(5); // guard the guard
    const phantom = named.filter((n) => !known.has(squash(n)));
    expect(phantom.sort()).toEqual([]);
  });

  it("matches each capability row to the adapter's own flags", () => {
    // The table said ConvertKit had no paid-subscription support (its adapter
    // sets Supports.PaidSubs = true and implements ListPaidSubs) and that
    // Beehiiv did (Supports.PaidSubs = false — its guide is explicit that no
    // Stripe billing objects migrate). Brevo was missing from the table
    // entirely while the FAQ listed it as supported.
    const rows = [
      ...PAGE.matchAll(/source:\s*"([^"]+)",[\s\S]*?paid:\s*(true|false),/g),
    ].map((m) => ({ source: m[1]!, paid: m[2] === "true" }));
    expect(rows.length).toBeGreaterThan(6);

    const wrong: string[] = [];
    for (const { dir } of registeredSources()) {
      // A row covers an adapter when its label contains that adapter's name —
      // "ConvertKit / Kit" covers convertkit, and the shared CSV-export row
      // covers all eight of its platforms.
      const row = rows.find((r) => squash(r.source).includes(squash(dir)));
      if (!row) continue; // reported by the coverage test below
      const declared = /Supports\.PaidSubs\s*=\s*(true|false)/.exec(
        readFileSync(join(MIGRATE, dir, "adapter.go"), "utf8"),
      );
      if (!declared) continue;
      if ((declared[1] === "true") !== row.paid) {
        wrong.push(
          `${row.source}: table paid=${row.paid}, ${dir} PaidSubs=${declared[1]}`,
        );
      }
    }
    expect(wrong.sort()).toEqual([]);
  });

  it("lists every adapter the module registers", () => {
    // The page shipped nine of the twenty registered adapters — Klaviyo and
    // Customer.io, both full API adapters, were absent from a table headed
    // "Adapter capability matrix", as were Sendy and the eight CSV-export
    // sources.
    const labels = tableSources().map(squash);
    expect(labels.length).toBeGreaterThan(8); // guard the guard
    const registered = registeredSources();
    expect(registered.length).toBeGreaterThan(15);

    const missing = registered
      .filter(({ dir }) => !labels.some((l) => l.includes(squash(dir))))
      .map(({ dir }) => dir);
    expect(missing.sort()).toEqual([]);
  });

  it("does not solicit contributions for adapters that already ship", () => {
    // "Ghost, Buttondown, and AWeber are open contribution targets" appeared
    // twice while aweber/adapter.go was registered and shipping — sending a
    // contributor off to rebuild something the module already had.
    const registered = new Set(registeredSources().map(({ dir }) => dir));
    const solicited = new Set<string>();
    for (const re of [
      /([A-Z][\w.]*(?:,\s*[A-Z][\w.]*)*,?\s*and\s+[A-Z][\w.]*)\s+are open contribution targets/g,
      /contribute new source\s+platforms \(([^)]+)\)/g,
    ]) {
      for (const m of PAGE.matchAll(re)) {
        for (const name of m[1]!.split(/,|\band\b/)) {
          const clean = squash(name);
          if (clean) solicited.add(clean);
        }
      }
    }
    expect(solicited.size).toBeGreaterThan(1); // guard the guard
    const shipped = [...solicited].filter((name) =>
      [...registered].some((dir) => squash(dir) === name),
    );
    expect(shipped.sort()).toEqual([]);
  });

  it("does not describe migration as one-click", () => {
    // Every guide on the site is emphatic that migration is dry-run-first with
    // review gates, and a prior audit already removed "one-click migration"
    // from the @postwave/migrate README for exactly that reason. It came back
    // on three pages. Deliverability's "one-click fix" and the RFC 8058
    // "one-click unsubscribe" are different, real features and stay.
    const offenders: string[] = [];
    for (const rel of [
      "app/(marketing)/migrate-anywhere/page.tsx",
      "app/(marketing)/vs/mailchimp/page.tsx",
      "app/(marketing)/migrations/[from]/page.tsx",
      "app/(docs)/docs/migrations/[source]/page.tsx",
    ]) {
      const text = readFileSync(join(SRC, rel), "utf8");
      if (/one-click[\s\w]{0,12}migration/i.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("only names Adapter methods that exist", () => {
    const methods = adapterMethods();
    // The contributor answer lists the interface inline; every CamelCase name
    // in that parenthetical must be a real method.
    const listed = /implements the Adapter interface \(([^)]+)\)/.exec(PAGE);
    expect(listed).not.toBeNull();
    const named = listed![1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Z]\w+$/.test(s));
    expect(named.length).toBeGreaterThan(3);
    const unknown = named.filter((n) => !methods.includes(n));
    expect(unknown).toEqual([]);
  });
});
