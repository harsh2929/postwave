// SPDX-License-Identifier: AGPL-3.0-only
//
// The Cloudflare rule files are deployed by a runbook, never executed in CI, so
// nothing ever read them. A rule can be syntactically fine, deploy cleanly, and
// match nothing — and a WAF rule that matches nothing is worse than an absent
// one, because the operator believes they are covered.
//
// THE TRAP THIS PINS. `http.request.headers` is a Map of String ARRAYS. A
// missing key yields an EMPTY array, so indexing `[0]` into it produces a
// missing value, and a missing value compares false against everything —
// including `""`. So:
//
//   http.request.headers["origin"][0] eq ""
//
// matches only a request that sent a literal `Origin:` header with an empty
// value, and never matches a request that sent NO Origin header at all. That
// expression was the Origin half of form_submit_no_referer_block, a rule whose
// own description says it blocks "curl spam" — traffic which by definition
// sends no Origin header. It blocked essentially nothing while reading, to
// every reviewer, as protection.
//
// The documented idiom for absent-or-empty is:
//
//   not any(http.request.headers["origin"][*] != "")
//
// which is true both when the header is missing and when it is present-but-
// empty. This test rejects the `[0] eq ""` form outright, because there is no
// case where it is what someone meant.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CF_DIR = resolve(process.cwd(), "../../infra/cloudflare");

interface Rule {
  id?: string;
  description?: string;
  expression?: string;
  action?: string;
}

function ruleFiles(): Array<{ file: string; rules: Rule[] }> {
  return readdirSync(CF_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => {
      const parsed = JSON.parse(readFileSync(join(CF_DIR, file), "utf8")) as {
        rules?: Rule[];
      };
      return { file, rules: parsed.rules ?? [] };
    });
}

describe("Cloudflare rule files are well-formed and mean what they say", () => {
  const files = ruleFiles();
  const allRules = files.flatMap((f) => f.rules.map((r) => ({ ...r, file: f.file })));

  it("parses every rule file and finds rules", () => {
    // Guard the guard: a bad directory or a renamed key yields zero rules, and
    // every assertion below would pass over an empty list.
    expect(files.length, `no JSON found in ${CF_DIR}`).toBeGreaterThan(2);
    expect(allRules.length).toBeGreaterThan(5);
    expect(allRules.map((r) => r.id)).toContain("form_submit_no_referer_block");
  });

  it("never tests a header's presence by indexing [0]", () => {
    // The absence-vs-emptiness trap described above.
    const broken = allRules
      .filter((r) => /headers\[[^\]]+\]\[0\]\s*(eq|==|ne|!=)\s*""/.test(r.expression ?? ""))
      .map((r) => `${r.file}: ${r.id} — ${r.expression}`);
    expect(
      broken,
      'indexing [0] into a missing header yields a missing value, which never compares equal to "". ' +
        'Use `not any(http.request.headers["x"][*] != "")` to mean absent-or-empty.',
    ).toEqual([]);
  });

  it("gives every rule an id, a description, an expression and an action", () => {
    // A rule without a description is one nobody can review; without an id,
    // one nobody can find when it fires.
    for (const rule of allRules) {
      expect(rule.id, `rule in ${rule.file} has no id`).toBeTruthy();
      expect(rule.expression, `${rule.id} has no expression`).toBeTruthy();
      expect(rule.action, `${rule.id} has no action`).toBeTruthy();
      expect(
        (rule.description ?? "").length,
        `${rule.id} needs a description explaining what it does and why`,
      ).toBeGreaterThan(20);
    }
  });

  it("keeps blocking rules' paths anchored", () => {
    // An unanchored path match on a `block` rule is how a narrow rule quietly
    // becomes a broad one. Every path regex here should anchor both ends.
    const unanchored = allRules
      .filter((r) => r.action === "block")
      .filter((r) => {
        const m = /uri\.path matches "([^"]+)"/.exec(r.expression ?? "");
        return m ? !(m[1]!.startsWith("^") && m[1]!.endsWith("$")) : false;
      })
      .map((r) => `${r.id}: ${r.expression}`);
    expect(unanchored, "an unanchored path regex on a block rule").toEqual([]);
  });
});
