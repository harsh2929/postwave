import { describe, expect, it } from "vitest";

import {
  PRODUCT_EVENT_EXPORT_MAX_ROWS,
  PRODUCT_EVENT_EXPORT_SERVER_CAP,
  productEventsCsv,
  productEventsExportNotice,
  productEventsExportPath,
} from "./productEventsExport";

const HEADER =
  "id,occurred_at,received_at,subscriber_id,event_name,properties_json";

const row = (id: string, name = "purchase") =>
  `${id},2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-${id},${name},"{""a"":1}"`;

describe("the share cap", () => {
  it("stays a share-sized slice, well under the server's own ceiling", () => {
    // LITERAL, on purpose. Asserting `limit=${PRODUCT_EVENT_EXPORT_MAX_ROWS}`
    // reads the constant under test on both sides, so raising the cap to
    // 50,000 passed every other test in this file. A share sheet is not a
    // file: the receiving app silently truncates or drops a payload this size,
    // and the truncation notice would then be a guess about what arrived.
    expect(PRODUCT_EVENT_EXPORT_MAX_ROWS).toBe(500);
    expect(PRODUCT_EVENT_EXPORT_SERVER_CAP).toBe(10_000);
    expect(PRODUCT_EVENT_EXPORT_MAX_ROWS).toBeLessThan(
      PRODUCT_EVENT_EXPORT_SERVER_CAP,
    );
    expect(
      productEventsExportPath({
        days: 30,
        limit: 99_999,
        now: new Date("2026-08-31T00:00:00.000Z"),
      }),
    ).toContain("limit=500");
  });
});

describe("productEventsExportPath", () => {
  it("asks for the window on screen and never more than the share cap", () => {
    const path = productEventsExportPath({
      days: 30,
      limit: 99_999,
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(path).toContain("occurred_after=2026-08-01T00%3A00%3A00.000Z");
    expect(path).toContain(`limit=${PRODUCT_EVENT_EXPORT_MAX_ROWS}`);
  });

  it("encodes an event-name filter rather than pasting it into the query", () => {
    const path = productEventsExportPath({
      days: 7,
      eventName: "cart abandoned&x=1",
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(path).toContain("event_name=cart%20abandoned%26x%3D1");
  });

  it("refuses a zero or negative window instead of exporting everything", () => {
    const path = productEventsExportPath({
      days: 0,
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(path).toContain("occurred_after=2026-08-30T00%3A00%3A00.000Z");
  });
});

describe("productEventsCsv", () => {
  it("keeps the identity columns and drops the payload column", () => {
    const out = productEventsCsv([HEADER, row("1")].join("\n"), { days: 30 });
    expect(out.body.split("\n")[0]).toBe(
      "id,occurred_at,received_at,subscriber_id,event_name",
    );
    expect(out.body).not.toContain('{""a""');
    expect(out.included).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it("reads its columns from the header, so a reordered payload cannot ride out under event_name", () => {
    // The failure this pins: the server moves `properties_json` ahead of
    // `event_name`. A positional copy would ship the payload — the PII-dense
    // field this export exists to drop — labelled `event_name`, to whoever the
    // share sheet was pointed at.
    const moved =
      "id,occurred_at,received_at,subscriber_id,properties_json,event_name";
    const out = productEventsCsv(
      [
        moved,
        `7,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-7,"{""card"":""4242""}",purchase`,
      ].join("\n"),
      { days: 30 },
    );
    expect(out.body.split("\n")[1]).toBe(
      "7,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-7,purchase",
    );
    expect(out.body).not.toContain("4242");
  });

  it("blanks a column the header no longer names rather than guessing its old slot", () => {
    const renamed =
      "id,occurred_at,received_at,subscriber_id,name,properties_json";
    const out = productEventsCsv(
      [
        renamed,
        `7,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-7,purchase,"{""a"":1}"`,
      ].join("\n"),
      { days: 30 },
    );
    // Header row unchanged, last cell empty — never the payload that happens
    // to sit one column further along.
    expect(out.body.split("\n")[1]).toBe(
      "7,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-7,",
    );
  });

  it("neutralises a formula an event name smuggled in", () => {
    const hostile = `9,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-9,"=HYPERLINK(""http://evil"",""x"")","{}"`;
    const out = productEventsCsv([HEADER, hostile].join("\n"), { days: 30 });
    // Prefixed with an apostrophe INSIDE the quoted field, so a spreadsheet
    // reads it as text.
    expect(out.body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(out.body).not.toContain(`,"=HYPERLINK`);
  });

  it("does not double-escape a cell the server already guarded", () => {
    const guarded = `9,2026-08-30T10:00:00Z,2026-08-30T10:00:01Z,sub-9,'=danger,{}`;
    const out = productEventsCsv([HEADER, guarded].join("\n"), { days: 30 });
    expect(out.body).toContain("'=danger");
    expect(out.body).not.toContain("''=danger");
  });

  it("treats an exactly-full response as truncated", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(String(i)));
    const out = productEventsCsv([HEADER, ...rows].join("\n"), {
      days: 30,
      cap: 10,
    });
    expect(out.included).toBe(10);
    expect(out.truncated).toBe(true);
    expect(out.title).toContain("newest 10");
  });

  it("names the window, and the event filter when there is one", () => {
    const one = [HEADER, row("1")].join("\n");
    expect(productEventsCsv(one, { days: 7 }).title).toBe(
      "Product events — 1 in the last 7 days",
    );
    expect(
      productEventsCsv(one, { days: 7, eventName: "purchase" }).title,
    ).toBe("Product events — purchase · 1 in the last 7 days");
  });

  it("survives an empty body and a header-only response", () => {
    expect(productEventsCsv("", { days: 30 }).included).toBe(0);
    expect(productEventsCsv(HEADER, { days: 30 }).included).toBe(0);
    expect(productEventsCsv(HEADER, { days: 30 }).truncated).toBe(false);
  });

  it("keeps a row whose first column is not the literal header", () => {
    const out = productEventsCsv([row("1"), row("2")].join("\n"), { days: 30 });
    expect(out.included).toBe(2);
  });
});

describe("productEventsExportNotice", () => {
  it("says out loud that properties are missing, and when rows were dropped", () => {
    const partial = productEventsCsv(
      [HEADER, row("1"), row("2")].join("\n"),
      { days: 30, cap: 1 },
    );
    const notice = productEventsExportNotice(partial);
    expect(notice).toContain("newest 1");
    expect(notice).toContain("web export");
    expect(notice).toContain("properties");
  });

  it("refuses to claim a share when there was nothing to send", () => {
    expect(productEventsExportNotice(productEventsCsv("", { days: 30 }))).toBe(
      "No events in this window — there was nothing to export.",
    );
  });
});
