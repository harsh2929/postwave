// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  forbiddenSignatureCoverage,
  matchingForbiddenSignatureNames,
} from "./forbidden-signatures.mjs";

const signatures = [
  { name: "example dependency", markers: ["alpha", "beta", "gamma"] },
];

test("validates and locates a complete marker set in emitted JavaScript", () => {
  const files = [
    { file: "static/chunks/a.js", content: Buffer.from("alpha beta gamma") },
  ];
  assert.deepEqual(forbiddenSignatureCoverage(signatures, files), [
    {
      name: "example dependency",
      markers: ["alpha", "beta", "gamma"],
      matchedFile: "static/chunks/a.js",
      matchedFiles: ["static/chunks/a.js"],
    },
  ]);
  assert.deepEqual(matchingForbiddenSignatureNames(signatures, files), [
    "example dependency",
  ]);
});

test("names every chunk carrying a complete copy, not just the first", () => {
  const coverage = forbiddenSignatureCoverage(signatures, [
    { file: "static/chunks/a.js", content: Buffer.from("alpha beta gamma") },
    { file: "static/chunks/b.js", content: Buffer.from("nothing here") },
    { file: "static/chunks/c.js", content: Buffer.from("gamma beta alpha") },
  ]);
  assert.deepEqual(coverage[0].matchedFiles, [
    "static/chunks/a.js",
    "static/chunks/c.js",
  ]);
  // Duplication must not change the pass/fail signal, only its visibility.
  assert.equal(coverage[0].matchedFile, "static/chunks/a.js");
});

test("does not validate a marker set split across unrelated chunks", () => {
  const coverage = forbiddenSignatureCoverage(signatures, [
    { file: "static/chunks/a.js", content: Buffer.from("alpha beta") },
    { file: "static/chunks/b.js", content: Buffer.from("gamma") },
  ]);
  assert.equal(coverage[0].matchedFile, null);
});

test("refuses empty or malformed signature contracts and emitted file sets", () => {
  assert.throws(() => forbiddenSignatureCoverage([], []));
  assert.throws(() =>
    forbiddenSignatureCoverage([{ name: "bad", markers: [] }], [
      { file: "a.js", content: Buffer.from("") },
    ]),
  );
  assert.throws(() => forbiddenSignatureCoverage(signatures, []));
});
