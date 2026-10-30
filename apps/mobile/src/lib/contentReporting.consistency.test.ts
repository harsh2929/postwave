// SPDX-License-Identifier: AGPL-3.0-only
//
// Every surface that shows content the viewer cannot remove must offer a way to
// report it.
//
// WHY THIS IS A CONSISTENCY TEST AND NOT A PER-SCREEN TEST. Apple Guideline 1.2
// and Google Play's UGC and generative-AI policies are conditions of
// distribution: failing them does not degrade a feature, it stops the app
// shipping. The risk is not that today's screens lack the control — they have
// it — but that the fourth one added next quarter does not, and nobody notices
// until review. A per-screen test grows only when someone remembers to write
// it; this one names the rule and forces the next screen to be classified.
//
// THE LINE THIS DRAWS. A surface needs the control when it shows content
// authored by someone outside the workspace AND the person looking at it cannot
// themselves remove that content from the platform. That is why:
//
//   * ai-chat and helpdesk threads REQUIRE it — the operator can neither unsay
//     what the model produced nor delete a stranger's email from our systems;
//   * archive-comments does NOT — the screen's whole purpose is moderation, and
//     the viewer can already approve, reject, delete and pin. An extra "report
//     this to us" next to a working Delete button would be theatre.
//
// If that judgement is ever wrong for archive-comments, the fix is to move it
// into REQUIRED below, not to weaken the rule.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_ROOT = path.join(__dirname, "..", "..");

/** Surfaces that must reach the report sheet, and why. */
const REQUIRED: { file: string; why: string }[] = [
  {
    file: "app/(tabs)/ai-chat.tsx",
    why: "renders model output; Google Play's generative-AI policy requires an in-app way to flag offensive generated content",
  },
  {
    file: "app/(tabs)/helpdesk/[id].tsx",
    why: "renders messages written by people outside the workspace that the operator cannot remove from the platform",
  },
];

/**
 * Surfaces deliberately exempt, with the reason. Listed rather than omitted so
 * the exemption is a decision on the record instead of an oversight nobody can
 * distinguish from one.
 */
const EXEMPT: { file: string; why: string }[] = [
  {
    file: "app/(tabs)/archive-comments.tsx",
    why: "this IS the moderation queue — the viewer can approve, reject, delete and pin, which is strictly more than reporting",
  },
];

function read(rel: string): string {
  const full = path.join(MOBILE_ROOT, rel);
  if (!existsSync(full)) throw new Error(`${rel} does not exist`);
  return readFileSync(full, "utf8");
}

/** Strip comments before matching. A rule satisfied by the prose explaining the
 * rule is not satisfied. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("content reporting reaches every surface that needs it", () => {
  it.each(REQUIRED)("$file mounts the report sheet", ({ file, why }) => {
    const source = code(read(file));
    // RENDERED, not merely imported. Mutation testing caught this: deleting the
    // `<ReportContentSheet …/>` element left the import line behind, and a
    // `toContain("ReportContentSheet")` check happily passed on a screen that
    // no longer had the control at all.
    expect(source, `${file} ${why}, so it must RENDER <ReportContentSheet>`).toMatch(
      /<ReportContentSheet[\s>]/,
    );
    // And it must be able to open: a sheet whose target is never set is inert.
    expect(source, `${file} renders the sheet but never opens it`).toMatch(
      /setReportTarget\(/,
    );
  });

  it.each(REQUIRED)("$file names the kind of content it is reporting", ({ file }) => {
    // `kind` decides whether the report lands in the UGC bucket or the
    // generative-AI one, and those are audited separately. A screen that
    // mislabelled model output as UGC would satisfy neither policy cleanly.
    const source = code(read(file));
    expect(source).toMatch(/kind:\s*"(ai_output|inbound_message|archive_comment|hosted_form|landing_page|archive_post|other)"/);
  });

  it.each(EXEMPT)("$file is exempt for a recorded reason", ({ file, why }) => {
    expect(existsSync(path.join(MOBILE_ROOT, file)), `${file} is listed exempt but does not exist`).toBe(true);
    expect(why.length).toBeGreaterThan(30);
  });

  it("the sheet reaches the shared API rather than a local stub", () => {
    // A report control that only set local state would pass a screenshot review
    // and satisfy nothing. The point is that a human at Moosewave sees it.
    const sheet = code(read("src/components/ReportContentSheet.tsx"));
    expect(sheet).toContain("submitContentReport");
    const api = code(read("src/api/contentReports.ts"));
    expect(api).toContain("/api/v1/content-reports");
  });

  it("the client's grounds are a subset of the server's vocabulary", () => {
    // The server CHECK-constrains reason_category. A client value outside it
    // produces a 400 the reporter cannot act on, which reads to them as the
    // report having been refused.
    const api = read("src/api/contentReports.ts");
    const clientGrounds = [...api.matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(clientGrounds.length).toBeGreaterThan(5);

    const migration = readFileSync(
      path.join(MOBILE_ROOT, "..", "..", "infra", "migrations", "2041_content_reports_notice_and_action.sql"),
      "utf8",
    );
    const block = migration.slice(
      migration.indexOf("reason_category     text NOT NULL CHECK"),
      migration.indexOf("explanation         text NOT NULL"),
    );
    for (const ground of clientGrounds) {
      expect(block, `client offers "${ground}", which the server's CHECK does not allow`).toContain(
        `'${ground}'`,
      );
    }
  });

  it("the client's minimum explanation is not looser than the server's", () => {
    const api = read("src/api/contentReports.ts");
    const clientMin = Number(/MIN_REPORT_EXPLANATION = (\d+)/.exec(api)?.[1]);
    const migration = readFileSync(
      path.join(MOBILE_ROOT, "..", "..", "infra", "migrations", "2041_content_reports_notice_and_action.sql"),
      "utf8",
    );
    const serverMin = Number(
      /length\(btrim\(explanation\)\) BETWEEN (\d+)/.exec(migration)?.[1],
    );
    expect(Number.isFinite(clientMin)).toBe(true);
    expect(Number.isFinite(serverMin)).toBe(true);
    // Looser would let the app enable its Send button on input the database
    // will reject, turning a validation message into a server error.
    expect(clientMin).toBeGreaterThanOrEqual(serverMin);
  });

  it("the client's maximum explanation is exactly the handler's and the database's", () => {
    // The ceiling had no client half at all: a pasted 10,001-character report
    // enabled Send and came back as a 400 with "try again" copy. Both server
    // halves are read — the handler 400s first, the CHECK is the guarantee.
    // Equal, not merely no looser: a lower client cap would refuse reports the
    // server accepts, and tell the reporter to cut a valid one short.
    const api = read("src/api/contentReports.ts");
    // `[\d_]+` so a `10_000` literal is read whole rather than as `10`.
    const clientMax = Number(
      /MAX_REPORT_EXPLANATION = ([\d_]+)/.exec(api)?.[1]?.replaceAll("_", ""),
    );
    const migration = readFileSync(
      path.join(MOBILE_ROOT, "..", "..", "infra", "migrations", "2041_content_reports_notice_and_action.sql"),
      "utf8",
    );
    const checkMax = Number(
      /length\(btrim\(explanation\)\) BETWEEN (\d+) AND (\d+)/.exec(migration)?.[2],
    );
    const handler = readFileSync(
      path.join(MOBILE_ROOT, "..", "api", "internal", "contentreports", "contentreports.go"),
      "utf8",
    );
    const handlerMax = Number(/maxExplanationRunes\s*=\s*(\d+)/.exec(handler)?.[1]);
    expect(Number.isFinite(clientMax), "contentReports.ts declares no MAX_REPORT_EXPLANATION").toBe(true);
    expect(Number.isFinite(checkMax), "migration 2041 no longer bounds explanation").toBe(true);
    expect(Number.isFinite(handlerMax), "contentreports.go no longer declares maxExplanationRunes").toBe(true);
    expect(clientMax).toBeGreaterThan(0);
    expect(clientMax).toBe(checkMax);
    expect(clientMax).toBe(handlerMax);
  });

  it("every key the client sends is a field the server's decoder accepts", () => {
    // SubmitInAppReport decodes with httpbody.DecodeJSON, which rejects an
    // unknown field with a 400. So a renamed key compiles, passes every other
    // test, and turns every report into "couldn't be accepted" — the grounds
    // guard above cannot see it, because it checks values, not keys.
    const handlers = readFileSync(
      path.join(MOBILE_ROOT, "..", "api", "internal", "contentreports", "handlers.go"),
      "utf8",
    );
    const start = handlers.indexOf("type inAppReportRequest struct {");
    expect(start, "handlers.go no longer declares inAppReportRequest").toBeGreaterThan(-1);
    const struct = handlers.slice(start, handlers.indexOf("}", start));
    const serverFields = new Set(
      [...struct.matchAll(/json:"([a-z_]+)/g)].map((m) => m[1]),
    );
    expect(serverFields.size).toBeGreaterThan(3);

    const api = code(read("src/api/contentReports.ts"));
    const typeStart = api.indexOf("export type ContentReportInput = {");
    expect(typeStart, "contentReports.ts no longer declares ContentReportInput").toBeGreaterThan(-1);
    const block = api.slice(typeStart, api.indexOf("};", typeStart));
    const clientKeys = [...block.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    expect(clientKeys).toContain("explanation");
    for (const key of clientKeys) {
      expect(
        serverFields.has(key),
        `ContentReportInput sends "${key}", which inAppReportRequest does not decode — the server 400s every report`,
      ).toBe(true);
    }
  });
});
