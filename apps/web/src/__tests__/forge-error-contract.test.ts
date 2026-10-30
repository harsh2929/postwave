// SPDX-License-Identifier: AGPL-3.0-only
//
// /forge/docs publishes an error table headed "Stable error codes. Agents
// pattern-match on these." That heading is the reason this matters: a wrong
// string here does not degrade, it silently never matches.
//
// Five of the ten rows were wrong.
//
//   401 unauthenticated    — no such code. 401s are no_tenant (865 call
//                            sites), no_session, invalid_signature, and
//                            missing_principal from the scope middleware.
//   403 forbidden          — the scope denial emits insufficient_scope,
//                            through entitlement.Write (ReasonPolicy → 403).
//   422 validation_failed  — the code is real, the status is not:
//                            httperror.WriteValidation writes 400.
//   451 awaiting_approval  — approval is not an HTTP error at all. mcp/exec.go
//                            returns a SUCCESSFUL result whose payload carries
//                            status:"approval_required" and approval_ref. An
//                            agent catching 451 waits forever for a 200.
//   awaiting_approval      — also published twice as a campaign status. The
//                            campaigns CHECK constraint allows only draft,
//                            scheduled, sending, paused, cancelled, sent,
//                            failed; writing it would trip 23514.
//
// Each row is checked against the source that would have to produce it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const DOCS = readFileSync(join(SRC, "app/forge/docs/page.tsx"), "utf8");
const FORGE = readFileSync(join(SRC, "app/forge/page.tsx"), "utf8");
const ERRORS = /const ERRORS = `([\s\S]*?)`;/.exec(DOCS)?.[1] ?? "";

function api(rel: string): string {
  return readFileSync(join(REPO, "apps/api", rel), "utf8");
}

/** Every "<status> <code>" row in the published table. */
function rows(): { status: number; code: string }[] {
  return [...ERRORS.matchAll(/^(\d{3}) ([a-z_]+)/gm)].map((m) => ({
    status: Number(m[1]),
    code: m[2]!,
  }));
}

describe("forge error table matches the gateway", () => {
  it("parses the table", () => {
    // Guard the guard: an unparsed table makes every row check vacuous.
    expect(ERRORS).not.toBe("");
    expect(rows().length).toBeGreaterThan(6);
  });

  it("publishes no code the API never emits", () => {
    // Walk the whole API, not a curated file list. The first version of this
    // named seven files and reported no_tenant, missing_principal and
    // validation_failed as orphans — codes emitted from hundreds of call
    // sites. A hand-picked haystack turns "the API never emits this" into
    // "the files I happened to think of don't".
    const codes = new Set(rows().map((r) => r.code));
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "vendor") continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (p.endsWith(".go") && !p.endsWith("_test.go")) {
          const text = readFileSync(p, "utf8");
          for (const code of codes) {
            if (text.includes(`"${code}"`)) seen.add(code);
          }
        }
      }
    };
    walk(join(REPO, "apps/api"));
    expect(seen.size).toBeGreaterThan(0); // guard the guard
    expect([...codes].filter((c) => !seen.has(c)).sort()).toEqual([]);
  });

  it("gives validation_failed the status WriteValidation actually writes", () => {
    const httperror = api("internal/httperror/httperror.go");
    const m = /func WriteValidation[\s\S]{0,200}?Write\(w, http\.(Status\w+)/.exec(
      httperror,
    );
    expect(m, "WriteValidation body not found").not.toBeNull();
    const expected = m![1] === "StatusBadRequest" ? 400 : 422;
    const row = rows().find((r) => r.code === "validation_failed");
    expect(row?.status).toBe(expected);
  });

  it("gives insufficient_scope the status the denial writer uses", () => {
    const denials = api("internal/apikeys/denials.go");
    expect(denials).toContain('Code:    "insufficient_scope"');
    expect(denials).toContain("entitlement.ReasonPolicy");
    const entitlement = api("internal/entitlement/denial.go");
    expect(entitlement).toContain("StatusForbidden");
    expect(rows().find((r) => r.code === "insufficient_scope")?.status).toBe(403);
  });

  it("does not present approval as an HTTP error", () => {
    // The payload field is the contract, not a status code.
    const exec = api("internal/mcp/exec.go");
    expect(exec).toContain('"status":       "approval_required"');
    expect(ERRORS).not.toMatch(/^\d{3} awaiting_approval/m);
    expect(ERRORS).toContain("Approval is NOT an error");
    expect(ERRORS).toContain('status: "approval_required"');
  });

  it("never calls awaiting_approval a campaign status", () => {
    // The CHECK constraint is the authority; the value would trip 23514.
    const migration = readFileSync(
      join(REPO, "infra/migrations/0077_send_domain_rls_fixup.sql"),
      "utf8",
    );
    const allowed = /campaigns_status_check[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)/
      .exec(migration)?.[1];
    expect(allowed, "campaigns status CHECK not found").toBeDefined();
    const statuses = [...allowed!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(statuses).toContain("draft"); // guard the guard
    expect(statuses).not.toContain("awaiting_approval");
    for (const [label, text] of [
      ["/forge", FORGE],
      ["/forge/docs", DOCS],
    ] as const) {
      const claimed = /(?:enter|freezes the campaign in|status)\s+awaiting_approval/.exec(
        text,
      );
      expect(claimed, `${label} still calls awaiting_approval a status`).toBeNull();
    }
  });
});
