import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectFunctionQualityFindings } from "./function-quality-contract.mjs";

const existing = (...paths) => new Set(paths);

describe("desktop function-quality ratchet contract", () => {
  it("accepts exact legacy maxima", () => {
    const findings = collectFunctionQualityFindings(
      new Map([
        ["src/legacy.ts", { maxFunctionLines: 420, maxComplexity: 58 }],
      ]),
      new Map([
        ["src/legacy.ts", { maxFunctionLines: 420, maxComplexity: 58 }],
      ]),
      existing("src/legacy.ts"),
    );
    assert.deepEqual(findings, []);
  });

  it("rejects a new unreviewed exception", () => {
    const findings = collectFunctionQualityFindings(
      new Map([["src/new.ts", { maxFunctionLines: 301 }]]),
      new Map(),
      existing("src/new.ts"),
    );
    assert.match(findings.join("\n"), /without a reviewed legacy ratchet/);
  });

  it("rejects growth and stale ratchets after shrinkage", () => {
    const findings = collectFunctionQualityFindings(
      new Map([
        ["src/grew.ts", { maxComplexity: 61 }],
        ["src/shrank.ts", { maxFunctionLines: 350 }],
      ]),
      new Map([
        ["src/grew.ts", { maxComplexity: 60 }],
        ["src/shrank.ts", { maxFunctionLines: 360 }],
      ]),
      existing("src/grew.ts", "src/shrank.ts"),
    );
    assert.equal(findings.length, 2);
    assert.match(findings[0], /exact legacy ratchet 60/);
    assert.match(findings[1], /lower it to 350/);
  });

  it("rejects a newly exceeded dimension in a known legacy file", () => {
    const findings = collectFunctionQualityFindings(
      new Map([
        ["src/legacy.ts", { maxFunctionLines: 420, maxComplexity: 51 }],
      ]),
      new Map([["src/legacy.ts", { maxFunctionLines: 420 }]]),
      existing("src/legacy.ts"),
    );
    assert.match(findings.join("\n"), /without a reviewed maxComplexity ratchet/);
  });

  it("rejects missing files and no-longer-needed exception entries", () => {
    const findings = collectFunctionQualityFindings(
      new Map(),
      new Map([
        ["src/missing.ts", { maxComplexity: 51 }],
        ["src/small.ts", { maxFunctionLines: 301 }],
      ]),
      existing("src/small.ts"),
    );
    assert.equal(findings.length, 2);
    assert.match(findings[0], /no source file/);
    assert.match(findings[1], /within all default/);
  });
});
