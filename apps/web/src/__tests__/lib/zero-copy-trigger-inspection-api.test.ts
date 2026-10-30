// SPDX-License-Identifier: AGPL-3.0-only
//
// The three read-only inspection GETs behind the trigger inspect dialog. Each
// assertion is about a consequence: the exact path and options the transport
// receives, the fields that survive decoding (and, more importantly, the raw
// warehouse values that must NOT), and the server sentence a 503 carries.

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMocks,
}));

import { ApiError } from "@/lib/api";
import {
  AutomationConfigurationContractError,
  AutomationConfigurationInputError,
  getZeroCopyAlerts,
  listZeroCopyDLQ,
  listZeroCopyFires,
} from "@/lib/automation-configuration-api";

const TRIGGER_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_TRIGGER_ID = "00000000-0000-4000-8000-000000000099";
const RAW_VALUES = /private-cursor|person@example\.test|sub_1|run_1|boom|hooks\.example/;

const runtime = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Execution is release-held.",
  prerequisites: ["release_certification"],
};

const decodedRuntime = {
  capability: "zero_copy_trigger_execution",
  runtimeStatus: "unavailable",
  executionEnabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Execution is release-held.",
  prerequisites: ["release_certification"],
};

function fireRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    trigger_id: TRIGGER_ID,
    status: "queued",
    fired_at: "2026-09-01T10:00:00Z",
    has_cursor: true,
    has_profile_key: true,
    has_subscriber: false,
    has_payload: true,
    has_flow_run: false,
    ...overrides,
  };
}

function dlqRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    trigger_id: TRIGGER_ID,
    reason: "unresolved_subscriber",
    retry_count: 2,
    status: "pending",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:05:00Z",
    has_cursor: true,
    has_profile_key: true,
    has_payload: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("zero-copy trigger inspection contracts", () => {
  it("lists enqueue records by trigger path and keeps only presence flags", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({
      items: [
        fireRow({
          // A widened server response must not reach the cache: only the
          // presence flags below survive.
          cursor_value: "private-cursor",
          profile_key: "person@example.test",
          subscriber_id: "sub_1",
          payload: { email: "person@example.test" },
          flow_run_id: "run_1",
          error: "boom: person@example.test",
          error_category: "execution_error",
        }),
      ],
    });

    const result = await listZeroCopyFires(TRIGGER_ID.toUpperCase(), signal);

    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/zero-copy-triggers/${TRIGGER_ID}/fires`,
      { signal },
    );
    expect(result).toEqual([
      {
        id: 41,
        triggerId: TRIGGER_ID,
        status: "queued",
        firedAt: "2026-09-01T10:00:00Z",
        hasCursor: true,
        hasProfileKey: true,
        hasSubscriber: false,
        hasPayload: true,
        hasFlowRun: false,
        errorCategory: "execution_error",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(RAW_VALUES);
  });

  it("refuses records for another definition, duplicates, and an invalid identity", async () => {
    apiMocks.get.mockResolvedValueOnce({
      items: [fireRow({ trigger_id: OTHER_TRIGGER_ID })],
    });
    await expect(listZeroCopyFires(TRIGGER_ID)).rejects.toThrow(
      /another definition/i,
    );

    apiMocks.get.mockResolvedValueOnce({ items: [fireRow(), fireRow()] });
    await expect(listZeroCopyFires(TRIGGER_ID)).rejects.toThrow(/duplicate/i);

    await expect(listZeroCopyFires("not-a-uuid")).rejects.toBeInstanceOf(
      AutomationConfigurationInputError,
    );
    expect(apiMocks.get).toHaveBeenCalledTimes(2);
  });

  it("reads alert thresholds, treats Go zero time as never, and hides the webhook and message", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({
      trigger_id: TRIGGER_ID,
      runtime,
      consecutive_failures_threshold: 5,
      lag_seconds_threshold: 900,
      fires_per_tick_threshold: 0,
      webhook_configured: true,
      notify_webhook_url: "https://hooks.example/secret",
      cooldown_seconds: 1800,
      last_alert_fired_at: "2026-09-02T08:00:00Z",
      last_alert_kind: "lag",
      has_last_alert_message: true,
      last_alert_message: "boom: person@example.test",
      // Go's time.Time is a struct: omitempty never omits it, so the default
      // config arrives with the zero time. That is "never", not a date.
      created_at: "0001-01-01T00:00:00Z",
      updated_at: "0001-01-01T00:00:00Z",
    });

    const config = await getZeroCopyAlerts(TRIGGER_ID, signal);

    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/zero-copy-triggers/${TRIGGER_ID}/alerts`,
      { signal },
    );
    expect(config).toEqual({
      triggerId: TRIGGER_ID,
      runtime: decodedRuntime,
      consecutiveFailuresThreshold: 5,
      lagSecondsThreshold: 900,
      firesPerTickThreshold: 0,
      webhookConfigured: true,
      cooldownSeconds: 1800,
      lastAlertFiredAt: "2026-09-02T08:00:00Z",
      lastAlertKind: "lag",
      hasLastAlertMessage: true,
    });
    expect(JSON.stringify(config)).not.toMatch(RAW_VALUES);
  });

  it("passes the server's 503 through unchanged so its sentence can be rendered", async () => {
    const disabled = new ApiError("alert repo not wired", 503, undefined, {
      code: "alerts_disabled",
    });
    apiMocks.get.mockRejectedValueOnce(disabled);
    await expect(getZeroCopyAlerts(TRIGGER_ID)).rejects.toBe(disabled);

    const dlqDisabled = new ApiError("dlq repo not wired", 503, undefined, {
      code: "dlq_disabled",
    });
    apiMocks.get.mockRejectedValueOnce(dlqDisabled);
    await expect(listZeroCopyDLQ(TRIGGER_ID)).rejects.toBe(dlqDisabled);
  });

  it("lists recovery entries by trigger path and rejects an unknown reason", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({
      items: [
        dlqRow({
          cursor_value: "private-cursor",
          profile_key: "person@example.test",
          payload: { email: "person@example.test" },
          last_error: "boom",
          last_error_category: "execution_error",
          last_retried_at: "2026-09-01T10:05:00Z",
        }),
      ],
    });

    const result = await listZeroCopyDLQ(TRIGGER_ID, signal);

    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/zero-copy-triggers/${TRIGGER_ID}/dlq`,
      { signal },
    );
    expect(result).toEqual([
      {
        id: 7,
        triggerId: TRIGGER_ID,
        reason: "unresolved_subscriber",
        retryCount: 2,
        status: "pending",
        createdAt: "2026-09-01T10:00:00Z",
        updatedAt: "2026-09-01T10:05:00Z",
        hasCursor: true,
        hasProfileKey: true,
        hasPayload: false,
        lastRetriedAt: "2026-09-01T10:05:00Z",
        lastErrorCategory: "execution_error",
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(RAW_VALUES);

    apiMocks.get.mockResolvedValueOnce({
      items: [dlqRow({ reason: "unknown_reason" })],
    });
    await expect(listZeroCopyDLQ(TRIGGER_ID)).rejects.toBeInstanceOf(
      AutomationConfigurationContractError,
    );
  });
});
