/**
 * The query-hook proxy must hand every mocked hook back in its REAL shape.
 *
 * jest.routes.config.cjs routes a dozen hook modules to
 * __tests__/mocks/queryHooks.cjs, whose Proxy decides by NAME whether an export
 * is a query or a mutation: anything that does not match a mutation prefix gets
 * the query shape, `isPending: true` forever and no `mutate`. So a mutation
 * hook named outside the list becomes a permanently pending query in every
 * route suite, and the button it drives can never be pressed there.
 * `useSaveBrandVoiceProfile` was exactly that (TESTS-4): the brand-voice
 * editor's Save read "Saving…" and was disabled in every test, which is why
 * nothing had ever pressed it.
 *
 * This guard classifies each exported `use*` hook of every proxied module by
 * what its body CALLS (useMutation vs useQuery/useInfiniteQuery/useQueries),
 * then asks the proxy for it and compares. It parses the source with the
 * TypeScript compiler rather than grepping, so a comment that mentions
 * `useMutation(` cannot flip a verdict.
 */
import { describe, expect, it } from "@jest/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const APP_ROOT = join(__dirname, "..");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const routesConfig = require("../jest.routes.config.cjs") as {
  moduleNameMapper: Record<string, string>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxy = require("./mocks/queryHooks.cjs") as Record<string, unknown>;

const MUTATION_CALLS = new Set(["useMutation"]);
const QUERY_CALLS = new Set([
  "useQuery",
  "useInfiniteQuery",
  "useQueries",
  "useSuspenseQuery",
  "useSuspenseInfiniteQuery",
]);

type HookKind = "mutation" | "query" | "other";

/** The module names the mapper sends to the proxy, read off the config. */
function proxiedModules(): string[] {
  const entry = Object.entries(routesConfig.moduleNameMapper).find(
    ([pattern, target]) =>
      target.endsWith("/__tests__/mocks/queryHooks.cjs") &&
      pattern.startsWith("^@/hooks/("),
  );
  if (!entry) return [];
  const group = /^\^@\/hooks\/\(([^)]+)\)\$$/u.exec(entry[0]);
  return group?.[1] ? group[1].split("|") : [];
}

function hookSource(moduleName: string): ts.SourceFile {
  const file = [".ts", ".tsx"]
    .map((extension) => join(APP_ROOT, "src", "hooks", moduleName + extension))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`no source for proxied module ${moduleName}`);
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/**
 * Every exported `use*` binding with its kind. A call to a same-file helper
 * is followed into that helper, so a hook that wraps a local function which
 * owns the useMutation is still classified by what it really returns.
 */
function classifyModule(source: ts.SourceFile): Map<string, HookKind> {
  const declarations = new Map<string, ts.Node>();
  const exported: string[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      if (isExported(statement)) exported.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declarations.set(declaration.name.text, declaration);
        if (isExported(statement)) exported.push(declaration.name.text);
      }
    }
  }

  const calleesOf = (name: string, seen: Set<string>): Set<string> => {
    const callees = new Set<string>();
    const node = declarations.get(name);
    if (!node || seen.has(name)) return callees;
    seen.add(name);
    const visit = (child: ts.Node) => {
      if (ts.isCallExpression(child)) {
        const target = child.expression;
        const callee = ts.isIdentifier(target)
          ? target.text
          : ts.isPropertyAccessExpression(target)
            ? target.name.text
            : null;
        if (callee) {
          callees.add(callee);
          for (const nested of calleesOf(callee, seen)) callees.add(nested);
        }
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return callees;
  };

  const kinds = new Map<string, HookKind>();
  for (const name of exported.filter((binding) => binding.startsWith("use"))) {
    const callees = [...calleesOf(name, new Set())];
    kinds.set(
      name,
      callees.some((callee) => MUTATION_CALLS.has(callee))
        ? "mutation"
        : callees.some((callee) => QUERY_CALLS.has(callee))
          ? "query"
          : "other",
    );
  }
  return kinds;
}

/** What a screen receives from the proxy when it calls the hook. */
function proxyResult(name: string): Record<string, unknown> | null {
  const hook = proxy[name];
  if (typeof hook !== "function") return null;
  const result: unknown = (hook as () => unknown)();
  return result !== null && typeof result === "object"
    ? (result as Record<string, unknown>)
    : null;
}

const modules = proxiedModules();
const hooks = modules.flatMap((moduleName) =>
  [...classifyModule(hookSource(moduleName))].map(([name, kind]) => ({
    moduleName,
    name,
    kind,
  })),
);

describe("query-hook proxy shape", () => {
  it("reads the proxied module list and finds the known mutations in it", () => {
    // Guard the guard: a mapper or regex change that parses fewer modules
    // must fail here, not turn the checks below vacuous. Update the count
    // when the mapper's module list changes on purpose.
    expect(modules).toHaveLength(12);
    expect(
      hooks.filter((hook) => hook.kind === "mutation").map((hook) => hook.name),
    ).toEqual(
      expect.arrayContaining([
        "useApprovalDecision",
        "useBuildVoiceProfile",
        "useSaveBrandVoiceProfile",
        "useUpdateSubscriberTags",
        "useSetSubscriberStatus",
        "useCampaignLifecycleAction",
      ]),
    );
    expect(
      hooks.filter((hook) => hook.kind === "query").length,
    ).toBeGreaterThanOrEqual(20);
  });

  it("hands every mutation hook back as an idle mutation", () => {
    const wrong = hooks
      .filter((hook) => hook.kind === "mutation")
      .filter((hook) => {
        const result = proxyResult(hook.name);
        return typeof result?.mutate !== "function" || result.isPending !== false;
      })
      .map((hook) => `${hook.moduleName}.${hook.name}`);

    expect(wrong).toEqual([]);
  });

  it("never hands a query hook back in the mutation shape", () => {
    const wrong = hooks
      .filter((hook) => hook.kind === "query")
      .filter((hook) => proxyResult(hook.name)?.mutate !== undefined)
      .map((hook) => `${hook.moduleName}.${hook.name}`);

    expect(wrong).toEqual([]);
  });
});
