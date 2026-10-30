// Tests for the edge-case register extractor.
//
// The registry must be GENERATED from the blueprint, never retyped: a manifest
// promises a disposition for every edge case, so a registry that silently omits
// one lets a milestone ship with an unreviewed failure mode. These tests pin
// the parse against both synthetic tables and the real document.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEdgeRegistry, parseEdgeRegister } from "./edge-registry.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BLUEPRINT = "docs/ecosystem/deep-integration-feature-blueprint.md";

const SYNTHETIC = `
## 7. Something else
| NOPE-01 | should not be picked up | x |

## 8. Universal edge-case and failure register

### 8.1 Identity

| ID     | Scenario        | Required behavior |
| ------ | --------------- | ----------------- |
| IAM-01 | Several tenants | Explicit choice.  |
| IAM-02 | Same email      | Never global key. |

### 8.11 Accessibility, localization, and time

| ID        | Scenario  | Required behavior |
| --------- | --------- | ----------------- |
| A11Y-01   | Screen reader | Announced.    |
| I18N-03   | RTL       | Mirrored.         |
| FORMAT-01 | Currency  | Presentation only.|

## 9. Recommended implementation sequence
| LATE-01 | must not be picked up | x |
`;

test("extracts ids only from the section-8 register", () => {
  const { entries, errors } = parseEdgeRegister(SYNTHETIC);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["IAM-01", "IAM-02", "A11Y-01", "I18N-03", "FORMAT-01"],
  );
  // Tables before §8 and after it must not leak in.
  assert.equal(entries.some((e) => e.id.startsWith("NOPE")), false);
  assert.equal(entries.some((e) => e.id.startsWith("LATE")), false);
});

test("handles ids containing digits and multiple segments", () => {
  const { entries } = parseEdgeRegister(SYNTHETIC);
  const ids = entries.map((e) => e.id);
  // A naive /[A-Z]+-\d+/ misses these three, silently shrinking the registry.
  for (const id of ["A11Y-01", "I18N-03", "FORMAT-01"]) {
    assert.ok(ids.includes(id), `${id} must parse`);
  }
});

test("records the section each edge came from", () => {
  const { entries } = parseEdgeRegister(SYNTHETIC);
  assert.equal(entries.find((e) => e.id === "IAM-01").section, "8.1");
  assert.equal(entries.find((e) => e.id === "A11Y-01").section, "8.11");
  assert.equal(
    entries.find((e) => e.id === "A11Y-01").sectionTitle,
    "Accessibility, localization, and time",
  );
});

test("rejects a duplicate id rather than silently keeping one", () => {
  const dup = SYNTHETIC.replace("| IAM-02 |", "| IAM-01 |");
  const { errors } = parseEdgeRegister(dup);
  assert.equal(errors.some((e) => e.includes("duplicate edge id IAM-01")), true);
});

test("fails loudly when the register heading is missing", () => {
  const { errors } = parseEdgeRegister("# nothing here\n");
  assert.equal(errors.some((e) => e.includes("could not find")), true);
});

test("fails loudly when the table format changes to zero matches", () => {
  const { errors } = parseEdgeRegister(
    "## 8. Universal edge-case and failure register\n\nprose only\n\n## 9. Next\n",
  );
  assert.equal(errors.some((e) => e.includes("zero entries")), true);
});

test("the registry document is order-stable and content-addressed", () => {
  const a = buildEdgeRegistry(parseEdgeRegister(SYNTHETIC).entries, {
    sourceDocument: BLUEPRINT,
  });
  const shuffled = [...parseEdgeRegister(SYNTHETIC).entries].reverse();
  const b = buildEdgeRegistry(shuffled, { sourceDocument: BLUEPRINT });
  assert.deepEqual(a, b);
  assert.equal(a.count, 5);
  assert.deepEqual(
    a.entries.map((e) => e.id),
    ["A11Y-01", "FORMAT-01", "I18N-03", "IAM-01", "IAM-02"],
  );
});

test("parses the REAL blueprint register cleanly", () => {
  const md = readFileSync(resolve(repoRoot, BLUEPRINT), "utf8");
  const { entries, errors } = parseEdgeRegister(md);
  assert.deepEqual(errors, []);
  // A lower bound, not an exact pin: the register is expected to grow, and a
  // brittle exact count would fail on every legitimate addition. What must not
  // happen is the parse silently collapsing.
  assert.ok(
    entries.length >= 150,
    `expected the real register to have >=150 entries, got ${entries.length}`,
  );
  for (const e of entries) {
    assert.match(e.id, /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+$/);
    assert.ok(e.scenario.length > 0, `${e.id} has an empty scenario cell`);
    assert.match(e.section, /^8\.\d+$/);
  }
});

test("a malformed id in a DATA row is an error, not a silent drop", () => {
  // The whole point of generating the registry is that an edge case cannot go
  // unregistered. A row whose id is mistyped used to vanish with `errors: []`:
  // it never entered the registry, the digest did not change, and no manifest
  // ever had to disposition it.
  const md = `
## 8. Universal edge-case and failure register

### 8.1 Identity

| ID     | Scenario | Required behavior |
| ------ | -------- | ----------------- |
| IAM-01 | ok       | fine.             |
| iam-02 | lowercase| dropped silently. |
| IAM 03 | space    | dropped silently. |
| **IAM-04** | bold | dropped silently. |

## 9. Next
`;
  const { entries, errors } = parseEdgeRegister(md);
  assert.deepEqual(entries.map((e) => e.id), ["IAM-01"]);
  assert.equal(errors.length, 3, `expected 3 malformed-row errors, got ${errors.length}`);
  for (const fragment of ["iam-02", "IAM 03", "IAM-04"]) {
    assert.ok(
      errors.some((e) => e.includes(fragment)),
      `no error named ${fragment}`,
    );
  }
});

test("header rows and separator rules are not mistaken for data", () => {
  const md = `
## 8. Universal edge-case and failure register

### 8.1 Identity

| ID     | Scenario | Required behavior |
| :----- | -------- | ----------------: |
| IAM-01 | ok       | fine.             |

## 9. Next
`;
  const { entries, errors } = parseEdgeRegister(md);
  assert.deepEqual(entries.map((e) => e.id), ["IAM-01"]);
  assert.deepEqual(errors, []);
});
