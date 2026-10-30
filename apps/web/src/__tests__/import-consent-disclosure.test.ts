// SPDX-License-Identifier: AGPL-3.0-only
//
// A CSV import through the web wizard produces contacts nobody can send to,
// and the wizard used to report it as an unqualified success.
//
// The chain, each link verified:
//   * subscriber_import/options.go subscriberStatusAndConsent() returns
//     ("unconfirmed", "unknown", nil) when the import carries no consent
//     contract;
//   * audience queries filter `status = 'enabled'`, so unconfirmed contacts
//     are never selected for a send;
//   * the web client's patchImport input type carries only
//     `configuration_revision`, `mapping` and `on_existing` — no consent
//     fields — even though its own doc comment says "column/consent
//     overrides" and the PATCH route validates a nine-field contract.
//
// So the completion panel showed a green tick over "Imported 10,000" for
// contacts no campaign could reach. The server behaviour is correct and
// deliberate — migration 1761 says rows without a complete grant "remain
// unconfirmed and non-sendable", because a CSV proves a list and not a grant.
// Building the consent-capture UI is a compliance decision about what evidence
// counts; disclosing the consequence is not.
//
// Since 2026-09-12 the wizard has a Consent step (desktop parity, audience-16)
// that records the nine-field contract through patchImportConsent. With proof
// recorded the server lands rows as enabled, so the warning is now conditional
// on "no proof recorded". This test fails if the disclosure is dropped, if it
// shows even when proof was recorded, or if consent fields leak into the
// generic patchImport instead of going through the reviewed contract builder.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

// The wizard's result step is code-split into its own module next to the page.
const PAGE = [
  "app/(dashboard)/app/subscribers/import/page.tsx",
  "app/(dashboard)/app/subscribers/import/import-wizard-steps.tsx",
]
  .map((path) => readFileSync(join(SRC, path), "utf8"))
  .join("\n")
  .replace(/\s+/g, " ");
const API = readFileSync(join(SRC, "lib/subscriber-imports-api.ts"), "utf8");
const OPTIONS = readFileSync(
  join(REPO, "apps/api/internal/subscriber_import/options.go"),
  "utf8",
);

/** Fields the web client can actually send on PATCH. */
function patchFields(): string[] {
  const block = /export function patchImport\([\s\S]*?input:\s*\{([\s\S]*?)\n  \},/.exec(
    API,
  );
  expect(block, "patchImport input type not found").not.toBeNull();
  return [...block![1]!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!);
}

describe("subscriber import consent disclosure", () => {
  it("confirms an import without consent really is non-sendable", () => {
    // Guard the guard: if the server ever defaulted imports to enabled, the
    // warning below would be false and should come down.
    const fn = /func \(o importOptions\) subscriberStatusAndConsent\(\)[\s\S]*?\n}/.exec(
      OPTIONS,
    )?.[0];
    expect(fn, "subscriberStatusAndConsent not found").toBeDefined();
    expect(fn!).toContain('return "unconfirmed", "unknown", nil');
    expect(fn!).toContain("!o.hasConsent()");
  });

  it("records consent only through the reviewed contract builder", () => {
    // The generic mapping PATCH stays consent-free; the Consent step sends
    // either the full proof (with consent_scope) or an explicit "no proof".
    const fields = patchFields();
    expect(fields).toContain("mapping");
    expect(fields.filter((f) => f.startsWith("consent"))).toEqual([]);
    expect(API).toMatch(/export async function patchImportConsent\(/);
    expect(API).toMatch(/consent_scope_acknowledged: false/);
    expect(API).toMatch(/consent_scope: IMPORT_CONSENT_SCOPE/);
  });

  it("warns only when no consent proof was recorded", () => {
    expect(PAGE).toMatch(
      /consentMode === "none" && \(state\?\.rows_imported \?\? 0\) > 0 \?/,
    );
  });

  it("tells the operator the imported contacts are not sendable", () => {
    expect(PAGE).toMatch(/imported as.{0,40}unconfirmed/i);
    expect(PAGE).toMatch(/not yet sendable/i);
  });

  it("shows it only when rows were actually imported", () => {
    // A zero-row import has nothing to warn about; an unconditional banner
    // trains people to ignore it.
    expect(PAGE).toMatch(/\(state\?\.rows_imported \?\? 0\) > 0 \?/);
  });
});
