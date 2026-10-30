/**
 * api/firewallAdmin.ts — the signup firewall's admin surface, beyond the
 * one read api/platformConfig.ts carries and the one-field flip
 * api/reputationResponse.ts carries for the deliverability push.
 *
 *   PUT  /api/v1/firewall/settings   (admin)   partial, pointer semantics
 *   GET  /api/v1/firewall/events     (viewer)  ?limit=
 *   GET  /api/v1/firewall/stats      (viewer)
 *   POST /api/v1/firewall/detect     (admin)   → {flipped}
 *
 * All four are mounted ungated (firewall_attack_mode.go:561 MountRoutes) and
 * carry the roles above in routeauth/manifest.json. Shapes live in
 * lib/firewallAdmin.ts, read off the handlers.
 */
import { PlatformConfigError } from "./platformConfig";
import { rawRequest } from "./request";

import {
  normalizeDetectResult,
  normalizeFirewallEvents,
  normalizeFirewallStats,
  type FirewallEventView,
  type FirewallSettingsPatch,
  type FirewallStatsView,
} from "@/lib/firewallAdmin";
import {
  normalizeFirewallSettings,
  type FirewallSettingsView,
} from "@/lib/platformConfig";

function fail(error: { status: number; message: string }, fallback: string) {
  return new PlatformConfigError(error.status, error.message || fallback);
}

/** Partial PUT — only the fields present change. Answers the stored row. */
export async function putFirewallSettings(
  patch: FirewallSettingsPatch,
): Promise<FirewallSettingsView> {
  const res = await rawRequest<unknown>(
    "PUT",
    "/api/v1/firewall/settings",
    patch,
  );
  if (res.error) throw fail(res.error, "Couldn't save the firewall settings.");
  return normalizeFirewallSettings(res.data);
}

/** The most recent events, newest first. The server caps limit at 500. */
export async function getFirewallEvents(
  limit = 20,
): Promise<FirewallEventView[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/firewall/events?limit=${encodeURIComponent(String(limit))}`,
  );
  if (res.error) throw fail(res.error, "Couldn't load firewall events.");
  return normalizeFirewallEvents(res.data);
}

export async function getFirewallStats(): Promise<FirewallStatsView> {
  const res = await rawRequest<unknown>("GET", "/api/v1/firewall/stats");
  if (res.error) throw fail(res.error, "Couldn't load firewall counts.");
  return normalizeFirewallStats(res.data);
}

/** Run the surge sweep now. `flipped` is whether it just armed attack mode. */
export async function runFirewallDetect(): Promise<{ flipped: boolean }> {
  const res = await rawRequest<unknown>("POST", "/api/v1/firewall/detect", {});
  if (res.error) throw fail(res.error, "Couldn't run the surge check.");
  return { flipped: normalizeDetectResult(res.data) };
}
