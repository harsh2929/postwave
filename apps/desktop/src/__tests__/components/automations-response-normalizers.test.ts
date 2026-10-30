import { describe, expect, it } from "vitest";

import {
  normalizeAlertConfig,
  normalizeDLQResponse,
  normalizeFireResponse,
  normalizeTriggerDefinition,
  normalizeTriggerDefinitions,
  normalizeTriggerDelayPreference,
} from "../../components/automations/response-normalizers";

const NOW = "2026-07-21T10:00:00.000Z";
const SUBSCRIBER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const JOURNEY_ID = "33333333-3333-4333-8333-333333333333";
const RUNTIME = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Zero-copy execution is unavailable.",
  prerequisites: ["durable_execution_receipts"],
};

function fire(id = 1) {
  return {
    id,
    trigger_id: "trigger-1",
    status: "fired",
    fired_at: NOW,
    has_cursor: true,
    has_profile_key: true,
    has_subscriber: true,
    has_payload: true,
    has_flow_run: false,
    error_category: "execution_error",
  };
}

function dlqRecord(id = 8) {
  return {
    id,
    trigger_id: "trigger-1",
    reason: "enqueue_failed",
    retry_count: 0,
    status: "pending",
    created_at: NOW,
    updated_at: NOW,
    has_cursor: true,
    has_profile_key: true,
    has_payload: true,
    last_error_category: "execution_error",
  };
}

function trigger(id = "trigger-1") {
  return {
    id,
    name: "Orders",
    status: "draft",
    provider: "snowflake",
    query: "SELECT email, created_at FROM orders WHERE created_at > :cursor",
    cursor_column: "created_at",
    profile_key_column: "email",
    polling_interval_seconds: 300,
    max_rows_per_tick: 500,
    consecutive_failures: 0,
    rows_fired_total: 1,
    last_polled_at: NOW,
    runtime: RUNTIME,
  };
}

describe("Automations response normalizers", () => {
  it("accepts stable trigger identities and strips sensitive operational detail", () => {
    const result = normalizeTriggerDefinitions([
      {
        ...trigger(),
        last_seen_cursor: "customer@example.test",
        last_error: "provider leaked customer@example.test and secret=abc",
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.last_seen_cursor).toBe("test");
    expect(result.value[0]?.last_error).toBe("recorded");
    expect(JSON.stringify(result.value)).not.toContain("customer@example.test");
    expect(JSON.stringify(result.value)).not.toContain("secret=abc");
  });

  it("preserves bounded description, config, references, and runtime metadata", () => {
    const result = normalizeTriggerDefinition({
      ...trigger(),
      description: "  Finds new orders  ",
      connection_id: CONNECTION_ID.toUpperCase(),
      journey_id: JOURNEY_ID.toUpperCase(),
      config: { warehouse: { role: "reporting", labels: ["orders"] } },
      runtime: RUNTIME,
      created_at: NOW,
      updated_at: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      description: "Finds new orders",
      connection_id: CONNECTION_ID,
      journey_id: JOURNEY_ID,
      config: { warehouse: { role: "reporting", labels: ["orders"] } },
      runtime: RUNTIME,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("rejects non-UUID references and unsafe or oversized opaque config", () => {
    expect(
      normalizeTriggerDefinition({ ...trigger(), connection_id: "conn_9" }).ok,
    ).toBe(false);
    expect(
      normalizeTriggerDefinition({
        ...trigger(),
        config: JSON.parse('{"__proto__":{"polluted":true}}'),
      }).ok,
    ).toBe(false);
    expect(
      normalizeTriggerDefinition({
        ...trigger(),
        config: { query_hint: "x".repeat(1_048_577) },
      }).ok,
    ).toBe(false);
  });

  it("rejects duplicate triggers, invalid counters, and hostile timestamps", () => {
    expect(normalizeTriggerDefinitions([trigger(), trigger()]).ok).toBe(false);
    expect(
      normalizeTriggerDefinitions([{ ...trigger(), rows_fired_total: -1 }]).ok,
    ).toBe(false);
    expect(
      normalizeTriggerDefinitions([
        { ...trigger(), last_polled_at: "customer@example.test" },
      ]).ok,
    ).toBe(false);
    expect(
      normalizeTriggerDefinitions([{ ...trigger(), runtime: undefined }]).ok,
    ).toBe(false);
    expect(
      normalizeTriggerDefinitions([
        {
          ...trigger(),
          runtime: { ...RUNTIME, execution_enabled: true },
        },
      ]).ok,
    ).toBe(false);
  });

  it("normalizes enqueue and recovery rows without retaining payload or raw errors", () => {
    const fires = normalizeFireResponse({
      items: [
        {
          ...fire(),
          profile_key: "customer@example.test",
          cursor_value: "cursor-sensitive-1234",
          error: "secret provider diagnostic",
          payload: { email: "customer@example.test" },
        },
      ],
    });
    expect(fires.ok).toBe(true);
    if (fires.ok) {
      const serialized = JSON.stringify(fires.value);
      expect(fires.value.items[0]).toMatchObject({
        triggerId: "trigger-1",
        hasCursor: true,
        hasProfileKey: true,
        errorCategory: "execution_error",
      });
      expect(serialized).not.toContain("customer@example.test");
      expect(serialized).not.toContain("secret provider diagnostic");
      expect(serialized).not.toContain("payload");
    }

    const recovery = normalizeDLQResponse({
      items: [
        {
          ...dlqRecord(),
          legacy_reason_detail: "email customer@example.test rejected",
          last_error: "token=secret",
        },
      ],
    });
    expect(recovery.ok).toBe(true);
    if (recovery.ok) {
      const serialized = JSON.stringify(recovery.value);
      expect(recovery.value.items[0]).toMatchObject({
        reason: "enqueue_failed",
        hasPayload: true,
        lastErrorCategory: "execution_error",
      });
      expect(serialized).not.toContain("customer@example.test");
      expect(serialized).not.toContain("token=secret");
    }
  });

  it("rejects duplicate record ids and malformed numeric fields", () => {
    expect(normalizeFireResponse({ items: [fire(), fire()] }).ok).toBe(false);
    expect(
      normalizeDLQResponse({
        items: [{ ...dlqRecord(1), retry_count: Number.NaN }],
      }).ok,
    ).toBe(false);
    expect(
      normalizeDLQResponse({
        items: [{ ...dlqRecord(), reason: "raw detail" }],
      }).ok,
    ).toBe(false);
    expect(
      normalizeFireResponse(
        { items: [{ ...fire(), trigger_id: "trigger-2" }] },
        "trigger-1",
      ).ok,
    ).toBe(false);
  });

  it("hides alert destinations and binds timing responses to the requested pair", () => {
    const alert = normalizeAlertConfig({
      trigger_id: "trigger-1",
      runtime: RUNTIME,
      consecutive_failures_threshold: 3,
      lag_seconds_threshold: 300,
      fires_per_tick_threshold: 100,
      cooldown_seconds: 600,
      webhook_configured: true,
      has_last_alert_message: true,
      last_alert_kind: "failures",
      notify_webhook_url: "https://hooks.example.test/private-token",
    });
    expect(alert.ok).toBe(true);
    if (alert.ok) {
      expect(alert.value.webhookConfigured).toBe(true);
      expect(alert.value.hasLastAlertMessage).toBe(true);
      expect(JSON.stringify(alert.value)).not.toContain("private-token");
    }
    expect(
      normalizeAlertConfig({
        trigger_id: "trigger-1",
        runtime: {},
        consecutive_failures_threshold: 3,
        lag_seconds_threshold: 300,
        fires_per_tick_threshold: 100,
        cooldown_seconds: 600,
        webhook_configured: false,
        has_last_alert_message: false,
      }).ok,
    ).toBe(false);

    const preference = {
      subscriber_id: SUBSCRIBER_ID,
      event_name: "cart.abandoned",
      optimal_delay_seconds: 120,
      sample_count: 2,
      confidence: 0.5,
      computed_at: NOW,
      updated_at: NOW,
    };
    expect(
      normalizeTriggerDelayPreference(preference, {
        subscriberId: SUBSCRIBER_ID,
        eventName: "cart.abandoned",
      }).ok,
    ).toBe(true);
    expect(
      normalizeTriggerDelayPreference(preference, {
        subscriberId: "another-subscriber",
        eventName: "cart.abandoned",
      }).ok,
    ).toBe(false);
  });
});
