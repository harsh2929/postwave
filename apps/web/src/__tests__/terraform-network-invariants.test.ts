// SPDX-License-Identifier: AGPL-3.0-only
//
// infra/terraform is applied by hand and has no test runner, so nothing has
// ever read it. Three invariants here are worth more than the rest combined,
// because breaking any of them exposes a host and nothing in the plan output
// looks alarming:
//
//   1. Every hcloud_server carries firewall_ids. A Hetzner firewall does
//      NOTHING until it is attached. Declaring one and forgetting the
//      attachment produces a clean plan, a real firewall resource in the
//      console, and a completely open host.
//   2. Only 80 and 443 are reachable from the internet. SSH, Postgres and
//      Redis are subnet-scoped; a rule that widens one of them to 0.0.0.0/0
//      is one line and reads like the two above it.
//   3. The operator-SSH CIDR guard tests PREFIX LENGTH, not spelling.
//
// (3) had failed. The validation compared against the literal strings
// "0.0.0.0/0" and "::/0", so "::0/0", "0000::/0" and "0:0:0:0:0:0:0:0/0" — all
// the same network, all valid CIDRs — passed straight through and would have
// opened bastion SSH to the internet. A /0 is the whole internet however it is
// written, which is why the check is now on the prefix.
//
// All three hold today. This is the cheap moment to pin them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TF_DIR = resolve(process.cwd(), "../../infra/terraform");

function tfFiles(dir: string = TF_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".terraform") continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...tfFiles(abs));
    else if (entry.endsWith(".tf")) out.push(abs);
  }
  return out;
}

/** Every `<type> "<kind>" "<name>" { … }` block, brace-matched. */
function blocks(src: string, header: RegExp): Array<{ name: string; body: string }> {
  const found: Array<{ name: string; body: string }> = [];
  for (const match of src.matchAll(header)) {
    const start = src.indexOf("{", match.index! + match[0].length - 1);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          found.push({ name: match[1] ?? "", body: src.slice(start + 1, i) });
          break;
        }
      }
    }
  }
  return found;
}

const allTf = tfFiles();
const sources = allTf.map((f) => ({ file: f, src: readFileSync(f, "utf8") }));

describe("terraform network invariants", () => {
  it("reads the terraform tree", () => {
    // Guard the guard: a wrong path finds no files and every sweep below is
    // vacuously clean.
    expect(allTf.length, `no .tf under ${TF_DIR}`).toBeGreaterThan(5);
    expect(sources.some((s) => s.src.includes("hcloud_server"))).toBe(true);
  });

  it("attaches a firewall to every server", () => {
    const naked: string[] = [];
    for (const { file, src } of sources) {
      for (const server of blocks(src, /resource\s+"hcloud_server"\s+"([a-z0-9_]+)"\s*\{/g)) {
        if (!/\bfirewall_ids\s*=/.test(server.body)) {
          naked.push(`${server.name} (${file.split("/").pop()})`);
        }
      }
    }
    expect(
      naked,
      "a Hetzner firewall does nothing until it is attached; these servers have none",
    ).toEqual([]);
  });

  it("exposes only 80 and 443 to the internet", () => {
    const WORLD = ["0.0.0.0/0", "::/0"];
    const PUBLIC_PORTS = new Set(["80", "443"]);
    const exposed: string[] = [];

    for (const { file, src } of sources) {
      for (const fw of blocks(src, /resource\s+"hcloud_firewall"\s+"([a-z0-9_]+)"\s*\{/g)) {
        for (const rule of blocks(fw.body, /(rule)\s*\{/g)) {
          if (!/direction\s*=\s*"in"/.test(rule.body)) continue;
          const port = /port\s*=\s*"([^"]+)"/.exec(rule.body)?.[1] ?? "";
          const sources_ = [...rule.body.matchAll(/"([^"]*\/\d+)"/g)].map((m) => m[1]!);
          const openToWorld = sources_.some((s) => WORLD.includes(s.trim()));
          if (openToWorld && !PUBLIC_PORTS.has(port)) {
            exposed.push(`${fw.name} port ${port} open to ${sources_.join(", ")} (${file.split("/").pop()})`);
          }
        }
      }
    }
    expect(
      exposed,
      "only 80/443 may be world-reachable; SSH, Postgres and Redis are subnet-scoped",
    ).toEqual([]);
  });

  it("guards operator SSH CIDRs by prefix length, not by spelling", () => {
    // Search EVERY file, not the first one named variables.tf — there are two
    // (infra/terraform/variables.tf and ses-inbound/variables.tf) and the
    // wrong one has no operator_ssh_cidrs at all, so a first-match lookup
    // reports the variable missing rather than checking it.
    const declarations = sources.flatMap((s) =>
      blocks(s.src, /variable\s+"(operator_ssh_cidrs)"\s*\{/g),
    );
    expect(
      declarations.length,
      "operator_ssh_cidrs must be declared exactly once",
    ).toBe(1);
    const decl = declarations[0];

    // The prefix check is what makes every /0 spelling fail.
    expect(
      /split\("\/",\s*trimspace\(cidr\)\)\[1\]/.test(decl!.body),
      "the whole-internet check must read the CIDR's prefix length",
    ).toBe(true);
    // And the string denylist must not come back as the only check.
    expect(
      /contains\(\["0\.0\.0\.0\/0"/.test(decl!.body),
      'a literal-string denylist misses "::0/0", "0000::/0" and "0:0:0:0:0:0:0:0/0"',
    ).toBe(false);
    // The variable stays required — a default would make the guard optional.
    expect(/\bdefault\s*=/.test(decl!.body), "operator_ssh_cidrs must have no default").toBe(
      false,
    );
  });
});
