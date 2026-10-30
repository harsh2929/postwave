// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { summarizeBlockCategories } from "@/components/mailchimp-parity/content-studio-panel";

describe("ContentStudioPanel helpers", () => {
  it("counts content block categories in first-seen order", () => {
    expect(
      summarizeBlockCategories([
        {
          id: "text",
          name: "Text",
          category: "content",
          description: "Text block",
          fields: ["text"],
          default_data: {},
          mailchimp_key: "text",
        },
        {
          id: "divider",
          name: "Divider",
          category: "layout",
          description: "Divider block",
          fields: [],
          default_data: {},
          mailchimp_key: "divider",
        },
        {
          id: "image",
          name: "Image",
          category: "content",
          description: "Image block",
          fields: ["src", "alt"],
          default_data: {},
          mailchimp_key: "image",
        },
      ]),
    ).toEqual([
      ["content", 2],
      ["layout", 1],
    ]);
  });

  it("handles missing catalogs without forcing placeholder categories", () => {
    expect(summarizeBlockCategories(undefined)).toEqual([]);
  });
});
