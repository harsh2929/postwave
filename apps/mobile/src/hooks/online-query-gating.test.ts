/**
 * Every direct TanStack query must sit behind the cached-session online gate.
 *
 * `useOnlineQueryGate` answers `canUseOnlineServices()`, which is false for a
 * cached or blocked session — a state the radio knows nothing about. A query
 * that ignores it fires into a dead socket while offline and renders an ERROR
 * where the honest answer was "you are offline".
 *
 * ── WHY THIS GUARD FOLLOWS IMPORTS ─────────────────────────────────────────
 * It used to require the literal `gate.enabled` in the SAME file, and that made
 * it wrong in both directions at once.
 *
 * FALSE POSITIVE: seven hooks route the gate through an `access` object built
 * by a sibling (`useSmsInbox`, `useHelpdeskIdentity`, `usePushSuppressions`),
 * whose `canRequest` is `focused && online && sessionReady && roleAllowed` with
 * `sessionReady = gate.enabled && Boolean(identity)` — a STRICTER gate than the
 * one this file was demanding. They were correct and the guard called them
 * broken, which is how a guard teaches people to add exemptions.
 *
 * FALSE NEGATIVE, and the worse half: the old check was satisfied by a single
 * gated `enabled:` anywhere in the file. A file with four queries where only
 * one was gated passed. So this version checks EVERY query's own options block.
 *
 * The chain walk is deliberately shallow (3 hops) and cycle-guarded, and the
 * `chain` is the current path only — never a cache of failures, or a sibling
 * branch's dead end would poison a legitimate later visit.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const QUERY_CALL_RE = /\buse(?:Infinite)?Query\s*\(/g;
const TEST_FILE_RE = /\.(?:test|spec)\.[tj]sx?$/;
const SOURCE_FILE_RE = /\.[tj]sx?$/;
/**
 * The gate's own value, read anywhere in the file.
 *
 * Deliberately NOT "adjacent to an `enabled:`". Correct call sites routinely
 * name it first — `const baseEnabled = gate.enabled && Boolean(gate.tenantId)`
 * in useFormDetailQueries, `sessionReady = gate.enabled && Boolean(identity)`
 * folded into `canRequest` in usePushSuppressions — and an adjacency rule
 * called both of those broken. Pairing "the gate is consulted" with the
 * per-query check below is what makes this sound without being brittle.
 */
const IN_FILE_GATE_RE = /\b(?:gate|onlineGate)\.enabled\b/;
const IMPORT_RE = /from "@\/((?:hooks|lib|api|components)\/[\w./-]+)"/gu;

const appRoot = resolve(process.cwd());

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!SOURCE_FILE_RE.test(path) || TEST_FILE_RE.test(path)) return [];
    return [path];
  });
}

/** The balanced `{ … }` that opens each query call's options. */
function queryOptionBlocks(source: string): string[] {
  const blocks: string[] = [];
  QUERY_CALL_RE.lastIndex = 0;
  for (let m = QUERY_CALL_RE.exec(source); m; m = QUERY_CALL_RE.exec(source)) {
    let i = m.index + m[0].length;
    while (i < source.length && /\s/u.test(source[i] ?? "")) i += 1;
    // A generic or a non-literal argument (`useQuery(options)`) has no block to
    // read; record an empty one so it is reported rather than skipped.
    if (source[i] !== "{") {
      blocks.push("");
      continue;
    }
    let depth = 0;
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(start, i + 1));
  }
  return blocks;
}

/**
 * Does this module — or something it imports — apply the gate to an `enabled:`?
 *
 * Memoised, and the walk is a visited-set DFS rather than a depth-limited one.
 * The first version shared a global regex's `lastIndex` across recursive calls
 * (which silently skips imports) and re-walked every branch, which on a graph
 * this size did not finish. Results are cached only once fully computed, so a
 * node still on the stack never poisons the cache with a cycle's `false`.
 */
const gateMemo = new Map<string, boolean>();

function gateReachable(path: string, visiting = new Set<string>()): boolean {
  const cached = gateMemo.get(path);
  if (cached !== undefined) return cached;
  if (visiting.has(path) || !existsSync(path)) return false;
  visiting.add(path);
  const source = readFileSync(path, "utf8");
  let result = IN_FILE_GATE_RE.test(source);
  if (!result) {
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = match[1];
      if (!target) continue;
      if (
        [".ts", ".tsx"].some((ext) =>
          gateReachable(join(appRoot, "src", `${target}${ext}`), visiting),
        )
      ) {
        result = true;
        break;
      }
    }
  }
  visiting.delete(path);
  gateMemo.set(path, result);
  return result;
}

describe("mobile online query gating", () => {
  const queryFiles = [join(appRoot, "app"), join(appRoot, "src")]
    .flatMap(sourceFiles)
    .filter((path) => {
      QUERY_CALL_RE.lastIndex = 0;
      return QUERY_CALL_RE.test(readFileSync(path, "utf8"));
    });

  it("finds the query layer at all (the scan itself can rot)", () => {
    expect(queryFiles.length).toBeGreaterThan(50);
  });

  it("gives every single query its own enabled, not one per file", () => {
    const ungated = queryFiles.filter((path) =>
      queryOptionBlocks(readFileSync(path, "utf8")).some(
        // Shorthand counts: `{ enabled, staleTime }` is the same property as
        // `{ enabled: x }`, and three privacy-incident queries use it.
        (block) => !/(?:^|[{,\s])enabled\s*[,:}]/u.test(block),
      ),
    );
    expect(
      ungated.map((path) => relative(appRoot, path)).sort(),
      "a query with no `enabled` runs regardless of session or radio state",
    ).toEqual([]);
  });

  it("keeps direct TanStack queries behind the cached-session online gate", () => {
    const ungated = queryFiles.filter((path) => !gateReachable(path));
    expect(ungated.map((path) => relative(appRoot, path)).sort()).toEqual([]);
  });
});
