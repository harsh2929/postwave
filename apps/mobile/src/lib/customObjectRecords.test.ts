/**
 * PARITY (commerce-data) — reading records whose SHAPE the tenant defined.
 *
 * The property under test throughout is that NOTHING here assumes a schema and
 * nothing disappears quietly. A workspace's "booking" and the next one's
 * "order" share no fields, so every assertion below is about the parser
 * carrying the server's own words across rather than about any particular one.
 */
import { describe, expect, it } from "vitest";

import {
  customObjectFields,
  customObjectRecordTitle,
  customObjectRecordsSummary,
  customObjectsErrorMessage,
  parseCustomObjectRecords,
  parseCustomObjectTypes,
} from "./customObjectRecords";

const TYPES = {
  items: [
    {
      id: "type_1",
      key: "booking",
      label: "Court booking",
      primaryKey: "reference",
      status: "active",
      version: 3,
    },
    { id: "type_2", key: "policy", label: "", primaryKey: "", status: "" },
  ],
};

describe("parseCustomObjectTypes", () => {
  it("keeps the workspace's own key, label and primary key", () => {
    const [booking] = parseCustomObjectTypes(TYPES);
    expect(booking).toEqual({
      id: "type_1",
      key: "booking",
      label: "Court booking",
      primaryKey: "reference",
      status: "active",
      version: 3,
    });
  });

  it("names an unlabelled type by its key rather than dropping it", () => {
    const rows = parseCustomObjectTypes(TYPES);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.label).toBe("policy");
    expect(rows[1]?.primaryKey).toBeNull();
    expect(rows[1]?.version).toBeNull();
  });

  it("drops only a row with no id, and refuses a non-envelope body", () => {
    expect(parseCustomObjectTypes({ items: [{ key: "orphan" }] })).toEqual([]);
    expect(parseCustomObjectTypes({ items: "nope" })).toEqual([]);
    expect(parseCustomObjectTypes(null)).toEqual([]);
    expect(parseCustomObjectTypes([TYPES])).toEqual([]);
  });
});

describe("customObjectFields", () => {
  it("prints every scalar under the workspace's own key, sorted", () => {
    expect(
      customObjectFields({ zeta: 1, alpha: "yes", mid: false }),
    ).toEqual([
      { key: "alpha", value: "yes", kind: "text" },
      { key: "mid", value: "false", kind: "boolean" },
      { key: "zeta", value: "1", kind: "number" },
    ]);
  });

  it("keeps an empty field present instead of removing it", () => {
    expect(customObjectFields({ note: null, blank: "" })).toEqual([
      { key: "blank", value: "", kind: "empty" },
      { key: "note", value: "—", kind: "empty" },
    ]);
  });

  it("shows short nested JSON and DESCRIBES what is too long to read", () => {
    const short = customObjectFields({ court: { number: 4 } })[0];
    expect(short).toEqual({
      key: "court",
      value: '{"number":4}',
      kind: "nested",
    });

    const long = customObjectFields({ history: { note: "x".repeat(200) } })[0];
    expect(long?.kind).toBe("nested");
    expect(long?.value).toContain("1 nested fields");
    // The point of the branch: it must NOT be a truncation of the value.
    expect(long?.value).not.toContain("xxxx");

    const list = customObjectFields({ slots: new Array(40).fill("slot-name") })[0];
    expect(list?.value).toContain("40 entries");
  });

  it("names a value it cannot print rather than blanking the row", () => {
    const row = customObjectFields({ count: 10n })[0];
    expect(row?.kind).toBe("unrenderable");
    expect(row?.value).toContain("bigint");
    // NaN is a number to `typeof` and nothing to a reader.
    expect(customObjectFields({ score: Number.NaN })[0]?.kind).toBe(
      "unrenderable",
    );
  });

  it("returns nothing for a properties value that is not a field map", () => {
    expect(customObjectFields(["a"])).toEqual([]);
    expect(customObjectFields("a")).toEqual([]);
    expect(customObjectFields(null)).toEqual([]);
  });
});

describe("parseCustomObjectRecords", () => {
  it("reads the page the SERVER applied, not the one we asked for", () => {
    const page = parseCustomObjectRecords({
      items: [
        {
          id: "rec_1",
          externalId: "BK-1001",
          updatedAt: "2026-09-01T10:00:00Z",
          properties: { reference: "BK-1001", paid: true },
        },
      ],
      limit: 25,
      hasMore: true,
    });
    expect(page.limit).toBe(25);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.fields).toHaveLength(2);
    expect(page.items[0]?.unreadable).toBeNull();
  });

  it("renders a record whose properties are not a field map, and says so", () => {
    const page = parseCustomObjectRecords({
      items: [
        { id: "rec_2", properties: ["a", "b"] },
        { id: "rec_3", properties: null },
        { id: "rec_4" },
      ],
    });
    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.unreadable).toContain("a list");
    expect(page.items[1]?.unreadable).toContain("no properties");
    expect(page.items[2]?.unreadable).toContain("no properties");
  });

  it("falls back to createdAt, and treats a missing envelope as an empty page", () => {
    const page = parseCustomObjectRecords({
      items: [{ id: "rec_5", createdAt: "2026-08-30T09:00:00Z" }],
      hasMore: "yes",
    });
    expect(page.items[0]?.updatedAt).toBe("2026-08-30T09:00:00Z");
    // Anything but a literal `true` is not "there are more".
    expect(page.hasMore).toBe(false);
    expect(parseCustomObjectRecords(null)).toEqual({
      items: [],
      limit: null,
      hasMore: false,
    });
  });
});

describe("customObjectRecordTitle", () => {
  const type = parseCustomObjectTypes(TYPES)[0] ?? null;

  it("uses the property the TYPE calls the natural id", () => {
    const record = parseCustomObjectRecords({
      items: [
        {
          id: "rec_1",
          externalId: "BK-1001",
          properties: { reference: "Court 4 · Tue 18:00" },
        },
      ],
    }).items[0]!;
    expect(customObjectRecordTitle(record, type)).toBe("Court 4 · Tue 18:00");
  });

  it("never titles a record with an empty or nested primary value", () => {
    const [empty, nested] = parseCustomObjectRecords({
      items: [
        { id: "rec_1", externalId: "BK-1", properties: { reference: null } },
        { id: "rec_2", properties: { reference: { deep: true } } },
      ],
    }).items;
    expect(customObjectRecordTitle(empty!, type)).toBe("BK-1");
    expect(customObjectRecordTitle(nested!, type)).toBe("rec_2");
  });

  it("falls back through externalId to the id when there is no type", () => {
    const record = parseCustomObjectRecords({
      items: [{ id: "rec_9", externalId: "X-9", properties: {} }],
    }).items[0]!;
    expect(customObjectRecordTitle(record, null)).toBe("X-9");
  });
});

describe("customObjectRecordsSummary", () => {
  it("states the denominator it actually read", () => {
    expect(
      customObjectRecordsSummary({ items: [], limit: 25, hasMore: false }),
    ).toBe("0 records.");
    expect(
      customObjectRecordsSummary({
        items: [{ id: "a", externalId: null, updatedAt: null, fields: [], unreadable: null }],
        limit: 25,
        hasMore: false,
      }),
    ).toBe("1 record — that is all of them.");
  });

  it("refuses to imply the page is the whole type when there is more", () => {
    const line = customObjectRecordsSummary({
      items: new Array(25).fill({
        id: "a",
        externalId: null,
        updatedAt: null,
        fields: [],
        unreadable: null,
      }),
      limit: 25,
      hasMore: true,
    });
    expect(line).toContain("25 most recent records");
    expect(line).toContain("web admin");
    expect(line).not.toContain("that is all of them");
  });
});

describe("customObjectsErrorMessage", () => {
  it("gives the URL-filter refusal its own sentence", () => {
    expect(
      customObjectsErrorMessage({ status: 400, code: "unsafe_filter_transport" }),
    ).toContain("can't be sent in a URL");
  });

  it("separates the role, the missing type and a rejected request", () => {
    expect(customObjectsErrorMessage({ status: 403 })).toContain(
      "workspace session",
    );
    expect(customObjectsErrorMessage({ status: 404 })).toContain(
      "no longer exists",
    );
    const rejected = Object.assign(new Error("limit must be 1 to 500."), {
      status: 400,
    });
    expect(customObjectsErrorMessage(rejected)).toBe("limit must be 1 to 500.");
    expect(customObjectsErrorMessage({ status: 500 })).toBe(
      "Couldn't load these records.",
    );
  });
});
