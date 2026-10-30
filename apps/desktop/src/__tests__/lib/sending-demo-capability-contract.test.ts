import { describe, expect, it } from "vitest";

import { capabilityForSection } from "../../lib/desktop-capabilities";
import { demoDataForRequest } from "../../lib/demo-data";
import fs from "node:fs";
import path from "node:path";

const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000099";

describe("sending demo and capability contract", () => {
  it("returns aligned scalar fixtures before the generic demo fallback", () => {
    const settings = demoDataForRequest("/api/v1/settings/sending") as {
      tenant_id: string;
      max_sends_per_hour: number;
      quiet_hours_start: string;
      quiet_hours_end: string;
      quiet_hours_tz: string;
      quiet_hours_per_recipient: boolean;
      ip_pool: { name: string; dedicated: boolean };
      updated_at: string;
    };
    const status = demoDataForRequest("/api/v1/settings/sending/status") as {
      tenant_id: string;
      max_sends_per_hour: number;
      quiet_hours_start: string;
      quiet_hours_end: string;
      quiet_hours_tz: string;
      quiet_hours_per_recipient: boolean;
      bucket_count: number;
      window_start: string;
      window_resets_at: string;
      in_quiet_hours: boolean;
      quiet_changes_at: string;
      counter_authoritative: boolean;
      counter_source: string;
      counter_scope: string;
      cap_coordination_state: string;
      cap_coordination_ready: boolean;
      cap_coordination_cap: number;
      cap_coordination_matches_settings: boolean;
      cap_coordination_fence_started_at: string | null;
    };

    expect(settings).toEqual({
      tenant_id: DEMO_TENANT_ID,
      max_sends_per_hour: 5_000,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      ip_pool: { name: "shared", dedicated: false },
      updated_at: "2026-08-18T10:30:00.000Z",
    });
    expect(status).toMatchObject({
      tenant_id: settings.tenant_id,
      max_sends_per_hour: settings.max_sends_per_hour,
      quiet_hours_start: settings.quiet_hours_start,
      quiet_hours_end: settings.quiet_hours_end,
      quiet_hours_tz: settings.quiet_hours_tz,
      quiet_hours_per_recipient: settings.quiet_hours_per_recipient,
      bucket_count: 1_250,
      in_quiet_hours: true,
      counter_authoritative: true,
      counter_source: "demo_fixture",
      counter_scope: "shared",
      cap_coordination_state: "ready",
      cap_coordination_ready: true,
      cap_coordination_cap: settings.max_sends_per_hour,
      cap_coordination_matches_settings: true,
      cap_coordination_fence_started_at: null,
    });
    expect(status.bucket_count).toBeLessThan(status.max_sends_per_hour);
    expect(
      Date.parse(status.window_resets_at) - Date.parse(status.window_start),
    ).toBe(60 * 60 * 1_000);
    expect(status.quiet_changes_at).toBe(status.window_resets_at);
  });

  it("classifies sending as an admin-owned settings capability", () => {
    expect(capabilityForSection("sending")).toEqual({
      id: "settings.sending",
      domain: "settings",
      readiness: "operational",
      offline: "online-required",
      entryRole: "admin",
      recoverySection: "settings",
    });
  });

  it("checks local demo GET fixtures before returning the offline preflight", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/api-client.ts"),
      "utf8",
    );
    const offlineBranch = source.slice(
      source.indexOf("if (requestIsOffline()"),
      source.indexOf("// Flush triggers live"),
    );
    expect(
      offlineBranch.indexOf("demoReadFallback<T>(path, method)"),
    ).toBeGreaterThan(-1);
    expect(
      offlineBranch.indexOf("demoReadFallback<T>(path, method)"),
    ).toBeLessThan(offlineBranch.indexOf("resolveOfflineRequest<T>"));
  });
});
