// SPDX-License-Identifier: AGPL-3.0-only
//
// /automations described resend-to-non-openers as enforcing "a required fresh
// subject and a 24-hour minimum gap so it doesn't land in the same thread".
// ResendToNonOpeners enforces neither: the subject is optional and falls back
// to the parent's via COALESCE(NULLIF($3,''), subject), and send_at is passed
// straight through with no minimum-gap check.
//
// Advertising a guardrail that does not exist is worse than advertising no
// guardrail — an operator trusts it not to re-send under the same subject into
// the same thread, and nothing stops them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const CAMPAIGNS = join(REPO, "apps/api/internal/campaigns");
const HANDLER = readFileSync(
  join(CAMPAIGNS, "handlers_send_domain.go"),
  "utf8",
);
const REPO_GO = readFileSync(join(CAMPAIGNS, "repo_send_domain.go"), "utf8");
const PAGE = readFileSync(
  join(SRC, "app/(marketing)/automations/page.tsx"),
  "utf8",
);

describe("resend-to-non-openers claims", () => {
  it("reads the handler and repo", () => {
    // Guard the guard: a moved handler would make both checks vacuous.
    expect(HANDLER).toMatch(/ResendToNonOpeners/);
    expect(REPO_GO).toMatch(/CreateClone/);
  });

  it("does not call the subject required while the clone defaults it", () => {
    // The COALESCE is what makes the subject optional; if it ever goes away,
    // "required" becomes fair game again.
    const subjectOptional = /COALESCE\(NULLIF\(\$3,''\), subject\)/.test(
      REPO_GO,
    );
    const claimsRequired = /required fresh subject/i.test(PAGE);
    expect({ subjectOptional, claimsRequired }).toEqual({
      subjectOptional,
      claimsRequired: !subjectOptional,
    });
  });

  it("does not advertise a minimum gap the handler never checks", () => {
    const body =
      /func \(d \*Deps\) ResendToNonOpeners[\s\S]*?\n}/.exec(HANDLER)?.[0] ?? "";
    expect(body).not.toBe("");
    const enforcesGap = /24|time\.Hour|minGap|MinimumGap/.test(body);
    const claimsGap = /\d+-hour minimum gap/i.test(PAGE);
    expect({ enforcesGap, claimsGap }).toEqual({
      enforcesGap,
      claimsGap: enforcesGap,
    });
  });
});
