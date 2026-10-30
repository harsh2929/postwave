import { describe, expect, it } from "vitest";

import {
  MAX_SENDS_PER_HOUR,
  clearedSendingInput,
  formFromSendingSettings,
  parseSendingSettings,
  parseSendingStatus,
  sendingCapCoordinationProvesSettings,
  sendingFormIsDirty,
  sendingInputFromForm,
  sendingSettingsIsCanonicalNoRow,
  sendingStatusMatchesSettings,
  validateSendingForm,
  type VerifiedSendingSettings,
} from "../../pages/sending-settings-model";

const SETTINGS: VerifiedSendingSettings = {
  tenant_id: "tenant-1",
  max_sends_per_hour: 120,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "Asia/Kolkata",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: 16,
  ip_pool: { name: "Primary pool", dedicated: true },
  updated_at: "2026-08-30T06:00:00Z",
};

const STATUS = {
  tenant_id: "tenant-1",
  max_sends_per_hour: 120,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "Asia/Kolkata",
  quiet_hours_per_recipient: true,
  bucket_count: 14,
  window_start: "2026-08-30T06:00:00Z",
  window_resets_at: "2026-08-30T07:00:00Z",
  in_quiet_hours: false,
  quiet_changes_at: "2026-08-30T16:30:00Z",
  counter_authoritative: true,
  counter_source: "qualified_shared_limiter",
  counter_scope: "shared",
  cap_coordination_state: "ready",
  cap_coordination_ready: true,
  cap_coordination_cap: 120,
  cap_coordination_matches_settings: true,
  cap_coordination_fence_started_at: null,
};

describe("sending-settings model contract", () => {
  it("accepts a complete canonical settings row", () => {
    expect(parseSendingSettings(SETTINGS)).toEqual(SETTINGS);
  });

  it.each([
    ["blank tenant", { ...SETTINGS, tenant_id: "   " }],
    ["zero cap", { ...SETTINGS, max_sends_per_hour: 0 }],
    [
      "oversized cap",
      { ...SETTINGS, max_sends_per_hour: MAX_SENDS_PER_HOUR + 1 },
    ],
    ["partial quiet window", { ...SETTINGS, quiet_hours_end: "" }],
    ["non-HH:MM start", { ...SETTINGS, quiet_hours_start: "22:00:00" }],
    ["equal quiet bounds", { ...SETTINGS, quiet_hours_end: "22:00" }],
    ["invalid timezone", { ...SETTINGS, quiet_hours_tz: "Mars/Olympus" }],
    ["invalid fallback", { ...SETTINGS, fallback_hour_utc: 24 }],
    ["invalid timestamp", { ...SETTINGS, updated_at: "yesterday-ish" }],
    [
      "invalid IP projection",
      { ...SETTINGS, ip_pool: { name: " ", dedicated: true } },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseSendingSettings(value)).toBeNull();
  });

  it("validates the status evidence before qualifying live counters", () => {
    expect(parseSendingStatus(STATUS)).toMatchObject({
      bucket_count: 14,
      counter_authoritative: true,
      counter_scope: "shared",
    });
    expect(parseSendingStatus({ ...STATUS, bucket_count: -1 })).toBeNull();
    expect(
      parseSendingStatus({ ...STATUS, window_resets_at: "not-a-time" }),
    ).toBeNull();
    expect(
      parseSendingStatus({ ...STATUS, counter_scope: "process" }),
    ).toBeNull();
    expect(parseSendingStatus({ ...STATUS, counter_source: "   " })).toBeNull();
    expect(parseSendingStatus({ ...STATUS, bucket_count: null })).toBeNull();
    expect(
      parseSendingStatus({
        ...STATUS,
        counter_authoritative: false,
        counter_scope: "shared",
      }),
    ).toMatchObject({
      counter_authoritative: false,
      counter_scope: "unavailable",
    });
  });

  it("fails closed on malformed or contradictory shared-cap authority receipts", () => {
    expect(parseSendingStatus({ ...STATUS, tenant_id: "   " })).toBeNull();
    expect(
      parseSendingStatus({
        ...STATUS,
        cap_coordination_state: "eventually_ready",
      }),
    ).toBeNull();
    expect(
      parseSendingStatus({ ...STATUS, cap_coordination_ready: false }),
    ).toBeNull();
    expect(
      parseSendingStatus({ ...STATUS, cap_coordination_cap: 121 }),
    ).toBeNull();
    expect(
      parseSendingStatus({
        ...STATUS,
        cap_coordination_state: "conservatively_fenced",
        cap_coordination_ready: false,
        cap_coordination_matches_settings: false,
        cap_coordination_fence_started_at: "2026-08-30T06:05:00Z",
      }),
    ).toMatchObject({
      cap_coordination_state: "conservatively_fenced",
      cap_coordination_ready: false,
    });
    expect(
      parseSendingStatus({
        ...STATUS,
        cap_coordination_state: "unavailable",
        cap_coordination_ready: false,
        cap_coordination_cap: null,
        cap_coordination_matches_settings: false,
      }),
    ).toMatchObject({
      cap_coordination_state: "unavailable",
      cap_coordination_cap: null,
    });
  });

  it("rejects permissive dates and preserves only the exact canonical no-row proof", () => {
    expect(
      parseSendingSettings({ ...SETTINGS, updated_at: "2026-08-30" }),
    ).toBeNull();
    const noRowWire = {
      tenant_id: SETTINGS.tenant_id,
      quiet_hours_per_recipient: true,
      updated_at: "0001-01-01T00:00:00Z",
    };
    const noRow = parseSendingSettings(noRowWire);
    expect(noRow).toMatchObject({
      updated_at: null,
      canonical_no_row_revision: true,
    });
    expect(sendingSettingsIsCanonicalNoRow(noRow!)).toBe(true);
    expect(
      parseSendingSettings({
        ...noRowWire,
        ip_pool: { name: "Provisioned independently", dedicated: true },
      })?.canonical_no_row_revision,
    ).toBe(true);
    for (const updated_at of [undefined, null, "", "0001-01-01T00:00:00.0Z"]) {
      expect(parseSendingSettings({ ...noRowWire, updated_at })).toBeNull();
    }
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "0001-01-01T00:00:00Z",
      }),
    ).toBeNull();
    for (const extra of [
      { fallback_hour_utc: null },
      { fallback_hour_utc: 16 },
      { updated_by_user_id: null },
      { updated_by_user_id: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(parseSendingSettings({ ...noRowWire, ...extra })).toBeNull();
    }
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "2026-02-30T00:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "2026-01-01T24:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "2026-01-01T00:00:00+14:01",
      }),
    ).toBeNull();
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "2026-01-01T00:00:00-23:59",
      }),
    ).toBeNull();
    expect(
      parseSendingSettings({
        ...SETTINGS,
        updated_at: "2026-01-01T00:00:00+14:00",
      })?.updated_at,
    ).toBe("2026-01-01T00:00:00+14:00");
  });

  it("uses status computations only when they describe the current policy", () => {
    const parsed = parseSendingStatus(STATUS);
    expect(parsed).not.toBeNull();
    expect(sendingStatusMatchesSettings(parsed!, SETTINGS)).toBe(true);
    expect(sendingCapCoordinationProvesSettings(parsed!, SETTINGS)).toBe(true);
    expect(
      sendingStatusMatchesSettings(parsed!, {
        ...SETTINGS,
        max_sends_per_hour: 180,
      }),
    ).toBe(false);
    expect(
      sendingCapCoordinationProvesSettings(
        { ...parsed!, cap_coordination_matches_settings: false },
        SETTINGS,
      ),
    ).toBe(false);
    expect(
      sendingStatusMatchesSettings(
        { ...parsed!, tenant_id: "tenant-2" },
        SETTINGS,
      ),
    ).toBe(false);
  });

  it("strictly validates editable caps and quiet-hour fields", () => {
    const base = formFromSendingSettings(SETTINGS);
    expect(validateSendingForm(base)).toEqual({});
    expect(validateSendingForm({ ...base, rateLimit: "1.5" })).toHaveProperty(
      "rateLimit",
    );
    expect(validateSendingForm({ ...base, rateLimit: "0" })).toHaveProperty(
      "rateLimit",
    );
    expect(
      validateSendingForm({
        ...base,
        rateLimit: String(MAX_SENDS_PER_HOUR + 1),
      }),
    ).toHaveProperty("rateLimit");
    expect(validateSendingForm({ ...base, start: "9:00" })).toHaveProperty(
      "start",
    );
    expect(validateSendingForm({ ...base, end: base.start })).toHaveProperty(
      "end",
    );
    expect(
      validateSendingForm({ ...base, timezone: "Invalid/Zone" }),
    ).toHaveProperty("timezone");
  });

  it("builds revision-checked save and clear payloads without the legacy fallback field", () => {
    const form = {
      ...formFromSendingSettings(SETTINGS),
      rateLimit: "240",
    };
    const save = sendingInputFromForm(form, SETTINGS.updated_at);
    const clear = clearedSendingInput(SETTINGS);

    expect(save).toEqual({
      max_sends_per_hour: 240,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "Asia/Kolkata",
      quiet_hours_per_recipient: true,
      expected_updated_at: SETTINGS.updated_at,
    });
    expect(clear).toEqual({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: SETTINGS.updated_at,
    });
    expect(save).not.toHaveProperty("fallback_hour_utc");
    expect(clear).not.toHaveProperty("fallback_hour_utc");
    expect(sendingFormIsDirty(form, SETTINGS)).toBe(true);
  });
});
