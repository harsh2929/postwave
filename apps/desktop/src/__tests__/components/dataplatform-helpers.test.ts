/**
 * Pure-logic tests for the Data Platform page helpers (#35 warehouse,
 * #36 custom objects, #37 CDP transforms).
 * Node environment — no DOM, no React.
 */

import { describe, expect, it } from "vitest";

import type { CustomObjectType, WarehouseSyncRun } from "../../lib/api-client";
import {
  parsePreviewInput,
  outcomeSummary,
  resultRows,
} from "../../components/dataplatform/cdp-transforms-helpers";
import {
  isSimpleObjectSchema,
  parseJsonObject,
  propertiesPreview,
  propertyRowErrors,
  recordViolations,
  rowsToSchema,
  schemaToRows,
  typeDraftErrors,
  typeDraftFrom,
  typeDraftSchema,
} from "../../components/dataplatform/custom-objects-helpers";
import {
  cellText,
  connectionDraftErrors,
  connectionDraftToInput,
  emptyConnectionDraft,
  extractWarehouseValidation,
  mappingDraftErrors,
  mappingDraftFrom,
  mappingDraftToInput,
  runErrorColumns,
  runQueuedMessage,
  runRowCounts,
  runStatusTone,
  toggleSelection,
} from "../../components/dataplatform/warehouse-helpers";

/* =================== warehouse (#35) =================== */

describe("warehouse connection draft", () => {
  it("requires name, provider, and at least one object", () => {
    const e = connectionDraftErrors(emptyConnectionDraft());
    expect(e.name).toBeTruthy();
    expect(e.provider).toBeTruthy();
    expect(e.objectSelection).toBeTruthy();
  });

  it("validates config JSON shape", () => {
    const d = { ...emptyConnectionDraft(), configText: "[1,2]" };
    expect(connectionDraftErrors(d).config).toBe(
      "Config must be a JSON object",
    );
    expect(connectionDraftErrors({ ...d, configText: "{nope" }).config).toBe(
      "Config is not valid JSON",
    );
  });

  it("builds the snake_case wire input", () => {
    const d = {
      ...emptyConnectionDraft(),
      name: " Snowflake prod ",
      provider: "snowflake",
      direction: "import",
      cadence: "daily",
      backfillDays: "14",
      credentialsRef: "vault://wh",
      configText: '{"account":"xy123"}',
      objectSelection: ["orders", "customers"],
    };
    expect(connectionDraftErrors(d)).toEqual({});
    expect(connectionDraftToInput(d)).toEqual({
      name: "Snowflake prod",
      provider: "snowflake",
      direction: "import",
      cadence: "daily",
      backfill_days: 14,
      object_selection: ["orders", "customers"],
      credentials_ref: "vault://wh",
      config: { account: "xy123" },
      // GAP-1#3: UI-created connections are sent status "active" so they
      // don't dead-end in the server's default "draft".
      status: "active",
    });
  });

  it("toggleSelection adds and removes", () => {
    expect(toggleSelection([], "orders")).toEqual(["orders"]);
    expect(toggleSelection(["orders"], "orders")).toEqual([]);
  });
});

describe("extractWarehouseValidation (400-body deviation)", () => {
  it("recovers the structured result from the raw 400 body", () => {
    const v = extractWarehouseValidation(
      '{"valid":false,"errors":["name is required"],"warnings":["no cadence"]}',
    );
    expect(v).toEqual({
      valid: false,
      errors: ["Add a connection name."],
      warnings: [
        "The server reported a connection-readiness warning. Review provider availability before saving.",
      ],
    });
  });

  it("returns null for normal error envelopes / plain text", () => {
    expect(
      extractWarehouseValidation("Server error. Please try again."),
    ).toBeNull();
    expect(extractWarehouseValidation('{"error":{"code":"x"}}')).toBeNull();
    expect(extractWarehouseValidation("{truncated")).toBeNull();
    expect(extractWarehouseValidation(undefined)).toBeNull();
  });
});

describe("warehouse mapping draft", () => {
  it("hydrates from an existing mapping including property_map JSON", () => {
    const d = mappingDraftFrom("orders", {
      source_object: "orders",
      target_event_name: "order_placed",
      profile_key_column: "email",
      occurred_at_column: "created_at",
      property_map: { total: "total_cents" },
      status: "active",
      version: 3,
    });
    expect(d.targetEventName).toBe("order_placed");
    expect(JSON.parse(d.propertyMapText)).toEqual({ total: "total_cents" });
  });

  it("requires the three core columns", () => {
    const e = mappingDraftErrors(mappingDraftFrom("orders", null));
    expect(e.targetEventName).toBeTruthy();
    expect(e.profileKeyColumn).toBeTruthy();
    expect(e.occurredAtColumn).toBeTruthy();
  });

  it("builds the PUT body on the wire shape", () => {
    const d = mappingDraftFrom("orders", null);
    d.targetEventName = "order_placed";
    d.profileKeyColumn = "email";
    d.occurredAtColumn = "created_at";
    d.propertyMapText = '{"total":"total_cents"}';
    expect(mappingDraftToInput(d)).toEqual({
      source_object: "orders",
      target_event_name: "order_placed",
      profile_key_column: "email",
      occurred_at_column: "created_at",
      status: "active",
      property_map: { total: "total_cents" },
    });
  });
});

describe("warehouse run display", () => {
  function run(partial: Partial<WarehouseSyncRun> = {}): WarehouseSyncRun {
    return {
      id: "run_12345678",
      direction: "import",
      run_mode: "manual",
      status: "queued",
      object_selection: ["orders"],
      rows_scanned: 0,
      rows_exported: 0,
      rows_imported: 0,
      rows_failed: 0,
      schema_errors: 0,
      retry_count: 0,
      issue_present: false,
      created_at: "2026-06-11T00:00:00Z",
      updated_at: "2026-06-11T00:00:00Z",
      ...partial,
    };
  }

  it("maps statuses to tones", () => {
    expect(runStatusTone("succeeded")).toBe("success");
    expect(runStatusTone("running")).toBe("warning");
    expect(runStatusTone("failed")).toBe("danger");
    expect(runStatusTone("???")).toBe("neutral");
  });

  it("summarizes only the counters that carry signal", () => {
    expect(runRowCounts(run())).toBe("no rows");
    expect(
      runRowCounts(
        run({ rows_scanned: 1200, rows_imported: 1100, rows_failed: 4 }),
      ),
    ).toBe("1,200 scanned · 1,100 imported · 4 failed");
  });

  it("run receipt is honest about HTTP 202 completing inline work", () => {
    const m = runQueuedMessage(run());
    expect(m).toContain("202");
    expect(m).toContain("inline execution");
    expect(m).toContain("status “queued”");
    expect(m).not.toMatch(/background|enqueued/i);
    expect(m).not.toMatch(/completed|finished/i);
  });

  it("orders error columns with well-known keys first", () => {
    const cols = runErrorColumns([
      { zebra: 1, message: "bad row", row: 4 },
      { code: "type_mismatch" },
    ]);
    expect(cols.slice(0, 3)).toEqual(["row", "code", "message"]);
    expect(cols).toContain("zebra");
  });

  it("renders arbitrary cell values safely", () => {
    expect(cellText(null)).toBe("—");
    expect(cellText("x")).toBe("x");
    expect(cellText(4)).toBe("4");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});

/* =================== custom objects (#36) =================== */

describe("custom object schema round-trip", () => {
  const simple = {
    type: "object",
    properties: { total: { type: "number" }, sku: { type: "string" } },
    required: ["sku"],
  };

  it("detects simple schemas (and empty/null ones)", () => {
    expect(isSimpleObjectSchema(simple)).toBe(true);
    expect(isSimpleObjectSchema(null)).toBe(true);
    expect(isSimpleObjectSchema({})).toBe(true);
  });

  it("rejects schemas with constraints the row editor would drop", () => {
    expect(
      isSimpleObjectSchema({
        type: "object",
        properties: { tier: { type: "string", enum: ["a", "b"] } },
      }),
    ).toBe(false);
    expect(isSimpleObjectSchema({ minLength: 2 })).toBe(false);
    expect(isSimpleObjectSchema([1])).toBe(false);
  });

  it("round-trips rows ↔ schema", () => {
    const rows = schemaToRows(simple);
    expect(rows).toEqual([
      { name: "total", type: "number", required: false },
      { name: "sku", type: "string", required: true },
    ]);
    expect(rowsToSchema(rows)).toEqual(simple);
  });

  it("drops blank-named rows and omits empty required", () => {
    const s = rowsToSchema([
      { name: " ", type: "string", required: true },
      { name: "qty", type: "integer", required: false },
    ]);
    expect(s).toEqual({
      type: "object",
      properties: { qty: { type: "integer" } },
    });
  });

  it("round-trips an own __proto__ property without mutating prototypes", () => {
    const rows = [
      { name: "__proto__", type: "string" as const, required: true },
    ];
    const schema = rowsToSchema(rows);
    const properties = schema.properties as Record<string, unknown>;

    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(properties.__proto__).toEqual({ type: "string" });
    expect(schemaToRows(schema)).toEqual(rows);
    expect(
      (JSON.parse(JSON.stringify(schema)) as { properties: object }).properties,
    ).toHaveProperty("__proto__", { type: "string" });
    expect(Object.hasOwn(Object.prototype, "type")).toBe(false);
  });

  it("flags duplicate property names", () => {
    expect(
      propertyRowErrors([
        { name: "sku", type: "string", required: false },
        { name: "sku", type: "number", required: false },
      ]),
    ).toBe("Property names must be unique");
  });
});

describe("custom object type draft", () => {
  function objType(partial: Partial<CustomObjectType> = {}): CustomObjectType {
    return {
      id: "cot_1",
      tenantId: "t1",
      key: "order",
      label: "Order",
      primaryKey: "external_id",
      schema: { type: "object", properties: { sku: { type: "string" } } },
      status: "active",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      ...partial,
      version: partial.version ?? 1,
    };
  }

  it("hydrates simple schemas into the row editor", () => {
    const d = typeDraftFrom(objType());
    expect(d.rawSchemaText).toBeNull();
    expect(d.rows).toEqual([{ name: "sku", type: "string", required: false }]);
  });

  it("falls back to raw-JSON mode for rich schemas", () => {
    const d = typeDraftFrom(
      objType({
        schema: {
          type: "object",
          properties: { tier: { type: "string", enum: ["a"] } },
        } as unknown as Record<string, unknown>,
      }),
    );
    expect(d.rawSchemaText).toContain("enum");
    expect(typeDraftSchema(d)).toEqual({
      type: "object",
      properties: { tier: { type: "string", enum: ["a"] } },
    });
  });

  it("validates the key format on create only", () => {
    const d = typeDraftFrom(null);
    d.key = "Bad Key";
    d.label = "x";
    expect(typeDraftErrors(d, "create").key).toBeTruthy();
    expect(typeDraftErrors(d, "edit").key).toBeUndefined();
  });
});

describe("record helpers", () => {
  it("recovers 422 violations from the lifted error details", () => {
    expect(
      recordViolations({
        fields: [
          {
            field: "total",
            code: "type_mismatch",
            message: "expected number; rejected value was 4111111111111111",
          },
          "junk",
        ],
      }),
    ).toEqual([
      {
        field: "total",
        code: "type_mismatch",
        message: "Use the value type required by this field.",
      },
    ]);
    expect(recordViolations(undefined)).toEqual([]);
    expect(recordViolations({ fields: "no" })).toEqual([]);
  });

  it("fails closed for unsafe fields, unknown codes, raw messages, and oversized lists", () => {
    const rawSecret = "bearer private-canary rejected@example.test";
    const violations = recordViolations({
      fields: [
        {
          field: "items[12].sku",
          code: "required",
          message: rawSecret,
        },
        {
          field: `unsafe.${"x".repeat(120)}<script>`,
          code: `unknown_${"z".repeat(80)}`,
          message: rawSecret,
        },
        ...Array.from({ length: 20 }, (_, index) => ({
          field: `field_${index}`,
          code: "minimum",
          message: `${rawSecret}-${index}`,
        })),
      ],
    });

    expect(violations).toHaveLength(12);
    expect(violations[0]).toEqual({
      field: "items[12].sku",
      code: "required",
      message: "Add this required field.",
    });
    expect(violations[1]).toEqual({
      field: "Record",
      code: "schema_violation",
      message: "This field did not satisfy the saved schema.",
    });
    expect(JSON.stringify(violations)).not.toContain(rawSecret);
    expect(JSON.stringify(violations)).not.toContain("<script>");
    expect(JSON.stringify(violations)).not.toContain("unknown_");
  });

  it("parses the properties textarea (empty = {})", () => {
    expect(parseJsonObject("")).toEqual({ value: {}, error: null });
    expect(parseJsonObject('{"a":1}').value).toEqual({ a: 1 });
    expect(parseJsonObject("[1]").error).toBe("Expected a JSON object");
    expect(parseJsonObject("{x").error).toContain("Not valid JSON");
  });

  it("previews properties compactly", () => {
    expect(propertiesPreview({})).toBe("—");
    expect(
      propertiesPreview({
        a: 1,
        b: "very-long-string-value-here-yes",
        c: null,
        d: {},
        e: 5,
      }),
    ).toContain("+1 more");
  });
});

/* =================== CDP transforms (#37) =================== */

describe("cdp transform preview input", () => {
  it("parses valid properties + ops", () => {
    const p = parsePreviewInput(
      '{"email":" X@Y.COM "}',
      '[{"type":"trim","field":"email"},{"type":"regex_replace","field":"email","args":{"pattern":"@"}}]',
    );
    expect(p.propertiesError).toBeNull();
    expect(p.opsError).toBeNull();
    expect(p.ops).toHaveLength(2);
    expect(p.ops?.[1]?.args).toEqual({ pattern: "@" });
  });

  it("reports independent, position-bearing errors", () => {
    const p = parsePreviewInput("[1]", '[{"type":"trim"}]');
    expect(p.propertiesError).toBe("Properties must be a JSON object");
    expect(p.opsError).toBe('Op 1 is missing "field"');

    expect(parsePreviewInput("{}", "[]").opsError).toBe("Add at least one op");
    expect(parsePreviewInput("", "x").propertiesError).toContain(
      "Provide an input properties object",
    );
    expect(parsePreviewInput("{}", '[{"field":"a"}]').opsError).toBe(
      'Op 1 is missing "type"',
    );
  });
});

describe("cdp transform results", () => {
  it("flattens results for the side-by-side table", () => {
    const rows = resultRows([
      {
        op: { type: "trim", field: "email" },
        changed: true,
        old_value: " x ",
        new_value: "x",
      },
      {
        op: { type: "boom", field: "email" },
        changed: false,
        error: "unknown op",
      },
    ]);
    expect(rows[0]).toEqual({
      label: "trim(email)",
      changed: true,
      oldValue: '" x "',
      newValue: '"x"',
      error: null,
    });
    expect(rows[1]?.error).toBe("unknown op");
    expect(rows[1]?.oldValue).toBe("—");
  });

  it("summarizes the outcome", () => {
    expect(outcomeSummary({ success: 1, failed: 0 })).toBe(
      "1 op succeeded · 0 failed",
    );
    expect(outcomeSummary({ success: 2, failed: 1 })).toBe(
      "2 ops succeeded · 1 failed",
    );
  });
});
