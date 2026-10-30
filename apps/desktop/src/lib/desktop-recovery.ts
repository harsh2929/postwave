/** Lazily loaded user actions and support-report composition for diagnostics. */

import { writeClipboardText } from "./clipboard";
import { LEGAL_URLS } from "./config";
import {
  buildContextualHelpSnapshot,
  buildContextualSupportUrl,
  type ContextualHelpRequest,
} from "./contextual-help";
import { getDashboardUrl } from "./dashboard-url";
import {
  clearDesktopSafeMode,
  getDesktopDiagnosticsState,
  getRendererDiagnosticLines,
  requestDesktopSafeMode,
  type DesktopIncident,
} from "./desktop-diagnostics";
import { getDesktopRoute } from "./desktop-router";
import { getConnectivitySnapshot } from "./online-manager";
import { isTauri, tauriApi, type NativeCrashRecord } from "./tauri";

const MAX_REPORT_CHARS = 48 * 1024;

export async function restartDesktopApp(): Promise<void> {
  if (isTauri()) {
    await tauriApi.restartApp();
    return;
  }
  window.location.reload();
}

export async function restartDesktopInSafeMode(): Promise<void> {
  requestDesktopSafeMode();
  await restartDesktopApp();
}

export async function restartDesktopNormally(): Promise<void> {
  clearDesktopSafeMode();
  await restartDesktopApp();
}

export async function openDesktopWebApp(): Promise<void> {
  await tauriApi.openUrl(getDashboardUrl());
}

export async function openDesktopSupport(
  request: ContextualHelpRequest = { task: "recovery" },
): Promise<void> {
  const snapshot = buildContextualHelpSnapshot({
    section: getDesktopRoute().section,
    connectivity: getConnectivitySnapshot().reason,
    request,
  });
  const url = buildContextualSupportUrl(LEGAL_URLS.support, snapshot);
  if (!url) throw new Error("support_url_invalid");
  await tauriApi.openUrl(url);
}

export async function copyDesktopDiagnostics(
  preferredIncident?: DesktopIncident | NativeCrashRecord | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const report = await buildDesktopDiagnosticsReport(preferredIncident);
  const result = await writeClipboardText(report, {
    contentClass: "personal",
    label: "Moosewave diagnostics",
  });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/** Build a bounded, structural support report. No secrets enter this string. */
export async function buildDesktopDiagnosticsReport(
  preferredIncident?: DesktopIncident | NativeCrashRecord | null,
): Promise<string> {
  const [version, platform, nativeLog] = await Promise.all([
    tauriApi.getAppVersion().catch(() => null),
    tauriApi.getPlatform().catch(() => "unknown" as const),
    tauriApi.readDesktopDiagnostics().catch(() => ""),
  ]);
  const state = getDesktopDiagnosticsState();
  const current = preferredIncident ?? state.nativeCrash;
  const lines = [
    "Moosewave Desktop diagnostics (structural; no message, payload, identity, or credential data)",
    `Generated: ${new Date().toISOString()}`,
    `Incident: ${current?.incidentId ?? "not available"}`,
    `Version: ${version?.version ?? "unknown"}`,
    `Commit: ${version?.commit ?? "unknown"}`,
    `Platform: ${platform}`,
    `Runtime: ${isTauri() ? "native" : "web fallback"}`,
    `Safe mode: ${state.safeMode ? `yes (${state.safeModeReason ?? "unknown"})` : "no"}`,
    "",
    "Renderer events:",
    ...getRendererDiagnosticLines(),
  ];
  if (nativeLog.trim()) {
    lines.push("", "Native events:", nativeLog.trim());
  }
  const report = lines.join("\n");
  if (report.length <= MAX_REPORT_CHARS) return report;
  const header = lines.slice(0, 10).join("\n");
  const remaining = Math.max(0, MAX_REPORT_CHARS - header.length - 64);
  return `${header}\n\n[older events omitted]\n${report.slice(-remaining)}`;
}
