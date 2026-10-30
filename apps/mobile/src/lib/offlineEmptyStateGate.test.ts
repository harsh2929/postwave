/**
 * Every QueryStates that can claim an absence must be handed the gate.
 *
 * WHY. QueryStates has a dedicated offline branch, but it is REACHABLE ONLY
 * when the caller passes `gate`. Omit the prop and an offline user with a cold
 * cache falls through to the empty message -- the screen asserts "there are no
 * inbound endpoints" when the truth is "this device has never fetched them".
 * That is the same lie class as rendering an error as an empty state.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..", "..");
const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "src"))];

/** The screens known to hand QueryStates a hand-built composite (A11Y-1). */
const COMPOSITE_SURFACES = [
  "app/(tabs)/audit-alerts.tsx",
  "app/(tabs)/audit-sinks.tsx",
  "app/(tabs)/inbound-webhooks.tsx",
  "app/(tabs)/scim.tsx",
  "app/(tabs)/subscriber-imports.tsx",
  "src/components/audit/AuditExportSheet.tsx",
  "src/components/audit/AuditInvestigationsSheet.tsx",
  "src/components/flow-ab/FlowAbTestsScreen.tsx",
  "src/components/privacy-incidents/IncidentRegisterEmpty.tsx",
];

function unwrap(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * Every hand-built object a `<QueryStates query=...>` receives, with its
 * top-level keys: an inline `query={{ ... }}` literal, or `query={name}` where
 * `name` is declared in the same file as an object literal.
 */
function queryComposites(path: string): { at: string; keys: Set<string> }[] {
  const text = readFileSync(path, "utf8");
  if (!text.includes("<QueryStates")) return [];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declared = new Map<string, ts.ObjectLiteralExpression>();
  const passed: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(init)) declared.set(node.name.text, init);
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(source) === "QueryStates"
    ) {
      for (const attr of node.attributes.properties) {
        if (
          ts.isJsxAttribute(attr) &&
          attr.name.getText(source) === "query" &&
          attr.initializer &&
          ts.isJsxExpression(attr.initializer) &&
          attr.initializer.expression
        ) {
          passed.push(unwrap(attr.initializer.expression));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const rel = path.slice(ROOT.length + 1);
  return passed.flatMap((expr) => {
    const literal = ts.isObjectLiteralExpression(expr)
      ? expr
      : ts.isIdentifier(expr)
        ? declared.get(expr.text)
        : undefined;
    if (!literal) return [];
    const keys = new Set<string>();
    for (const prop of literal.properties) {
      if (
        ts.isPropertyAssignment(prop) ||
        ts.isShorthandPropertyAssignment(prop)
      ) {
        keys.add(prop.name.getText(source).replace(/^["']|["']$/gu, ""));
      }
    }
    const line =
      source.getLineAndCharacterOfPosition(expr.getStart(source)).line + 1;
    return [{ at: `${rel}:${line}`, keys }];
  });
}

describe("offline honesty", () => {
  it("finds the QueryStates call sites (guards an empty scan)", () => {
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/<QueryStates/gu) ?? []).length,
      0,
    );
    expect(total).toBeGreaterThan(50);
  });

  it("hands the gate to every QueryStates that renders an empty message", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Each <QueryStates ...> block, up to its closing '>'
      for (const m of src.matchAll(/<QueryStates[\s\S]*?\n\s*>/gu)) {
        const block = m[0];
        if (!/empty=\{\{/u.test(block)) continue; // cannot claim an absence
        if (!/\bgate=\{/u.test(block)) offenders.push(f.slice(ROOT.length + 1));
      }
    }
    expect(
      offenders,
      "these render an absence an offline device cannot observe: with no `gate`, QueryStates' offline branch is unreachable and a cold-cache offline user is told the thing does not exist",
    ).toEqual([]);
  });

  // The gate is AUTH state, not reachability: a validated session that loses
  // signal keeps `gate.enabled` true, and TanStack PAUSES the first fetch
  // (isPending + isPaused, isLoading false). QueryStates reads those two
  // fields for its offline branch. A direct query result carries them; a
  // hand-built composite drops whatever it does not copy, so every one must
  // forward both or its screen claims a false zero.
  //
  // Parsed, not grepped: the fields must be KEYS of the object QueryStates
  // receives. A text scan of the whole tag was satisfied by
  // `isEmpty={!q.isPending}`, by a comment, or by `isLoading: q.isPaused`,
  // and could not see a composite built in a variable (`query={composite}`).
  // A spread does not count either: `...(refetch ? { refetch } : {})` forwards
  // nothing QueryStates needs here.
  it(
    "forwards isPending and isPaused in every hand-built query composite",
    { timeout: 60_000 },
    () => {
      const all = files.flatMap(queryComposites);
      const offenders = all
        .filter((c) => !c.keys.has("isPending") || !c.keys.has("isPaused"))
        .map((c) => c.at);
      // Guards an empty scan, per surface: an aggregate count cannot see one
      // file silently dropping out of the parse while the others still match.
      const scanned = new Set(all.map((c) => c.at.replace(/:\d+$/u, "")));
      expect(COMPOSITE_SURFACES.filter((f) => !scanned.has(f))).toEqual([]);
      expect(all.length).toBeGreaterThanOrEqual(11);
      expect(
        offenders,
        "these hand-built composites drop the paused-first-fetch fields, so a validated session that lost signal is shown the screen's real empty copy for data it never fetched",
      ).toEqual([]);
    },
  );
});
