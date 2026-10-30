/**
 * One campaign, one name — on every screen and every surface.
 *
 * WHAT WENT WRONG. Mobile labelled a campaign by SUBJECT in its list, summary
 * card, dashboard row and web-handoff label, and by NAME in its detail modals
 * and A/B handoff. Desktop's CampaignListView uses `name ?? subject ??
 * "Untitled"` for the row and all three of its aria-labels.
 *
 * So a campaign the operator called "QA Campaign", carrying the subject
 * "FIRST", read as "FIRST" in the mobile list and "QA Campaign" one tap later
 * in its own modal — and as "QA Campaign" on the desktop the same person had
 * open beside it. Observed in-app on 2026-08-19.
 *
 * `name` is the operator's own handle for the campaign. `subject` is
 * recipient-facing and differs per A/B variant, so it cannot be a stable
 * identity. The one legitimate exception is CampaignResendModal, which seeds a
 * NEW SUBJECT LINE from the old one — that is about the subject, not about
 * naming the campaign, and is excluded by name below.
 *
 * Node-run: no react-native imports.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/u.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..", "..");
const FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app"))];

/** Seeds a new subject line from the old one — legitimately subject-first. */
const SUBJECT_LINE_AUTHORING = new Set(["CampaignResendModal.tsx"]);

/** `x.subject || x.name` / `x.subject ?? x.name` — subject used as identity. */
const SUBJECT_FIRST =
  /\b(\w+)\.subject\s*(?:\|\||\?\?)\s*\1\.name\b/gu;

describe("campaign identity labelling", () => {
  it("finds campaign label expressions at all (guards an empty scan)", () => {
    const nameFirst = FILES.reduce(
      (n, f) =>
        n +
        (readFileSync(f, "utf8").match(/\b(\w+)\.name\s*(?:\|\||\?\?)\s*\1\.subject\b/gu) ?? [])
          .length,
      0,
    );
    expect(nameFirst).toBeGreaterThan(3);
  });

  it("never labels a campaign by subject where name exists", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const base = f.slice(f.lastIndexOf("/") + 1);
      if (SUBJECT_LINE_AUTHORING.has(base)) continue;
      const hits = readFileSync(f, "utf8").match(SUBJECT_FIRST);
      if (hits) offenders.push(`${f.slice(ROOT.length + 1)} -> ${hits[0]}`);
    }
    expect(
      offenders,
      'these label a campaign by its SUBJECT, so the same campaign reads differently here than in its own detail modals and on desktop, whose CampaignListView uses `name ?? subject`',
    ).toEqual([]);
  });
});
