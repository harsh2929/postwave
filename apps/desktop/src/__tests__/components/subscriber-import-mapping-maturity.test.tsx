// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MappingStep } from "../../components/subscribers/ImportSubscribersWizard";
import {
  type ImportMappingColumn,
  mappingIsReady,
  mappingTargetConflicts,
} from "../../components/subscribers/import-options";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

const detectedColumns: ImportMappingColumn[] = [
  { index: 0, name: "primary_email", kind: "email" },
  { index: 1, name: "backup_email", kind: "ignore" },
  { index: 2, name: "company", kind: "custom", custom_key: "company" },
  { index: 3, name: "organisation", kind: "ignore" },
];

const conflictingColumns: ImportMappingColumn[] = [
  { index: 0, name: "primary_email", kind: "email" },
  { index: 1, name: "backup_email", kind: "email" },
  { index: 2, name: "company", kind: "custom", custom_key: "company" },
  { index: 3, name: "organisation", kind: "custom", custom_key: "company" },
];

function renderMapping(
  columns = conflictingColumns,
  sampleValuesTruncated = true,
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <MappingStep
        preview={{
          id: "018f07e2-7b1a-7000-8000-000000000001",
          status: "preview",
          rows_total: 4,
          sample_values_truncated: sampleValuesTruncated,
          mapping: {
            path: "imports/tenant/source.csv",
            headers: detectedColumns.map((column) => column.name),
            columns: detectedColumns,
            rows: 4,
          },
        }}
        columns={columns}
        detected={detectedColumns}
        remapOptions={{
          merge_fields: [
            { kind: "email", label: "Email" },
            { kind: "custom", label: "Custom field" },
            { kind: "ignore", label: "Skip" },
          ],
          custom_fields: [{ key: "company", label: "Company", type: "string" }],
        }}
        autoCreate={false}
        onAutoCreate={vi.fn()}
        onColumnsChange={vi.fn()}
      />,
    ),
  );
}

describe("subscriber import mapping conflicts", () => {
  it("identifies every conflicting target and contributing source", () => {
    expect(mappingTargetConflicts(conflictingColumns)).toEqual([
      {
        target: "email",
        label: "email",
        sources: [
          { index: 0, name: "primary_email" },
          { index: 1, name: "backup_email" },
        ],
      },
      {
        target: "custom:company",
        label: 'custom field "company"',
        sources: [
          { index: 2, name: "company" },
          { index: 3, name: "organisation" },
        ],
      },
    ]);
    expect(mappingIsReady(conflictingColumns)).toBe(false);
    expect(mappingIsReady(detectedColumns)).toBe(true);
    expect(
      mappingIsReady([
        detectedColumns[0],
        detectedColumns[2],
        detectedColumns[3],
      ]),
    ).toBe(false);
  });

  it("renders a blocking summary and inline descriptions for every collision", async () => {
    renderMapping();

    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Mapping needs attention");
    expect(alert?.textContent).toContain("resolve invalid or duplicate targets");
    for (const source of [
      "primary_email",
      "backup_email",
      "company",
      "organisation",
    ]) {
      expect(alert?.textContent).toContain(source);
      const control = container?.querySelector(
        `[aria-label="Map column ${source}"]`,
      );
      expect(control?.getAttribute("aria-invalid")).toBe("true");
      const descriptionId = control?.getAttribute("aria-describedby");
      expect(descriptionId).toMatch(/^import-map-error-/);
      expect(document.getElementById(descriptionId ?? "")?.textContent).toBeTruthy();
    }

    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("discloses bounded server clipping without rendering any sample value", () => {
    renderMapping(detectedColumns, true);
    expect(container?.textContent).toContain("Oversized preview cells were clipped or omitted");
    expect(container?.textContent).toContain("Raw row values stay out of this editor");
    expect(container?.textContent).not.toContain("ada@example.test");
  });
});
