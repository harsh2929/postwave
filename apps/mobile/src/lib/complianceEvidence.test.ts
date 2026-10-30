import { describe, expect, it } from "vitest";

import {
  agentActivityLine,
  agentEventCount,
  AIVS_BUNDLE_MAX_BYTES,
  aivsBundleFilename,
  aivsBundleSizeIssue,
  aivsExportIssue,
  aivsSessionIdIssue,
  parseRetentionActivity,
  retentionHeadline,
  shortRootHash,
} from "./complianceEvidence";

// The exact wire shape handlers.RetentionActivityResponse writes.
const SERVER_PAYLOAD = {
  events: [
    {
      id: 41,
      tenant_id: "t-1",
      action: "audit.retention.purge",
      deleted_id_range: "100-220",
      deleted_count: 120,
      retention_days: 365,
      before_root_hash: "a".repeat(64),
      at: "2026-08-20T02:00:00Z",
    },
  ],
  count: 1,
  total_purged_last_30d: 120,
};

describe("parseRetentionActivity", () => {
  it("reads the server envelope", () => {
    const parsed = parseRetentionActivity(SERVER_PAYLOAD)!;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      id: 41,
      deletedCount: 120,
      retentionDays: 365,
    });
    expect(parsed.totalPurgedLast30d).toBe(120);
  });

  it("returns null for a payload without events — never a fake empty trail", () => {
    expect(parseRetentionActivity({})).toBeNull();
    expect(parseRetentionActivity(null)).toBeNull();
  });

  it("an empty events array is a legitimate (empty) answer", () => {
    const parsed = parseRetentionActivity({ events: [], count: 0 });
    expect(parsed).not.toBeNull();
    expect(parsed!.events).toEqual([]);
  });
});

describe("retentionHeadline", () => {
  it("summarises sweeps and rows", () => {
    const parsed = parseRetentionActivity(SERVER_PAYLOAD)!;
    expect(retentionHeadline(parsed)).toBe(
      "1 sweep on record · 120 rows purged in the last 30 days",
    );
  });
  it("says nothing ran when nothing ran", () => {
    expect(
      retentionHeadline({ events: [], totalPurgedLast30d: 0 }),
    ).toMatch(/No retention sweeps/);
  });
});

describe("shortRootHash", () => {
  it("keeps both comparable ends of a 64-char hash", () => {
    const hash = "0123456789abcdef".repeat(4);
    const short = shortRootHash(hash);
    expect(short.startsWith("01234567")).toBe(true);
    expect(short.endsWith("89abcdef")).toBe(true);
    expect(short.length).toBeLessThan(20);
  });
  it("leaves short values alone", () => {
    expect(shortRootHash("abc")).toBe("abc");
  });
});

describe("Article 50 agent window", () => {
  it("reads the agent row from the actor mix", () => {
    expect(
      agentEventCount({
        byActorType: [
          { label: "user", count: 400 },
          { label: "agent", count: 12 },
        ],
      }),
    ).toBe(12);
  });
  it("a stats payload with no agent row means zero, not unknown", () => {
    expect(agentEventCount({ byActorType: [{ label: "user", count: 4 }] })).toBe(0);
  });
  it("null stats means unknown — and the line says so without inventing a zero", () => {
    expect(agentEventCount(null)).toBeNull();
    expect(agentActivityLine(null)).toMatch(/could not be counted/);
    expect(agentActivityLine(0)).toMatch(/No agent-actor events/);
    expect(agentActivityLine(12)).toBe(
      "12 agent-actor events logged in the last 30 days.",
    );
  });
});

describe("AIVS session-id local refusal", () => {
  it("refuses empty, path-shaped, and whitespace-bearing ids", () => {
    expect(aivsSessionIdIssue("")).toMatch(/Paste the session id/);
    expect(aivsSessionIdIssue("   ")).toMatch(/Paste the session id/);
    expect(aivsSessionIdIssue("a/b")).toMatch(/never contains spaces or slashes/);
    expect(aivsSessionIdIssue("a b")).toMatch(/never contains spaces or slashes/);
    expect(aivsSessionIdIssue("a\\b")).toMatch(/never contains spaces or slashes/);
    expect(aivsSessionIdIssue("x".repeat(129))).toMatch(/does not look like/);
  });
  it("accepts an opaque id, trimmed", () => {
    expect(aivsSessionIdIssue(" sess_01HZX4 ")).toBeNull();
  });
});

describe("AIVS bundle filename", () => {
  it("prefers the server's Content-Disposition name, sanitised", () => {
    expect(
      aivsBundleFilename("s-1", 'attachment; filename="aivs-s-1.tar.gz"'),
    ).toBe("aivs-s-1.tar.gz");
    // Path characters in a header never reach the cache path.
    expect(
      aivsBundleFilename("s-1", 'attachment; filename="../../evil.tar.gz"'),
    ).not.toMatch(/\//);
  });
  it("falls back to a deterministic session-derived name", () => {
    expect(aivsBundleFilename("sess 9", null)).toBe(
      "aivs-bundle-sess_9.tar.gz",
    );
    expect(aivsBundleFilename("  ", null)).toBe("aivs-bundle-session.tar.gz");
  });
  it("refuses a dotfile or unusable header name via the fallback", () => {
    expect(aivsBundleFilename("s", 'filename=".hidden"')).toBe(
      "aivs-bundle-s.tar.gz",
    );
  });
});

describe("AIVS bundle size bound", () => {
  it("refuses empty and over-cap byte counts, allows the rest", () => {
    expect(aivsBundleSizeIssue(0)).toMatch(/empty bundle/);
    expect(aivsBundleSizeIssue(AIVS_BUNDLE_MAX_BYTES + 1)).toMatch(
      /larger than the phone export cap/,
    );
    expect(aivsBundleSizeIssue(AIVS_BUNDLE_MAX_BYTES)).toBeNull();
    expect(aivsBundleSizeIssue(1)).toBeNull();
  });
});

describe("AIVS export failure sentences", () => {
  it("maps no_agent_events to the desktop wording", () => {
    expect(aivsExportIssue({ status: 404, code: "no_agent_events" })).toBe(
      "No AI agent events found for this session id.",
    );
  });
  it("reads a 403 as a permission rule, never a generic failure", () => {
    expect(aivsExportIssue({ status: 403, message: "forbidden" })).toMatch(
      /permission rule/,
    );
  });
  it("keeps the server's own sentence otherwise, with a fallback", () => {
    expect(aivsExportIssue({ status: 500, message: "boom" })).toBe("boom");
    expect(aivsExportIssue(null)).toMatch(/could not be fetched/);
  });
});
