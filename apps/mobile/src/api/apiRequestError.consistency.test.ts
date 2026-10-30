// SPDX-License-Identifier: AGPL-3.0-only
//
// Every error class built from an AIApiError extends ApiRequestError.
//
// WHY. Forty-seven files each copied the same few lines of `this.status =
// error.status; this.code = error.code`, and each copy kept a different
// subset. The one that bit was VendorVerifyError: it dropped `denial`, so the
// 402 "no provider credits" plan refusal on a PAID write read as "Something
// went wrong loading this. Please try again." ApiRequestError keeps every
// field checkedApiResult keeps, under the same presence rules, so a class
// built on it cannot drop one.
//
// TWO RULES, both from how the two toolchains treat class fields:
//  (a) a class taking an AIApiError extends ApiRequestError, or its file is
//      EXEMPT with a reason. The list can only shrink.
//  (b) a subclass never re-declares a base field. Under vitest (esbuild,
//      ES2022 define semantics) a re-declared `readonly denial?: ApiDenial`
//      is reset to undefined AFTER super() runs, silently undoing the base.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_ROOT = path.join(__dirname, "..", "..");
const ROOTS = ["src", "app"];
const BASE = "ApiRequestError";

const PRE_EXISTING =
  "pre-existing copy of the envelope tagging; rebase it onto ApiRequestError when the file is next touched";

/** Files whose AIApiError classes are not rebased yet, and why. */
const EXEMPT: { file: string; why: string }[] = [
  ...[
    "apiKeys",
    "botOpens",
    "complianceOps",
    "consentEvents",
    "customDomainReputation",
    "deliverabilityControl",
    "deliverabilityEvidence",
    "deliverabilityHubOps",
    "deliverabilityProviders",
    "deliverabilityRecovery",
    "dmarcSources",
    "domainWarmupOps",
    "idempotencyKeys",
    "inboundEndpointAdmin",
    "inboundWebhooks",
    "outboundWebhooks",
    "privacyPortal",
    "replyMailboxes",
    "reputationResponse",
    "savedReports",
    "scimMappings",
    "spendControls",
    "suppressionMirror",
    "tags",
  ].map((name) => ({ file: `src/api/${name}.ts`, why: PRE_EXISTING })),
  {
    file: "src/hooks/useAgencyOps.ts",
    why: "AgencyReadError's retryAgencyRead reads `retryable` outside the capability envelope, which ApiRequestError deliberately never sets",
  },
];

/** The fields ApiRequestError owns. A subclass declaring one clobbers it. */
const BASE_FIELDS = [
  "status",
  "code",
  "requestId",
  "denial",
  "capability",
  "runtimeStatus",
  "retryable",
  "fields",
  "retryAfterSeconds",
  "details",
  "responseMetadata",
];

/** Strip comments. Line comments FIRST: a `/*` inside a `//` comment would
 *  otherwise open a block that swallows real code. */
function code(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "));
}

interface ClassInfo {
  file: string;
  name: string;
  parent: string;
  takesApiError: boolean;
  redeclared: string[];
}

const FIELD_DECLARATION = new RegExp(
  `^  (?:(?:readonly|declare|public|protected|private|override)\\s+)*(${BASE_FIELDS.join("|")})\\s*[?!]?\\s*[:=;]`,
  "gmu",
);

/** Every top-level class in `source`: its parent, whether its constructor
 *  takes an AIApiError, and which base fields its body declares. */
function classesIn(file: string, source: string): ClassInfo[] {
  const text = code(source);
  const out: ClassInfo[] = [];
  for (const match of text.matchAll(
    /class\s+(\w+)\s+extends\s+([\w.]+)\s*\{/gu,
  )) {
    const start = (match.index ?? 0) + match[0].length;
    const end = text.indexOf("\n}", start);
    const body = text.slice(start, end === -1 ? undefined : end);
    const ctor = /constructor\s*\(([^)]*)\)/u.exec(body);
    out.push({
      file,
      name: match[1] ?? "",
      parent: match[2] ?? "",
      takesApiError: Boolean(ctor && /:\s*AIApiError\b/u.test(ctor[1] ?? "")),
      redeclared: [...body.matchAll(FIELD_DECLARATION)].map((m) => m[1] ?? ""),
    });
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...sourceFiles(full));
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

function scan(): ClassInfo[] {
  const all: ClassInfo[] = [];
  for (const root of ROOTS) {
    for (const full of sourceFiles(path.join(MOBILE_ROOT, root))) {
      const rel = path.relative(MOBILE_ROOT, full).split(path.sep).join("/");
      all.push(...classesIn(rel, readFileSync(full, "utf8")));
    }
  }
  return all;
}

/** Names that are ApiRequestError or inherit from it, within the scan. */
function rebasedNames(classes: ClassInfo[]): Set<string> {
  const rebased = new Set([BASE]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of classes) {
      if (!rebased.has(c.name) && rebased.has(c.parent)) {
        rebased.add(c.name);
        grew = true;
      }
    }
  }
  return rebased;
}

describe("error classes built from an AIApiError share ApiRequestError", () => {
  const classes = scan();
  const rebased = rebasedNames(classes);
  const candidates = classes.filter((c) => c.takesApiError && c.name !== BASE);
  const notRebased = candidates.filter((c) => !rebased.has(c.name));
  const exempt = new Set(EXEMPT.map((entry) => entry.file));

  it("finds the classes it polices, so a pass is not vacuous", () => {
    expect(candidates.length).toBeGreaterThan(40);
    expect(
      candidates.filter((c) => rebased.has(c.name)).length,
    ).toBeGreaterThan(0);
  });

  it("the matchers flag a copy and a re-declaration, and pass a clean subclass", () => {
    const copy = classesIn(
      "x.ts",
      "export class X extends Error {\n  readonly status: number;\n  constructor(error: AIApiError, fallback: string) {\n    super(error.message || fallback);\n  }\n}\n",
    );
    expect(copy).toEqual([
      expect.objectContaining({
        name: "X",
        parent: "Error",
        takesApiError: true,
        redeclared: ["status"],
      }),
    ]);
    const clean = classesIn(
      "y.ts",
      '// class Z extends Error { constructor(e: AIApiError) } /api/*\nexport class Y extends ApiRequestError {\n  constructor(error: AIApiError, fallback: string) {\n    super(error, fallback);\n    this.name = "Y";\n  }\n}\n',
    );
    expect(clean).toEqual([
      expect.objectContaining({ name: "Y", parent: BASE, redeclared: [] }),
    ]);
  });

  it("every AIApiError class extends ApiRequestError unless its file is exempt", () => {
    const offenders = notRebased
      .filter((c) => !exempt.has(c.file))
      .map((c) => `${c.file}: ${c.name} extends ${c.parent}`);
    expect(
      offenders,
      "extend ApiRequestError (src/api/apiRequestError.ts) so the denial, capability and field envelope survive",
    ).toEqual([]);
  });

  it("no subclass re-declares a field ApiRequestError owns", () => {
    const clobbering = classes
      .filter(
        (c) => c.name !== BASE && rebased.has(c.name) && c.redeclared.length,
      )
      .map((c) => `${c.file}: ${c.name} declares ${c.redeclared.join(", ")}`);
    expect(
      clobbering,
      "delete the declaration: under vitest it resets the base's value to undefined after super()",
    ).toEqual([]);
  });

  it.each(EXEMPT)(
    "$file is still exempt for a recorded reason",
    ({ file, why }) => {
      expect(
        notRebased.some((c) => c.file === file),
        `${file} has no un-rebased AIApiError class any more; delete its EXEMPT entry`,
      ).toBe(true);
      expect(why.length).toBeGreaterThan(30);
    },
  );
});
