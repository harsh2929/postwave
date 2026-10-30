import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  inventory,
  inventoryIntrinsicTitles,
  inventorySummary,
} from "./interactive-title-inventory.mjs";

const BUDGET_PATH = resolve(
  import.meta.dirname,
  "interactive-title-budgets.json",
);

test("interactive-title inventory detects intrinsic controls without counting component props", () => {
  const fixture = mkdtempSync(resolve(tmpdir(), "postwave-title-inventory-"));
  try {
    writeFileSync(
      resolve(fixture, "Fixture.tsx"),
      [
        "export function Fixture() {",
        "  return <>",
        "    <button disabled title={reason}>Save</button>",
        '    <div role="button" tabIndex={0} title="Open">Open</div>',
        '    <Card title="Component heading" />',
        '    <span title="Noninteractive truncation">Text</span>',
        "  </>;",
        "}",
      ].join("\n"),
    );
    assert.deepEqual(inventory(fixture), [
      {
        file: "Fixture.tsx",
        line: 3,
        tag: "button",
        title: "{reason}",
        disabled: true,
      },
      {
        file: "Fixture.tsx",
        line: 4,
        tag: "div",
        title: "Open",
        disabled: false,
      },
    ]);
    assert.deepEqual(inventoryIntrinsicTitles(fixture), [
      {
        file: "Fixture.tsx",
        line: 3,
        tag: "button",
        title: "{reason}",
        interactive: true,
        disabled: true,
      },
      {
        file: "Fixture.tsx",
        line: 4,
        tag: "div",
        title: "Open",
        interactive: true,
        disabled: false,
      },
      {
        file: "Fixture.tsx",
        line: 6,
        tag: "span",
        title: "Noninteractive truncation",
        interactive: false,
        disabled: false,
      },
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("production interactive-title debt matches the exact per-owner budget", () => {
  const expected = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
  assert.equal(expected.schemaVersion, 1);
  const actual = Object.fromEntries(
    inventorySummary()
      .owners.map((owner) => [
        owner.file,
        { disabled: owner.disabled, total: owner.total },
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(actual, expected.budgets);
});
