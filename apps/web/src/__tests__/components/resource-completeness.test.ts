import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ResourceCompleteness,
  resourceCompletenessStatusLabel,
} from "@/components/migration/resource-completeness";

describe("resource completeness status labels", () => {
  it("does not present imported evidence or archive rows as runtime activation", () => {
    expect(resourceCompletenessStatusLabel("imported_runtime")).toBe(
      "Imported",
    );
    expect(resourceCompletenessStatusLabel("preserved_for_rebuild")).toBe(
      "Preserved for rebuild",
    );
  });
  it("describes discovery and dry-run rows as plans, not completed imports", () => {
    const html = renderToStaticMarkup(
      createElement(ResourceCompleteness, {
        preview: true,
        rows: [
          {
            resource: "subscribers",
            label: "Subscribers",
            source_total: 3,
            imported: 3,
            supported: true,
            status: "imported_runtime",
          },
        ],
      }),
    );
    expect(html).toContain("No records have been imported by this preview");
    expect(html).toContain("Planned import");
    expect(html).not.toContain(">Imported<");
    expect(resourceCompletenessStatusLabel("partial_runtime", true)).toBe(
      "Partial planned import",
    );
    expect(resourceCompletenessStatusLabel("preserved_for_rebuild", true)).toBe(
      "Rebuild review planned",
    );
  });
});
