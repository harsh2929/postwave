/**
 * lib/diagnosticsReport.ts — the support report, as pure data → text.
 *
 * Desktop has had `copyDesktopDiagnostics` (apps/desktop/src/lib/desktop-recovery.ts)
 * since its recovery work; mobile had nothing (NATIVE#7). Every identifier a
 * support agent needs to triage "my notifications stopped" already existed in
 * memory on the phone — build profile, release, push registration state, the
 * pending-revocation journal, the offline mutation queue, the realtime stream's
 * health — and none of it was reachable from any screen.
 *
 * PRIVACY POSTURE, matching desktop's: the report is STRUCTURAL. It carries no
 * message content, no subscriber data, no credentials, and no personal
 * identity — no email address, no display name, no push token, no API key. The
 * push token appears only as its last 8 characters, which is enough for a
 * support agent to match a server row and useless for sending a notification.
 * The workspace id and API origin ARE included: they are what makes a report
 * actionable, and both are already user-visible on the More screen.
 *
 * Kept free of react-native/expo imports so the redaction rules are unit
 * tested in the node vitest environment — the screen supplies the values.
 */

export interface DiagnosticsSnapshot {
  generatedAt: number;
  buildProfile: string;
  release: string | null;
  appVersion: string | null;
  platform: string;
  osVersion: string | null;
  /**
   * Locale every formatter is running under, as
   * `lib/localization.formatLocaleSummary()` renders it. Structural, not
   * personal: a BCP-47 tag names a language and a region, not a person.
   */
  formatLocale: string;
  /** "ltr" | "rtl" — reported so RTL demand is measurable before it is built. */
  textDirection: string;
  /** API origin only — never a full URL with a path or query. */
  apiOrigin: string | null;
  tenantId: string | null;
  authMode: string;
  role: string | null;
  /** Whether the OS currently grants notification permission. */
  pushPermission: boolean | null;
  /** Raw Expo push token; redacted before it reaches the report. */
  pushToken: string | null;
  /** Origins with an un-acknowledged push revocation still queued. */
  pendingRevocationOrigins: readonly string[];
  eventBus: {
    status: string;
    lastEventAt: number | null;
    stalls: number;
    pauses: number;
    replayCursor: number | null;
  };
  offlineQueue: {
    queued: number;
    syncing: number;
    failed: number;
    sent: number;
  };
  persistence: {
    evictions: number;
    overflows: number;
    lastReason: string | null;
  };
}

const MAX_REPORT_CHARS = 8 * 1024;
const MAX_ORIGINS = 5;

/**
 * Last 8 characters only. Mirrors `redactToken` in
 * components/settings/SettingsScreenPrimitives.tsx so the diagnostics screen
 * and the Settings row show a person the SAME string — a support agent reading
 * one and a user reading the other must be able to agree they match.
 */
export function redactPushToken(token: string | null): string {
  if (!token) return "not registered";
  const suffix = token.slice(-8);
  return suffix ? `…${suffix}` : "registered";
}

/**
 * Reduce an origin to scheme + host. A base URL that somehow carried a path,
 * query or credentials must not be echoed into a report the user will paste
 * into a support thread.
 */
export function safeOrigin(value: string | null): string {
  if (!value) return "not set";
  try {
    const url = new URL(value);
    if (url.username || url.password) return `${url.protocol}//${url.host}`;
    return url.origin;
  } catch {
    return "invalid";
  }
}

function timestamp(value: number | null): string {
  if (!value || !Number.isFinite(value)) return "never";
  return new Date(value).toISOString();
}

/**
 * The human-facing rows, in the order the screen renders them. Returned as
 * pairs so the screen and the copied text cannot drift into showing different
 * things — the single most common failure mode of a "copy diagnostics" button.
 */
export function diagnosticsRows(
  snapshot: DiagnosticsSnapshot,
): { label: string; value: string }[] {
  const { eventBus, offlineQueue, persistence } = snapshot;
  const origins = snapshot.pendingRevocationOrigins
    .slice(0, MAX_ORIGINS)
    .map(safeOrigin);
  return [
    { label: "Generated", value: timestamp(snapshot.generatedAt) },
    { label: "Build profile", value: snapshot.buildProfile },
    { label: "App version", value: snapshot.appVersion ?? "unknown" },
    { label: "Release", value: snapshot.release ?? "not stamped" },
    {
      label: "Platform",
      value: snapshot.osVersion
        ? `${snapshot.platform} ${snapshot.osVersion}`
        : snapshot.platform,
    },
    {
      label: "Locale",
      value:
        snapshot.textDirection === "rtl"
          ? `${snapshot.formatLocale} (rtl)`
          : snapshot.formatLocale,
    },
    { label: "API origin", value: safeOrigin(snapshot.apiOrigin) },
    { label: "Workspace id", value: snapshot.tenantId ?? "not signed in" },
    {
      label: "Auth mode",
      value: snapshot.role
        ? `${snapshot.authMode} (${snapshot.role})`
        : snapshot.authMode,
    },
    {
      label: "Push permission",
      value:
        snapshot.pushPermission === null
          ? "unknown"
          : snapshot.pushPermission
            ? "granted"
            : "denied or not asked",
    },
    { label: "Push token", value: redactPushToken(snapshot.pushToken) },
    {
      label: "Pending revocations",
      value: origins.length === 0 ? "none" : origins.join(", "),
    },
    { label: "Live stream", value: eventBus.status },
    { label: "Last live event", value: timestamp(eventBus.lastEventAt) },
    {
      label: "Stream stalls / pauses",
      value: `${eventBus.stalls} / ${eventBus.pauses}`,
    },
    {
      label: "Replay cursor",
      value:
        eventBus.replayCursor === null ? "none" : String(eventBus.replayCursor),
    },
    {
      label: "Unsent changes",
      value: `${offlineQueue.queued} queued · ${offlineQueue.syncing} syncing · ${offlineQueue.failed} failed · ${offlineQueue.sent} sent`,
    },
    {
      label: "Cache evictions / overflows",
      value: `${persistence.evictions} / ${persistence.overflows}${
        persistence.lastReason ? ` (${persistence.lastReason})` : ""
      }`,
    },
  ];
}

/**
 * The shareable text. Bounded so a pathological value can never produce a
 * string the share sheet refuses (or that a user pastes into a ticket by
 * accident at length).
 */
export function buildDiagnosticsReport(snapshot: DiagnosticsSnapshot): string {
  const body = [
    "Moosewave mobile diagnostics (structural; no message, subscriber, or credential data)",
    ...diagnosticsRows(snapshot).map((row) => `${row.label}: ${row.value}`),
  ].join("\n");
  return body.length <= MAX_REPORT_CHARS
    ? body
    : `${body.slice(0, MAX_REPORT_CHARS - 20)}\n[truncated]`;
}
