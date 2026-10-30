/**
 * subscriberCustomObjects — camelCase wire parsing (the custom-objects
 * service, unlike the subscriber routes) and the absence-is-absent rule for
 * catalog traits.
 */
import { describe, expect, it } from "vitest";

import {
  parseCatalogAttributes,
  parseProfileLinks,
} from "./subscriberCustomObjects";

describe("parseProfileLinks", () => {
  it("parses the camelCase {items} rows with denormalized labels", () => {
    expect(
      parseProfileLinks({
        items: [
          {
            id: "link-1",
            objectTypeLabel: "Product",
            objectTypeKey: "product",
            objectRecordId: "rec-9",
            externalId: "SKU-42",
            relationship: "purchased",
          },
          {
            id: "link-2",
            objectTypeKey: "warranty",
            objectRecordId: "rec-10",
            relationship: "",
          },
        ],
      }),
    ).toEqual([
      {
        id: "link-1",
        typeLabel: "Product",
        recordLabel: "SKU-42",
        relationship: "purchased",
      },
      {
        id: "link-2",
        typeLabel: "warranty",
        recordLabel: "rec-10",
        relationship: "related",
      },
    ]);
  });

  it("returns [] for junk", () => {
    expect(parseProfileLinks(null)).toEqual([]);
    expect(parseProfileLinks({ items: "nope" })).toEqual([]);
  });
});

describe("parseCatalogAttributes", () => {
  it("renders computed traits with their evidence and omits never-computed ones", () => {
    expect(
      parseCatalogAttributes({
        subscriber_id: "sub-1",
        favorite_category: { category: "cycling", count: 7 },
        last_viewed_sku: null,
      }),
    ).toEqual([{ label: "Favorite category", value: "cycling (7 views)" }]);
    expect(parseCatalogAttributes({ last_viewed_sku: "SKU-42" })).toEqual([
      { label: "Last viewed SKU", value: "SKU-42" },
    ]);
    expect(parseCatalogAttributes({})).toEqual([]);
  });
});
