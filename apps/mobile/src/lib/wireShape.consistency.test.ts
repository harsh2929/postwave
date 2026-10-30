// SPDX-License-Identifier: AGPL-3.0-only
//
// A 2xx body the client cannot read is thrown as a WireShapeError, never as a
// bare Error.
//
// WHY. lib/errorCopy tells a shape failure apart from a network blip by its
// `code: "wire_shape"`. A parser that throws `new Error("...malformed.")`
// drops that code, so the user reads "Something went wrong loading this" and
// is never told that updating the app could help. Fifteen response-parser
// throws in nine files did this for a malformed ENVELOPE. The row, option,
// consistency and uniqueness checks further into the same parsers did it
// too, under other wording: one additive field on an ingest-key row (ROW_KEYS
// refuses unknown keys) read as a loading blip while a missing envelope field
// read as "update the app". This change converted twenty-four throw sites in
// ten files. Twenty-three more, in thirteen files it did not touch, are listed
// in UNCONVERTED so the whole population is on the record. A per-parser test
// only grows when someone remembers to write it; this guard makes the next
// parser follow the rule.
//
// WHAT IT MATCHES. A `throw new Error(...)` whose literal argument says the
// body was malformed, unreadable, could not be read or verified, or held an
// invalid row/option/response/receipt/envelope/profile, inconsistent values,
// duplicate IDs, or a value that did not match. That is how these parsers
// describe a body they refused. The sentence stays the same when a site
// converts: `new WireShapeError("<resource>", "<sentence>")` keeps each
// existing message assertion green. Known limits: a computed argument
// (`new Error(SOME_CONST)`) cannot be classified, and a receipt check worded
// otherwise ("did not confirm") is not matched.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_ROOT = path.join(__dirname, "..", "..");
const ROOTS = ["src/api", "src/lib"];

/**
 * Sites that use the wording but do not describe a server response. Each is a
 * decision on the record.
 */
const NOT_A_RESPONSE: { site: string; why: string }[] = [
  {
    site: "src/lib/entityActivityBridge.ts: spotlight donation ledger unreadable: activities donated before this launch cannot be named",
    why: "the unreadable thing is this device's own AsyncStorage ledger of Spotlight donations, not a server response",
  },
  {
    site: "src/lib/smsBulkAction.ts: A selected conversation carries an unreadable lifecycle version.",
    why: "client-side validation of the operator's selection before any request is built; no response was received",
  },
  {
    site: "src/api/smsInboxContracts.ts: SMS read boundary contains an invalid or duplicate message ID.",
    why: "client-side validation of the message IDs the operator is about to mark read, before the request is sent",
  },
];

const OUTSIDE_THIS_CHANGE =
  "a response-shape throw in a file this change did not touch; convert it to WireShapeError with the same sentence when the file is next edited";

/**
 * Response parsers that still throw a bare Error, in files this change did not
 * edit. They are the same defect as the converted sites; listing them keeps
 * the whole population on the record instead of a wording subset.
 */
const UNCONVERTED: { site: string; why: string }[] = [
  "src/api/assetFolderWrites.ts: The folder may have been created, but the server's answer couldn't be read. Pull to refresh.",
  "src/api/assetFolderWrites.ts: The rename may have applied, but the server's answer couldn't be read. Pull to refresh.",
  "src/api/campaignOrganize.ts: The folder may have been created, but the server's answer couldn't be read. Pull to refresh the folder list.",
  "src/api/campaignPolls.ts: The paginated campaign poll register contained a duplicate definition ID.",
  "src/api/flows.ts: The validator answered with something this app can't read.",
  "src/api/replyMailboxes.ts: Mailbox action receipt did not match the reviewed action.",
  "src/api/sendTimeSegmentHeatmap.ts: The server answered, but its week couldn't be read. Pull to refresh.",
  "src/api/smsInboxContracts.ts: ${label} returned an invalid sender profile.",
  "src/api/smsInboxContracts.ts: ${label} returned an invalid receipt.",
  "src/api/smsInboxContracts.ts: Marking as read returned an invalid receipt.",
  "src/api/subscriberImports.ts: The server returned an import job this app cannot read.",
  "src/lib/consentReceipts.ts: The consent evidence response could not be verified.",
  "src/lib/productEvents.ts: The event catalogue came back in a shape this app can't read.",
  "src/lib/productEvents.ts: The product-event activity came back in a shape this app can't read.",
  "src/lib/productEvents.ts: The recent events came back in a shape this app can't read.",
  "src/lib/replyMailboxes.ts: Invalid reply mailbox response",
  "src/lib/replyMailboxes.ts: Invalid reply mailbox list response",
  "src/lib/replyMailboxes.ts: Invalid reply mailbox list response: duplicate id",
  "src/lib/smsPolicyContracts.ts: Invalid SMS quiet-hours row",
  "src/lib/smsPolicyContracts.ts: Invalid SMS keyword-response row",
  "src/lib/smsPolicyWire.ts: Invalid SMS ${label} envelope",
].map((site) => ({ site, why: OUTSIDE_THIS_CHANGE }));

const SHAPE_WORDING = new RegExp(
  [
    "malformed",
    "unreadable",
    "could(?: not|n't) be (?:read|verified)",
    "can(?:not|'t) read",
    "\\binvalid\\b.*\\b(?:row|option|response|receipt|envelope|profile)\\b",
    "inconsistent",
    "\\bduplicate (?:\\w+ )?ids?\\b",
    "did not match",
  ].join("|"),
  "iu",
);
// The literal argument of `throw new Error(`: one string, template or a `+`
// concatenation of them. A computed argument cannot be classified here.
const BARE_THROW =
  /throw\s+new\s+Error\(\s*((?:"[^"]*"|'[^']*'|`[^`]*`)(?:\s*\+\s*(?:"[^"]*"|'[^']*'|`[^`]*`))*)/gu;

/**
 * Strip comments before matching. Line comments go FIRST: a glob such as
 * `/api/*` inside a `//` comment otherwise opens a block comment that swallows
 * real code until the next `*` + `/`.
 */
function code(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/u.test(entry) &&
      !/\.test\.tsx?$/u.test(entry) &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every bare shape throw in `source`, as `<rel>: <message>`. */
function bareShapeThrows(rel: string, source: string): string[] {
  const hits: string[] = [];
  for (const match of code(source).matchAll(BARE_THROW)) {
    const literal = match[1] ?? "";
    if (!SHAPE_WORDING.test(literal)) continue;
    const text = literal
      .replace(/^["'`]|["'`]$/gu, "")
      .replace(/["'`]\s*\+\s*["'`]/gu, "");
    hits.push(`${rel}: ${text}`);
  }
  return hits;
}

function scan(): { files: number; hits: string[] } {
  const hits: string[] = [];
  let files = 0;
  for (const root of ROOTS) {
    for (const full of sourceFiles(path.join(MOBILE_ROOT, root))) {
      files += 1;
      const rel = path.relative(MOBILE_ROOT, full).split(path.sep).join("/");
      hits.push(...bareShapeThrows(rel, readFileSync(full, "utf8")));
    }
  }
  return { files, hits };
}

describe("a response the client cannot read is a WireShapeError", () => {
  const { files, hits } = scan();
  const recorded = [...NOT_A_RESPONSE, ...UNCONVERTED];

  it("scans the whole api and lib tree, so a pass is not vacuous", () => {
    expect(files).toBeGreaterThan(100);
  });

  it("the matcher flags every shape wording and passes the converted form", () => {
    const flagged = (message: string) =>
      bareShapeThrows("x.ts", `throw new Error(${JSON.stringify(message)});`);
    for (const message of [
      "The recipe was malformed.",
      "The register contained an invalid row.",
      "The poll definition contained an invalid option.",
      "Marking as read returned an invalid receipt.",
      "The poll definition options were inconsistent.",
      "The register contained duplicate IDs.",
      "The register contained a duplicate definition ID.",
      "The tally did not match its immutable definition.",
      "The consent evidence response could not be verified.",
      "The server's answer couldn't be read.",
      "The server returned a job this app cannot read.",
    ]) {
      expect(flagged(message), message).toEqual([`x.ts: ${message}`]);
    }
    expect(
      bareShapeThrows(
        "x.ts",
        "throw new Error(\n  `${label} returned an unreadable rule.`,\n);",
      ),
    ).toHaveLength(1);
    // Input validation, and a sentence that only mentions reading, are not
    // shape failures.
    expect(flagged("Invalid reply mailbox id.")).toEqual([]);
    expect(flagged("A rule id is required to read its matches.")).toEqual([]);
    expect(
      bareShapeThrows(
        "x.ts",
        'throw new WireShapeError("recipe", "The recipe was malformed.");',
      ),
    ).toEqual([]);
    // Prose about the rule does not satisfy or break it.
    expect(
      bareShapeThrows("x.ts", '// throw new Error("was malformed") /api/*\n'),
    ).toEqual([]);
  });

  it("no parser under src/api or src/lib throws a bare shape Error", () => {
    const allowed = new Set(recorded.map((entry) => entry.site));
    const offenders = hits.filter((hit) => !allowed.has(hit));
    expect(
      offenders,
      "throw new WireShapeError(resource, sentence) instead, so errorCopy can say what happened",
    ).toEqual([]);
  });

  it.each(recorded)("$site is on the record for a reason", ({ site, why }) => {
    expect(hits, `${site} no longer matches; delete its entry`).toContain(site);
    expect(why.length).toBeGreaterThan(30);
  });
});
