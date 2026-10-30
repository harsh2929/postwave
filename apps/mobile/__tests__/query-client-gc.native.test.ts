/**
 * Every real TanStack QueryClient a jest suite builds must turn off its
 * garbage-collection timers.
 *
 * WHY. The route suites run --runInBand in one process, and jest can only exit
 * once nothing holds the event loop. A client left on TanStack's default
 * gcTime (five minutes) arms a real 300,000 ms setTimeout for every cache entry
 * that loses its last observer: a mutation when its probe unmounts, a query
 * when its screen does. RNTL unmounts after every test, so the timer is armed
 * after the run has reported, and the process then idles for five minutes.
 * commerce-connection-invalidation did exactly that (CRIT-1): "Time: 0.593 s",
 * then "Jest did not exit one second after the test run has completed", then
 * 5:02 of wall time in every CI mobile job. It also hides a real leaked
 * handle, because the process does leave in the end and the job stays green.
 * `client.clear()` is no substitute for a mutation: MutationCache.clear() drops
 * its entries without cancelling their timers. With `gcTime: Infinity` TanStack
 * never arms the timer at all.
 *
 * HOW. Every source under __tests__ is parsed with the TypeScript compiler
 * (as query-hooks-proxy-shape does), so a comment that mentions a construction
 * cannot count as one. Each `new QueryClient(…)` or `new x.QueryClient(…)`,
 * import and destructuring aliases included, must pass an inline object
 * literal that sets `gcTime: Infinity` under BOTH `defaultOptions.queries` and
 * `defaultOptions.mutations`: a suite that builds only mutations today can
 * render a query tomorrow.
 */
import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const TESTS_ROOT = __dirname;
const SOURCE_FILE = /\.(?:[cm]?js|jsx|tsx?)$/u;
const QUERIES = "defaultOptions.queries.gcTime: Infinity";
const MUTATIONS = "defaultOptions.mutations.gcTime: Infinity";

type Construction = { file: string; line: number; missing: string[] };

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function nameOf(name: ts.Node): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** The initializer of `name: …` in an object literal, when written that way. */
function member(
  object: ts.Expression | undefined,
  name: string,
): ts.Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && nameOf(property.name) === name) {
      return property.initializer;
    }
  }
  return undefined;
}

function isInfinity(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isIdentifier(node)) return node.text === "Infinity";
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Number" &&
    node.name.text === "POSITIVE_INFINITY"
  );
}

/** Every local name bound to QueryClient: itself, plus its aliases. */
function queryClientNames(source: ts.SourceFile): Set<string> {
  const names = new Set(["QueryClient"]);
  const visit = (node: ts.Node) => {
    // import { QueryClient as Alias } from "…"
    if (
      ts.isImportSpecifier(node) &&
      nameOf(node.propertyName ?? node.name) === "QueryClient"
    ) {
      names.add(node.name.text);
    }
    // const { QueryClient: Alias } = rq
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.propertyName &&
      nameOf(node.propertyName) === "QueryClient"
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Each QueryClient construction in `text`, with what its options lack. */
function constructions(file: string, text: string): Construction[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const names = queryClientNames(source);
  const found: Construction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node)) {
      const callee = node.expression;
      const isQueryClient = ts.isIdentifier(callee)
        ? names.has(callee.text)
        : ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "QueryClient";
      if (isQueryClient) {
        const defaults = member(node.arguments?.[0], "defaultOptions");
        found.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          missing: [
            isInfinity(member(member(defaults, "queries"), "gcTime"))
              ? null
              : QUERIES,
            isInfinity(member(member(defaults, "mutations"), "gcTime"))
              ? null
              : MUTATIONS,
          ].filter((gap): gap is string => gap !== null),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(full);
    }
    return SOURCE_FILE.test(entry.name) ? [full] : [];
  });
}

// Any construction, aliased or not, names QueryClient somewhere in its file,
// so the cheap substring test only decides which files are worth parsing.
const scanned = sourceFiles(TESTS_ROOT).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return text.includes("QueryClient")
    ? constructions(relative(TESTS_ROOT, file), text)
    : [];
});

describe("real QueryClients in the jest suites arm no garbage-collection timer", () => {
  it("flags a client on the default gcTime, and counts only real constructions", () => {
    const sample = [
      'import { QueryClient, QueryClient as Aliased } from "@tanstack/react-query";',
      "const rq = { QueryClient };",
      "// new QueryClient() in a comment is not a construction",
      "const bare = new QueryClient();",
      "const namespaced = new rq.QueryClient();",
      "const queriesOnly = new rq.QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });",
      "const finite = new Aliased({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: 300000 } } });",
      "const { QueryClient: Destructured } = rq;",
      "const shared = new Destructured(options);",
      "const off = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: Infinity }, mutations: { gcTime: Number.POSITIVE_INFINITY } } });",
      'const text = "new QueryClient()";',
    ].join("\n");

    expect(constructions("sample.ts", sample)).toEqual([
      { file: "sample.ts", line: 4, missing: [QUERIES, MUTATIONS] },
      { file: "sample.ts", line: 5, missing: [QUERIES, MUTATIONS] },
      { file: "sample.ts", line: 6, missing: [MUTATIONS] },
      { file: "sample.ts", line: 7, missing: [MUTATIONS] },
      { file: "sample.ts", line: 9, missing: [QUERIES, MUTATIONS] },
      { file: "sample.ts", line: 10, missing: [] },
    ]);
  });

  it("reaches the suites that build a real client", () => {
    // Guard the guard, per file: an aggregate count cannot notice one suite
    // falling out of the scan while another still contributes.
    expect(scanned.length).toBeGreaterThanOrEqual(2);
    expect(scanned.map((construction) => construction.file)).toEqual(
      expect.arrayContaining([
        "asset-alt-text-cache.native.test.tsx",
        "commerce-connection-invalidation.native.test.tsx",
      ]),
    );
  });

  it("turns the timers off for queries and mutations in every construction", () => {
    const leaks = scanned
      .filter((construction) => construction.missing.length > 0)
      .map(
        (construction) =>
          `${construction.file}:${construction.line} lacks ${construction.missing.join(" and ")}`,
      );

    expect(leaks).toEqual([]);
  });
});
