import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectSourceSizeFindings,
  countSourceLines,
} from "./source-size-contract.mjs";

const policy = (entries = []) => ({
  fileBudgets: new Map(entries),
  defaultTypeScriptMax: 2_000,
  defaultCssMax: 2_000,
});

describe("desktop source-size contract", () => {
  it("uses the runner's terminal-line counting convention", () => {
    assert.equal(countSourceLines(""), 0);
    assert.equal(countSourceLines("one"), 1);
    assert.equal(countSourceLines("one\ntwo"), 2);
    assert.equal(countSourceLines("one\ntwo\n"), 3);
    assert.equal(countSourceLines("one\r\ntwo"), 2);
  });

  it("accepts sources at the default limit and exact legacy ratchets", () => {
    const findings = collectSourceSizeFindings(
      [
        { rel: "src/new.ts", lines: 2_000 },
        { rel: "src/legacy.tsx", lines: 2_300 },
      ],
      policy([["src/legacy.tsx", 2_300]]),
    );

    assert.deepEqual(findings, []);
  });

  it("rejects an unreviewed oversized TypeScript or CSS source", () => {
    const findings = collectSourceSizeFindings(
      [
        { rel: "src/new.ts", lines: 2_001 },
        { rel: "src/new.css", lines: 2_001 },
      ],
      policy(),
    );

    assert.equal(findings.length, 2);
    assert.match(findings[0], /default budget 2000/);
    assert.match(findings[1], /default budget 2000/);
  });

  it("rejects both legacy growth and a stale ratchet after shrinkage", () => {
    const findings = collectSourceSizeFindings(
      [
        { rel: "src/grew.ts", lines: 2_301 },
        { rel: "src/shrank.ts", lines: 2_299 },
      ],
      policy([
        ["src/grew.ts", 2_300],
        ["src/shrank.ts", 2_300],
      ]),
    );

    assert.equal(findings.length, 2);
    assert.match(findings[0], /exact legacy budget 2300/);
    assert.match(findings[1], /lower the ratchet to 2299/);
  });

  it("rejects missing and no-longer-needed legacy entries", () => {
    const findings = collectSourceSizeFindings(
      [{ rel: "src/small.ts", lines: 1_999 }],
      policy([
        ["src/missing.ts", 2_400],
        ["src/small.ts", 1_999],
      ]),
    );

    assert.equal(findings.length, 2);
    assert.match(findings[0], /no matching source file/);
    assert.match(findings[1], /remove its stale legacy ratchet/);
  });

  it("rejects duplicate measurements instead of silently overwriting them", () => {
    const findings = collectSourceSizeFindings(
      [
        { rel: "src/duplicate.ts", lines: 10 },
        { rel: "src/duplicate.ts", lines: 10 },
      ],
      policy(),
    );

    assert.deepEqual(findings, [
      "src/duplicate.ts was measured more than once",
    ]);
  });
});
