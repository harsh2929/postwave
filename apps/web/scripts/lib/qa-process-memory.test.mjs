// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { descendantRssKiB } from "./qa-process-memory.mjs";

test("includes out-of-order descendants and excludes unrelated high-memory apps", () => {
  const rows = "43 42 300\n99 1 9000000\n42 40 200\n40 1 100\n";
  assert.equal(descendantRssKiB(rows, 40), 600);
});
test("an exited process contributes no memory", () => {
  assert.equal(descendantRssKiB("90 1 200\n", 40), 0);
});
test(
  "parses the real local ps format without collecting process arguments",
  { skip: process.platform === "win32" },
  () => {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
    });
    assert.ok(descendantRssKiB(output, process.pid) > 0);
  },
);
