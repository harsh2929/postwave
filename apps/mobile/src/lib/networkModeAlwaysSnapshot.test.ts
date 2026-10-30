/**
 * `networkMode: "always"` is a promise that the query works OFFLINE.
 *
 * The default network mode pauses a query while the device is offline. Sixteen
 * hooks deliberately override that to "always", and every one of them does so
 * for the same reason: their `queryFn` reads a local snapshot
 * (`loadSnapshotBacked`), so pausing would mean the snapshot never loads and
 * the cached answer the operator already has on disk stays invisible.
 *
 * The override is therefore load-bearing -- and reusable in the wrong way. Set
 * "always" on a hook with no offline path and the query no longer waits for a
 * connection: it fires into a dead socket, fails, and the screen renders an
 * ERROR where the honest answer was "you are offline". That is strictly worse
 * than the pause it replaced, and nothing about the line announces it.
 *
 * Node-run: no react-native imports.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/u.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const ROOT = join(__dirname, "..");
const FILES = walk(ROOT);

/**
 * Files that opt a QUERY out of the offline pause.
 *
 * Mutations are excluded, and the distinction is the whole point rather than a
 * loophole. On a query, "always" means "run the queryFn with no connection",
 * which is only honest when that function can answer from disk. On a mutation
 * it means the opposite kind of thing: react-query's default PAUSES a mutation
 * started offline and replays it on reconnect, and for an irreversible write
 * that is the dangerous behaviour — `useInboundEndpointAdmin` sets it on
 * create/rename/delete precisely so a queued CREATE cannot mint a
 * shown-exactly-once signing secret into a response nobody is looking at, and
 * a queued DELETE cannot shred secrets hours after the decision. Demanding a
 * snapshot there would be demanding an offline read path for a write.
 *
 * So the scan finds the override INSIDE a `useQuery`/`useInfiniteQuery` options
 * block, by walking back from the override to the nearest call ahead of it.
 */
function alwaysModeFiles(): string[] {
  return FILES.filter((f) => {
    const source = readFileSync(f, "utf8");
    for (const match of source.matchAll(/networkMode:\s*"always"/gu)) {
      const before = source.slice(0, match.index);
      const call = before.lastIndexOf("useQuery(");
      const infinite = before.lastIndexOf("useInfiniteQuery(");
      const mutation = before.lastIndexOf("useMutation");
      if (Math.max(call, infinite) > mutation) return true;
    }
    return false;
  });
}

/** The markers that prove a queryFn can answer without a connection. */
const OFFLINE_PATH =
  /loadSnapshotBacked|snapshotScope|canReadOfflineSnapshots|readSnapshot/u;

describe("networkMode: always implies an offline path", () => {
  it("finds the override sites (guards an empty scan)", () => {
    expect(alwaysModeFiles().length).toBeGreaterThan(10);
  });

  it("gives every always-mode query something to answer with offline", () => {
    const stranded = alwaysModeFiles()
      .filter((f) => !OFFLINE_PATH.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      stranded,
      'these opt out of the offline pause without a snapshot to read, so offline they fire into a dead socket and render an ERROR where the honest answer was "you are offline"',
    ).toEqual([]);
  });
});

/**
 * The mutation half (A11Y-5). Each module below documents its writes as
 * ONLINE-ONLY, and the default network mode quietly breaks that promise: a
 * write started offline — or in the moment between the gate reading online and
 * the socket dying — is PAUSED and replayed on reconnect, in the same session,
 * against a world the operator has moved past.
 *
 *  - usePrivacyIncidents: a replayed declaration or transition records its
 *    moment of knowledge as whenever the phone found a signal again.
 *  - useScimMappingOps: a replayed upsert grants a role to a whole IdP group
 *    after the operator stopped looking; a replayed delete revokes one.
 *  - useListMembership: its own header calls a late REMOVE unrecoverable.
 *  - useAuditExport: a replayed start enqueues an export the operator gave up
 *    on; a replayed schedule create or delete starts or stops mailing
 *    evidence packs after the operator moved on.
 *
 * "always" makes each fail into the onError its caller already renders. The
 * scan reads the AST, so a comment that mentions either token counts for
 * nothing, and it names the offending call rather than a bare count.
 */
const ONLINE_ONLY_WRITE_MODULES = [
  "hooks/usePrivacyIncidents.ts",
  "hooks/useScimMappingOps.ts",
  "hooks/useListMembership.ts",
  "hooks/useAuditExport.ts",
];

function mutationNetworkModes(rel: string): string[] {
  const text = readFileSync(join(ROOT, rel), "utf8");
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const modes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "useMutation"
    ) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const options = node.arguments[0];
      const mode =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) &&
                ts.isIdentifier(p.name) &&
                p.name.text === "networkMode",
            )?.initializer
          : undefined;
      modes.push(
        `${rel}:${line} ${mode && ts.isStringLiteral(mode) ? mode.text : "default"}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return modes;
}

describe("online-only writes fail instead of pausing for replay", () => {
  it.each(ONLINE_ONLY_WRITE_MODULES)(
    '%s: every useMutation sets networkMode "always"',
    (rel) => {
      const modes = mutationNetworkModes(rel);
      // Vacuity floor: the scan must find the module's writes at all.
      expect(modes.length).toBeGreaterThan(0);
      expect(modes.filter((entry) => !entry.endsWith(" always"))).toEqual([]);
    },
  );
});
