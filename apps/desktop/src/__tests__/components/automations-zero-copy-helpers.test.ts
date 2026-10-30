/**
 * Pure-logic tests for the Zero-copy triggers section (#28).
 * Node environment — no DOM, no React.
 */

import { describe, expect, it } from "vitest";

import type { ZeroCopyTrigger } from "../../lib/api-client";
import {
  DEFAULT_MAX_ROWS_PER_TICK,
  DEFAULT_POLL_INTERVAL_SECONDS,
  canValidate,
  draftErrors,
  draftFromTrigger,
  draftToInput,
  extractValidationResult,
  fireStatusTone,
  fmtDuration,
  maskOperationalIdentifier,
  normalizeValidationResult,
  savedTriggerMatchesInput,
  triggerHealth,
} from "../../components/automations/zero-copy-helpers";
import { normalizeTriggerDefinitions } from "../../components/automations/response-normalizers";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const JOURNEY_ID = "22222222-2222-4222-8222-222222222222";
const RUNTIME = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Zero-copy execution is unavailable.",
  prerequisites: ["durable_execution_receipts"],
};

function trigger(partial: Partial<ZeroCopyTrigger> = {}): ZeroCopyTrigger {
  return {
    id: "zct_1",
    name: "New orders",
    status: "active",
    provider: "snowflake",
    query: "SELECT * FROM orders WHERE created_at > :cursor",
    cursor_column: "created_at",
    profile_key_column: "email",
    polling_interval_seconds: 300,
    max_rows_per_tick: 500,
    consecutive_failures: 0,
    rows_fired_total: 42,
    runtime: RUNTIME,
    ...partial,
  };
}

describe("draftFromTrigger / draftToInput round-trip", () => {
  it("hydrates a draft from an existing trigger", () => {
    const d = draftFromTrigger(
      trigger({ connection_id: CONNECTION_ID, journey_id: JOURNEY_ID }),
    );
    expect(d.name).toBe("New orders");
    expect(d.connectionId).toBe(CONNECTION_ID);
    expect(d.journeyId).toBe(JOURNEY_ID);
    expect(d.pollingIntervalSeconds).toBe("300");
    expect(d.status).toBe("active");
  });

  it("defaults numeric fields for a blank draft", () => {
    const d = draftFromTrigger(null);
    expect(d.pollingIntervalSeconds).toBe(
      String(DEFAULT_POLL_INTERVAL_SECONDS),
    );
    expect(d.maxRowsPerTick).toBe(String(DEFAULT_MAX_ROWS_PER_TICK));
    expect(d.status).toBe("draft");
  });

  it("builds wire input with trimming and optional-field omission", () => {
    const d = draftFromTrigger(null);
    d.name = "  Orders  ";
    d.provider = "bigquery";
    d.query = " SELECT 1 ";
    d.cursorColumn = "id";
    d.profileKeyColumn = "email";
    d.connectionId = "   "; // whitespace-only → omitted
    const input = draftToInput(d);
    expect(input.name).toBe("Orders");
    expect(input.query).toBe("SELECT 1");
    expect(input.connection_id).toBeUndefined();
    expect(input.journey_id).toBeUndefined();
    expect(input.polling_interval_seconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(input.max_rows_per_tick).toBe(DEFAULT_MAX_ROWS_PER_TICK);
    expect(input.status).toBe("draft");
  });

  it("omits out-of-range numeric fields instead of sending garbage", () => {
    const d = draftFromTrigger(trigger());
    d.pollingIntervalSeconds = "abc";
    d.maxRowsPerTick = "-5";
    const input = draftToInput(d);
    expect(input.polling_interval_seconds).toBeUndefined();
    expect(input.max_rows_per_tick).toBeUndefined();
  });

  it("preserves description and opaque config on a full-replacement edit", () => {
    const config = {
      warehouse: { role: "reporting", labels: ["orders", "daily"] },
    };
    const input = draftToInput(
      draftFromTrigger(
        trigger({
          description: "  Finds newly paid orders  ",
          connection_id: CONNECTION_ID.toUpperCase(),
          journey_id: JOURNEY_ID.toUpperCase(),
          config,
        }),
      ),
    );

    expect(input).toMatchObject({
      description: "Finds newly paid orders",
      connection_id: CONNECTION_ID,
      journey_id: JOURNEY_ID,
      config,
    });
    expect(
      savedTriggerMatchesInput(
        trigger({
          name: input.name,
          description: input.description,
          status: input.status ?? "draft",
          provider: input.provider,
          query: input.query,
          cursor_column: input.cursor_column,
          profile_key_column: input.profile_key_column,
          polling_interval_seconds: input.polling_interval_seconds ?? 300,
          max_rows_per_tick: input.max_rows_per_tick ?? 500,
          connection_id: input.connection_id,
          journey_id: input.journey_id,
          config: {
            warehouse: { labels: ["orders", "daily"], role: "reporting" },
          },
        }),
        input,
      ),
    ).toBe(true);
    expect(
      savedTriggerMatchesInput(trigger({ ...input, name: "Wrong" }), input),
    ).toBe(false);
  });
});

describe("draftErrors", () => {
  it("flags every missing required field", () => {
    const e = draftErrors(draftFromTrigger(null));
    expect(Object.keys(e).sort()).toEqual([
      "cursorColumn",
      "name",
      "profileKeyColumn",
      "provider",
      "query",
    ]);
  });

  it("rejects a zero polling interval (Number('')||default would mask it)", () => {
    const d = draftFromTrigger(trigger());
    d.pollingIntervalSeconds = "0";
    expect(draftErrors(d).pollingIntervalSeconds).toBeTruthy();
  });

  it("passes a fully-populated draft", () => {
    expect(draftErrors(draftFromTrigger(trigger({ status: "draft" })))).toEqual(
      {},
    );
  });

  it("rejects legacy activation and values outside server bounds", () => {
    const d = draftFromTrigger(trigger());
    expect(draftErrors(d).status).toMatch(/Activation is unavailable/);
    d.status = "draft";
    d.pollingIntervalSeconds = "14";
    d.maxRowsPerTick = "1001";
    expect(draftErrors(d).pollingIntervalSeconds).toMatch(/15/);
    expect(draftErrors(d).maxRowsPerTick).toMatch(/1,000/);
  });

  it("requires optional connection and journey references to be UUIDs", () => {
    const d = draftFromTrigger(trigger({ status: "draft" }));
    d.connectionId = "conn_9";
    d.journeyId = "jrn_2";
    expect(draftErrors(d)).toMatchObject({
      connectionId: "Connection ID must be a canonical UUID",
      journeyId: "Journey ID must be a canonical UUID",
    });

    d.connectionId = CONNECTION_ID;
    d.journeyId = JOURNEY_ID;
    expect(draftErrors(d)).toEqual({});
  });
});

describe("canValidate", () => {
  it("requires the four substantive fields, not the name", () => {
    const d = draftFromTrigger(trigger({ name: "" }));
    expect(canValidate(d)).toBe(true);
    d.query = "";
    expect(canValidate(d)).toBe(false);
  });
});

describe("extractValidationResult (400-body recovery)", () => {
  it("parses a validation-result error body", () => {
    const r = extractValidationResult(
      '{"valid":false,"errors":["query must reference :cursor"],"warnings":["no LIMIT clause"]}',
    );
    expect(r).toEqual({
      valid: false,
      errors: ["query must reference :cursor"],
      warnings: ["no LIMIT clause"],
    });
  });

  it("returns null for plain-text messages", () => {
    expect(extractValidationResult("forbidden")).toBeNull();
    expect(extractValidationResult(undefined)).toBeNull();
    expect(extractValidationResult("")).toBeNull();
  });

  it("returns null for truncated JSON (the client slices at 200 chars)", () => {
    expect(
      extractValidationResult('{"valid":false,"errors":["a", "b'),
    ).toBeNull();
  });

  it("returns null for JSON that isn't a validation result", () => {
    expect(extractValidationResult('{"error":"nope"}')).toBeNull();
  });

  it("rejects non-string entries instead of rendering [object Object]", () => {
    const r = extractValidationResult(
      '{"valid":true,"warnings":["ok",42,{"x":1}]}',
    );
    expect(r).toBeNull();
  });
});

describe("normalizeValidationResult (successful response)", () => {
  it("accepts bounded string arrays and rejects malformed message collections", () => {
    expect(
      normalizeValidationResult({
        valid: true,
        errors: [],
        warnings: [" Review cursor ordering "],
      }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: ["Review cursor ordering"],
    });
    expect(
      normalizeValidationResult({ valid: true, warnings: { message: "bad" } }),
    ).toBeNull();
    expect(
      normalizeValidationResult({ valid: false, errors: ["valid", 42] }),
    ).toBeNull();
  });

  it("rejects contradictory validity and error evidence", () => {
    expect(
      normalizeValidationResult({ valid: true, errors: ["query rejected"] }),
    ).toBeNull();
    expect(normalizeValidationResult({ valid: false, errors: [] })).toBeNull();
    expect(normalizeValidationResult({ valid: false })).toBeNull();
  });
});

describe("triggerHealth", () => {
  it("active + no failures → success", () => {
    expect(triggerHealth(trigger())).toEqual({
      tone: "success",
      label: "active",
      detail: "",
    });
  });

  it("active + failures → failing, escalating to danger at 3", () => {
    expect(
      triggerHealth(trigger({ consecutive_failures: 1, last_error: "boom" })),
    ).toEqual({ tone: "warning", label: "failing ×1", detail: "boom" });
    expect(triggerHealth(trigger({ consecutive_failures: 3 })).tone).toBe(
      "danger",
    );
  });

  it("non-active status wins over failure count", () => {
    const h = triggerHealth(
      trigger({ status: "paused", consecutive_failures: 9 }),
    );
    expect(h).toEqual({ tone: "neutral", label: "paused", detail: "" });
  });
});

describe("display helpers", () => {
  it("fmtDuration composes h/m/s and handles edge cases", () => {
    expect(fmtDuration(0)).toBe("0s");
    expect(fmtDuration(90)).toBe("1m 30s");
    expect(fmtDuration(300)).toBe("5m");
    expect(fmtDuration(3600)).toBe("1h");
    expect(fmtDuration(3661)).toBe("1h 1m 1s");
    expect(fmtDuration(-1)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
  });

  it("fireStatusTone maps statuses case-insensitively", () => {
    expect(fireStatusTone("Fired")).toBe("neutral");
    expect(fireStatusTone("delivered")).toBe("success");
    expect(fireStatusTone("FAILED")).toBe("danger");
    expect(fireStatusTone("pending")).toBe("warning");
    expect(fireStatusTone("weird")).toBe("neutral");
  });

  it("masks operational identifiers instead of exposing complete values", () => {
    expect(maskOperationalIdentifier("customer@example.test")).toBe("••••test");
    expect(maskOperationalIdentifier("abc")).toBe("••••");
    expect(maskOperationalIdentifier()).toBe("—");
  });
});

describe("normalizeTriggerDefinitions", () => {
  it("accepts stable, unique identities", () => {
    const result = normalizeTriggerDefinitions([
      trigger({ id: " trigger-1 ", name: " Orders " }),
      trigger({ id: "trigger-2", name: "Customers" }),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((item) => item.id)).toEqual([
        "trigger-1",
        "trigger-2",
      ]);
    }
  });

  it("fails closed for missing or duplicate identities", () => {
    expect(normalizeTriggerDefinitions([trigger({ id: "" })]).ok).toBe(false);
    expect(
      normalizeTriggerDefinitions([
        trigger({ id: "duplicate" }),
        trigger({ id: "duplicate", name: "Other" }),
      ]).ok,
    ).toBe(false);
    expect(normalizeTriggerDefinitions(undefined).ok).toBe(false);
  });
});
