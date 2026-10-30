import { describe, expect, it } from "vitest";

import type { PushSuppressionRow } from "../../lib/api/push-suppressions";
import {
  buildPushSuppressionCsv,
  filterRowsBySource,
  isFailClosedListError,
  lockedReasonLabel,
  parsePushSuppressionImportCsv,
  rowCanBeRemoved,
  validateFingerprintPrefix,
  validateRawPushToken,
} from "../../pages/push-suppression-model";

const manual: PushSuppressionRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "00000000-0000-0000-0000-000000000043",
  device_token_hash: "0123456789abcdef",
  platform: "apns",
  reason: "manual",
  source: "dashboard",
  created_at: "2026-08-28T10:00:00Z",
  updated_at: "2026-08-28T10:00:00Z",
  version: 1,
  reversible: true,
};

const locked: PushSuppressionRow = {
  ...manual,
  id: "22222222-2222-4222-8222-222222222222",
  device_token_hash: "1111222233334444",
  platform: "fcm",
  reason: "unregistered",
  source: "provider",
  reversible: false,
  locked_reason: "provider_authority",
};

describe("push suppression route model", () => {
  it("accepts only bounded lowercase fingerprint-prefix searches", () => {
    expect(validateFingerprintPrefix("")).toBeNull();
    expect(validateFingerprintPrefix("01234567")).toBeNull();
    expect(validateFingerprintPrefix("0123456789abcdef")).toBeNull();
    expect(validateFingerprintPrefix("0123456")).toContain("8–16");
    expect(validateFingerprintPrefix("0123456A")).toContain("lowercase");
    expect(validateFingerprintPrefix("0123456789abcdef0")).toContain("8–16");
  });

  it("preserves exact token bytes and applies platform-specific validation", () => {
    expect(validateRawPushToken("a".repeat(64), "apns")).toBeNull();
    expect(validateRawPushToken("a".repeat(63), "apns")).toContain("64");
    expect(validateRawPushToken(`${"a".repeat(64)} `, "apns")).toContain(
      "whitespace",
    );
    expect(validateRawPushToken(`fcm${"x".repeat(30)}`, "fcm")).toBeNull();
    expect(validateRawPushToken(`fcm\u202e${"x".repeat(30)}`, "fcm")).toContain(
      "direction-changing",
    );
  });

  it("derives removability from exact authority facts", () => {
    expect(rowCanBeRemoved(manual)).toBe(true);
    expect(rowCanBeRemoved(locked)).toBe(false);
    expect(rowCanBeRemoved({ ...manual, reversible: false })).toBe(false);
    expect(rowCanBeRemoved({ ...manual, source: "legacy" })).toBe(false);
    expect(lockedReasonLabel("provider_authority")).toBe("Provider authority");
  });

  it("parses a bounded manual CSV without normalizing token bytes", () => {
    const apnsToken = "a".repeat(64);
    const fcmToken = `fcm-${"x".repeat(24)}`;
    const parsed = parsePushSuppressionImportCsv(
      `\uFEFFplatform,device_token\r\napns,${apnsToken}\r\nfcm,${fcmToken}\r\n`,
    );

    expect(parsed).toEqual({
      ok: true,
      items: [
        { device_token: apnsToken, platform: "apns", reason: "manual" },
        { device_token: fcmToken, platform: "fcm", reason: "manual" },
      ],
      platformCounts: { apns: 1, fcm: 1, web: 0 },
    });
  });

  it("rejects ambiguous, duplicate, malformed, and oversized CSV input", () => {
    const apnsToken = "a".repeat(64);
    expect(
      parsePushSuppressionImportCsv(`device_token,platform\n${apnsToken},apns`),
    ).toMatchObject({ ok: false, message: expect.stringContaining("header") });
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\napns,${apnsToken}\napns,${apnsToken}`,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("repeats") });
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\nfcm,"${"x".repeat(24)}"trailing`,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("Row 2") });
    expect(
      parsePushSuppressionImportCsv(
        `platform,device_token\n${Array.from(
          { length: 101 },
          (_, index) => `fcm,token-${index}-${"x".repeat(20)}`,
        ).join("\n")}`,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining("1–100") });
  });

  it("exports only returned fingerprints and reviewed metadata", () => {
    const csv = buildPushSuppressionCsv([manual, locked]);
    expect(csv).toContain("fingerprint,platform,reason,source");
    expect(csv).toContain(manual.device_token_hash);
    expect(csv).not.toContain("device_token,");
    expect(filterRowsBySource([manual, locked], "provider")).toEqual([locked]);
  });

  it("fails closed for missing, malformed, and retired-identity responses", () => {
    expect(isFailClosedListError({ status: 404 })).toBe(true);
    expect(
      isFailClosedListError({ code: "invalid_push_suppression_response" }),
    ).toBe(true);
    expect(isFailClosedListError({ code: "identity_changed" })).toBe(true);
    expect(isFailClosedListError({ status: 503 })).toBe(false);
  });
});
