import { describe, expect, it } from "vitest";

import {
  collectionColumnNote,
  collectionColumns,
  collectionRowPreviewNote,
  formatCollectionCell,
  previewWasSanitized,
  sanitizeCellText,
} from "@/lib/collectionRows";

describe("preview columns", () => {
  it("keeps first-seen order across heterogeneous rows", () => {
    // RowValue is map[string]any (types.go:58) — row 2 legitimately carries a
    // field row 1 does not.
    const columns = collectionColumns(
      [
        { code: "A", amount: 10 },
        { code: "B", expires: "2026-08-01" },
      ],
      10,
    );
    expect(columns.names).toEqual(["code", "amount", "expires"]);
    expect(columns.total).toBe(3);
  });

  it("caps the columns it shows and says how many it left off", () => {
    const columns = collectionColumns(
      [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }],
      4,
    );
    expect(columns.names).toEqual(["a", "b", "c", "d"]);
    expect(collectionColumnNote(columns)).toBe("2 more fields in these rows.");
  });

  it("says nothing when every field is on screen", () => {
    expect(collectionColumnNote(collectionColumns([{ a: 1 }], 4))).toBeNull();
  });
});

describe("cell rendering", () => {
  it("keeps an absent key, a stored null, an empty string and a zero apart", () => {
    const row = { nulled: null, blank: "", zero: 0 };
    expect(formatCollectionCell(row, "missing")).toMatchObject({
      text: "—",
      missing: true,
    });
    expect(formatCollectionCell(row, "nulled")).toMatchObject({
      text: "null",
      missing: false,
    });
    expect(formatCollectionCell(row, "blank").text).toBe("(empty)");
    expect(formatCollectionCell(row, "zero").text).toBe("0");
  });

  it("never rounds a stored number", () => {
    // `num` is maximumFractionDigits: 0, so routing a price through it would
    // print 12.5 as "13" inside a table read to verify an import.
    expect(formatCollectionCell({ price: 12.5 }, "price").text).toBe("12.5");
    expect(formatCollectionCell({ n: 1234567 }, "n").text).toBe("1,234,567");
  });

  it("describes nested structures by shape, never by inventing a delimiter", () => {
    expect(formatCollectionCell({ tags: ["a", "b"] }, "tags").text).toBe(
      "[2 items]",
    );
    expect(formatCollectionCell({ meta: { a: 1 } }, "meta").text).toBe(
      "{1 field}",
    );
  });

  it("prints booleans as words", () => {
    expect(formatCollectionCell({ ok: false }, "ok").text).toBe("false");
  });
});

describe("cell sanitisation", () => {
  it("strips text-direction runes a stored VALUE may legally contain", () => {
    // validateObjectKey bans these in field NAMES (validation.go:196-200);
    // validateJSONValue does NOT ban them in string values
    // (validation.go:236-247). Rendering one raw lets a row reverse the line.
    const cell = sanitizeCellText("invoice\u202Efdp.exe");
    expect(cell.text).toBe("invoicefdp.exe");
    expect(cell.sanitized).toBe(true);
  });

  it("reports a value that was ONLY formatting rather than printing nothing", () => {
    const cell = sanitizeCellText("\u202E\u202C");
    expect(cell.text).toBe("(formatting only)");
    expect(cell.sanitized).toBe(true);
  });

  it("clips a 64 KiB string and admits it clipped", () => {
    // MaxStringValueBytes is 64 KiB (types.go:120) — a legal cell no phone lays out.
    const cell = sanitizeCellText("x".repeat(5000));
    expect(cell.truncated).toBe(true);
    expect([...cell.text]).toHaveLength(65); // 64 + the ellipsis
  });

  it("surfaces sanitisation across a whole preview", () => {
    const rows = [{ code: "fine" }, { code: "bad\u202Ename" }];
    expect(previewWasSanitized(rows, ["code"])).toBe(true);
    expect(previewWasSanitized([{ code: "fine" }], ["code"])).toBe(false);
  });
});

describe("row preview note", () => {
  it("states the cap so a preview is never read as the table", () => {
    expect(collectionRowPreviewNote(12, 4318)).toBe(
      "Showing the first 12 of 4,318 rows. The rest are on the web admin.",
    );
  });

  it("stays silent when the preview IS the collection", () => {
    expect(collectionRowPreviewNote(12, 12)).toBeNull();
    expect(collectionRowPreviewNote(12, null)).toBeNull();
  });
});
