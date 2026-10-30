import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AuditSinkReplayTab,
  formatAuditReplayAge,
  getAuditReplayProgress,
  getAuditReplayRange,
} from "../../components/audit/AuditSinkReplayTab";
import {
  AuditSinkCircuitBadge,
  AuditSinkTable,
  formatAuditSinkRelative,
} from "../../components/audit/AuditSinkTables";
import type { AuditSink, ReplayJob } from "../../lib/api-client";

describe("audit sink replay range", () => {
  it("computes inclusive ranges and preserves the reviewed 100,000-row boundary", () => {
    expect(getAuditReplayRange("10", "14")).toEqual({
      size: 5,
      tooLarge: false,
    });
    expect(getAuditReplayRange("1", "100000")).toEqual({
      size: 100_000,
      tooLarge: false,
    });
    expect(getAuditReplayRange("1", "100001")).toEqual({
      size: 100_001,
      tooLarge: true,
    });
  });

  it("rejects non-numeric and descending ranges without inventing progress", () => {
    expect(getAuditReplayRange("not-a-number", "2")).toEqual({
      size: 0,
      tooLarge: false,
    });
    expect(getAuditReplayRange("9", "2")).toEqual({ size: 0, tooLarge: false });
    expect(getAuditReplayRange("", "")).toEqual({ size: 0, tooLarge: false });
    expect(getAuditReplayRange("1.5", "2")).toEqual({
      size: 0,
      tooLarge: false,
    });
    expect(getAuditReplayRange("9007199254740992", "9007199254740992")).toEqual(
      { size: 0, tooLarge: false },
    );
  });
});

describe("audit sink replay presentation", () => {
  it("calculates inclusive job progress and caps over-reported completion", () => {
    expect(getAuditReplayProgress(job({ rows_sent: 3 }))).toEqual({
      total: 5,
      percent: 60,
    });
    expect(getAuditReplayProgress(job({ rows_sent: 8 }))).toEqual({
      total: 5,
      percent: 100,
    });
    expect(
      getAuditReplayProgress(job({ from_audit_id: 5, to_audit_id: 4 })),
    ).toEqual({ total: 0, percent: 0 });
  });

  it("formats invalid, minute, hour, and day ages deterministically", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(formatAuditReplayAge("", now)).toBe("—");
    expect(formatAuditReplayAge("invalid", now)).toBe("—");
    expect(formatAuditReplayAge("2026-07-15T11:59:45.000Z", now)).toBe(
      "just now",
    );
    expect(formatAuditReplayAge("2026-07-15T11:58:00.000Z", now)).toBe(
      "2m ago",
    );
    expect(formatAuditReplayAge("2026-07-15T10:00:00.000Z", now)).toBe(
      "2h ago",
    );
    expect(formatAuditReplayAge("2026-07-13T12:00:00.000Z", now)).toBe(
      "2d ago",
    );
  });

  it("renders the permission-gated replay form with accessible controls", () => {
    const html = renderToStaticMarkup(
      <AuditSinkReplayTab
        sinks={[sink({ enabled: false }), sink()]}
        canExecute={false}
      />,
    );

    expect(html).toContain("Replay audit rows to a sink");
    expect(html).toContain("From audit_log id");
    expect(html).toContain("To audit_log id");
    expect(html).toContain(
      "Restricted: audit:execute_actions permission is required",
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain(" title=");
    expect(html).toContain("Loading…");
  });
});

describe("audit sink table extraction", () => {
  it("preserves deterministic past, future, and invalid relative labels", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(formatAuditSinkRelative(undefined, now)).toBe("—");
    expect(formatAuditSinkRelative("invalid", now)).toBe("invalid");
    expect(formatAuditSinkRelative("2026-07-15T11:58:00.000Z", now)).toBe(
      "2m ago",
    );
    expect(formatAuditSinkRelative("2026-07-15T14:00:00.000Z", now)).toBe(
      "2h from now",
    );
  });

  it("renders the extracted sink table with semantic actions and health state", () => {
    const html = renderToStaticMarkup(
      <AuditSinkTable
        rows={[sink({ circuit_state: "open", consecutive_failures: 8 })]}
        loading={false}
        canAdmin
        onCreate={() => undefined}
        onOpen={() => undefined}
        onToggle={async () => undefined}
        onResetCircuit={async () => undefined}
      />,
    );

    expect(html).toContain("Enabled sink");
    expect(html).toContain("open");
    expect(html).toContain("Details");
    expect(html).toContain("Pause");
    expect(html).toContain("Reset breaker");
  });

  it("keeps circuit-state labels unambiguous", () => {
    expect(
      renderToStaticMarkup(
        <AuditSinkCircuitBadge sink={sink({ circuit_state: "closed" })} />,
      ),
    ).toContain("healthy");
    expect(
      renderToStaticMarkup(
        <AuditSinkCircuitBadge sink={sink({ circuit_state: "half_open" })} />,
      ),
    ).toContain("probing");
  });
});

function sink(overrides: Partial<AuditSink> = {}): AuditSink {
  return {
    id: overrides.enabled === false ? "sink-disabled" : "sink-enabled",
    kind: "http",
    name: overrides.enabled === false ? "Disabled sink" : "Enabled sink",
    enabled: true,
    config: {},
    output_format: "postwave_native",
    webhook_format: "postwave_v1",
    consecutive_failures: 0,
    auto_disable_after: 100,
    circuit_state: "closed",
    ...overrides,
  };
}

function job(overrides: Partial<ReplayJob> = {}): ReplayJob {
  return {
    id: "job-1",
    tenant_id: "tenant-1",
    sink_id: "sink-enabled",
    from_audit_id: 10,
    to_audit_id: 14,
    status: "in_progress",
    rows_sent: 0,
    rows_failed: 0,
    created_at: "2026-07-15T11:58:00.000Z",
    ...overrides,
  };
}
