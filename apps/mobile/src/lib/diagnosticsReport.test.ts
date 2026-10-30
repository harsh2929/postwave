import { describe, expect, it } from "vitest";

import {
  buildDiagnosticsReport,
  diagnosticsRows,
  redactPushToken,
  safeOrigin,
  type DiagnosticsSnapshot,
} from "./diagnosticsReport";

const SNAPSHOT: DiagnosticsSnapshot = {
  generatedAt: Date.UTC(2026, 6, 25, 12, 0, 0),
  buildProfile: "production",
  release: "abc1234",
  appVersion: "1.4.0",
  platform: "ios",
  osVersion: "18.2",
  formatLocale: "en-GB",
  textDirection: "ltr",
  apiOrigin: "https://api.moosewave.com",
  tenantId: "11111111-2222-3333-4444-555555555555",
  authMode: "session",
  role: "admin",
  pushPermission: true,
  pushToken: "ExponentPushToken[SECRETVALUE1234abcd]",
  pendingRevocationOrigins: ["https://staging.moosewave.com/api"],
  eventBus: {
    status: "open",
    lastEventAt: Date.UTC(2026, 6, 25, 11, 59, 0),
    stalls: 2,
    pauses: 7,
    replayCursor: 4812,
  },
  offlineQueue: { queued: 3, syncing: 1, failed: 2, sent: 0 },
  persistence: { evictions: 1, overflows: 0, lastReason: "quota" },
};

describe("redactPushToken", () => {
  it("keeps only the last eight characters", () => {
    expect(redactPushToken("ExponentPushToken[abcdefgh1234]")).toBe("…fgh1234]");
  });

  it("distinguishes 'no token' from 'token present'", () => {
    expect(redactPushToken(null)).toBe("not registered");
    expect(redactPushToken("")).toBe("not registered");
  });
});

describe("safeOrigin", () => {
  it("reduces a URL to scheme and host", () => {
    expect(safeOrigin("https://api.moosewave.com/v1/things?x=1")).toBe(
      "https://api.moosewave.com",
    );
  });

  it("never echoes embedded credentials", () => {
    expect(safeOrigin("https://user:pass@api.moosewave.com/x")).toBe(
      "https://api.moosewave.com",
    );
  });

  it("reports unusable values instead of guessing", () => {
    expect(safeOrigin(null)).toBe("not set");
    expect(safeOrigin("not a url")).toBe("invalid");
  });
});

describe("buildDiagnosticsReport", () => {
  const report = buildDiagnosticsReport(SNAPSHOT);

  it("carries the identifiers support actually asks for", () => {
    expect(report).toContain("Build profile: production");
    expect(report).toContain("Release: abc1234");
    expect(report).toContain(
      "Workspace id: 11111111-2222-3333-4444-555555555555",
    );
    expect(report).toContain("API origin: https://api.moosewave.com");
    expect(report).toContain("Live stream: open");
    expect(report).toContain(
      "Unsent changes: 3 queued · 1 syncing · 2 failed · 0 sent",
    );
    expect(report).toContain("Stream stalls / pauses: 2 / 7");
  });

  it("never leaks the push token", () => {
    expect(report).not.toContain("SECRETVALUE1234abcd");
    expect(report).not.toContain("ExponentPushToken");
    expect(report).toContain("Push token: …234abcd]");
  });

  it("declares its own privacy posture in the first line", () => {
    expect(report.split("\n")[0]).toContain("structural");
  });

  it("is bounded even with absurd inputs", () => {
    const huge = buildDiagnosticsReport({
      ...SNAPSHOT,
      tenantId: "x".repeat(50_000),
    });
    expect(huge.length).toBeLessThanOrEqual(8 * 1024);
    expect(huge.endsWith("[truncated]")).toBe(true);
  });

  it("renders the same rows the screen renders", () => {
    // The classic 'copy diagnostics' bug is a report that disagrees with the
    // screen; both read this one list.
    for (const row of diagnosticsRows(SNAPSHOT)) {
      expect(report).toContain(`${row.label}: ${row.value}`);
    }
  });
});

describe("diagnosticsRows with an empty device", () => {
  const empty = diagnosticsRows({
    ...SNAPSHOT,
    release: null,
    appVersion: null,
    osVersion: null,
    apiOrigin: null,
    tenantId: null,
    role: null,
    pushPermission: null,
    pushToken: null,
    pendingRevocationOrigins: [],
    eventBus: {
      status: "idle",
      lastEventAt: null,
      stalls: 0,
      pauses: 0,
      replayCursor: null,
    },
    persistence: { evictions: 0, overflows: 0, lastReason: null },
  });
  const byLabel = new Map(empty.map((row) => [row.label, row.value]));

  it("says what is missing rather than rendering blanks", () => {
    expect(byLabel.get("Release")).toBe("not stamped");
    expect(byLabel.get("Workspace id")).toBe("not signed in");
    expect(byLabel.get("Push permission")).toBe("unknown");
    expect(byLabel.get("Pending revocations")).toBe("none");
    expect(byLabel.get("Last live event")).toBe("never");
    expect(byLabel.get("Replay cursor")).toBe("none");
  });

  it("leaves no row with an empty value", () => {
    for (const row of empty) expect(row.value.trim().length).toBeGreaterThan(0);
  });
});
