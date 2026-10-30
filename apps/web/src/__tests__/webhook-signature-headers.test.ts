// SPDX-License-Identifier: AGPL-3.0-only
//
// Moosewave uses two different signature headers, one per direction:
//
//   outbound (Moosewave → you):  Moosewave-Signature      (dispatcher.go)
//   inbound  (you → Moosewave):  X-Postwave-Signature    (inbound_webhooks)
//
// /developers documented the outbound header as "X-Postwave-Signature" in
// two places, and lib/integrations.ts shipped a verification snippet reading
// req.header("X-Postwave-Signature") to check payloads that "came from us".
// A developer following either one reads a header that is never sent, so
// every delivery fails verification — or worse, they skip verification.
//
// The asymmetry is real and deliberate, so this asserts each direction
// against the Go that implements it rather than unifying them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const DISPATCHER = readFileSync(
  join(REPO, "apps/api/internal/webhooks/dispatcher.go"),
  "utf8",
);
const INBOUND = readFileSync(
  join(REPO, "apps/api/internal/inbound_webhooks/handlers.go"),
  "utf8",
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe("webhook signature headers", () => {
  it("confirms the two directions really do differ", () => {
    // Guard the guard: if the Go ever unifies them, these assertions are what
    // says the copy may unify too.
    expect(DISPATCHER).toMatch(/Header\.Set\("Moosewave-Signature"/);
    expect(DISPATCHER).not.toMatch(/Header\.Set\("X-Postwave-Signature"/);
    expect(INBOUND).toMatch(/Header\.Get\("X-Postwave-Signature"\)/);
  });

  it("never documents the outbound header with an X- prefix", () => {
    // Match the WHOLE quoted string, then ask whether it is outbound copy.
    // A window anchored forward from the marker misses the real case: in
    // "Verify the X-… header … to ensure the payload came from us" the header
    // name precedes the marker, so a forward-only scan reports clean.
    const OUTBOUND_MARKER =
      /every delivery carries|outbound signatures?:|came from us/i;
    const offenders: string[] = [];
    for (const file of [
      ...walk(join(SRC, "app/(marketing)")),
      ...walk(join(SRC, "app/(docs)")),
      join(SRC, "lib/integrations.ts"),
    ]) {
      const text = readFileSync(file, "utf8");
      // Quoted string literals and template literals, newlines included.
      for (const m of text.matchAll(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gs)) {
        const literal = m[0];
        if (!OUTBOUND_MARKER.test(literal)) continue;
        if (/X-Postwave-Signature/.test(literal)) {
          offenders.push(file.slice(SRC.length + 1));
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("keeps the inbound helper on the header the handler reads", () => {
    const helper = readFileSync(
      join(SRC, "components/integrations/inbound-signing-help.tsx"),
      "utf8",
    );
    expect(helper).toContain("X-Postwave-Signature");
  });
});
