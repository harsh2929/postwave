/**
 * Parsing + access policy for the per-event forensic endpoints.
 *
 * The access verdicts are the load-bearing half: every one of these gates
 * decides whether an affordance is OFFERED at all (house rule: never a
 * disabled button for a role that cannot use it), so a wrong verdict is either
 * a guaranteed 403 on press or a capability silently withheld from the person
 * mid-incident.
 */
import { describe, expect, it } from "vitest";

import {
  auditUnmaskAccess,
  correlationIdFromMetadata,
  inclusionProofAccess,
  parseAnomalyExplanation,
  parseAuditChain,
  parseInclusionProof,
  parseSessionReplay,
  parseUnmaskResult,
  retentionOverrideAccess,
  validRetentionOverrideDays,
  validUnmaskReason,
} from "./auditForensics";

const ADMIN = { isAdmin: true, auditScopes: ["admin"] };
const SCOPED_READER = {
  isAdmin: false,
  auditScopes: ["audit:read", "audit:read_pii"],
};

describe("auditUnmaskAccess", () => {
  it("is unknown (not refused) while the scope answer is in flight", () => {
    const access = auditUnmaskAccess({
      scopes: null,
      mode: "session",
      online: true,
    });
    expect(access.known).toBe(false);
    expect(access.allowed).toBe(false);
    expect(access.notice).toBeNull();
  });

  it("session floor is admin — a scoped non-admin reader is refused with a rule", () => {
    const access = auditUnmaskAccess({
      scopes: SCOPED_READER,
      mode: "session",
      online: true,
    });
    expect(access.allowed).toBe(false);
    expect(access.known).toBe(true);
    expect(access.notice).toMatch(/owners and admins/);
  });

  it("an API key needs the full triple, and admin satisfies it", () => {
    expect(
      auditUnmaskAccess({
        scopes: {
          isAdmin: false,
          auditScopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
        },
        mode: "api_key",
        online: true,
      }).allowed,
    ).toBe(true);
    const refused = auditUnmaskAccess({
      scopes: SCOPED_READER,
      mode: "api_key",
      online: true,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.notice).toMatch(/audit:execute_actions/);
  });

  it("is withheld offline — a reveal mints an access record and is never queued", () => {
    const access = auditUnmaskAccess({
      scopes: ADMIN,
      mode: "session",
      online: false,
    });
    expect(access.allowed).toBe(false);
    expect(access.notice).toMatch(/offline/i);
  });

  it("allows an online admin session", () => {
    expect(
      auditUnmaskAccess({ scopes: ADMIN, mode: "session", online: true }),
    ).toEqual({ allowed: true, known: true, notice: null });
  });
});

describe("retentionOverrideAccess", () => {
  it("is admin on every path and refuses offline even for admins", () => {
    expect(
      retentionOverrideAccess({
        scopes: SCOPED_READER,
        mode: "session",
        online: true,
      }).allowed,
    ).toBe(false);
    const offline = retentionOverrideAccess({
      scopes: ADMIN,
      mode: "session",
      online: false,
    });
    expect(offline.allowed).toBe(false);
    expect(offline.notice).toMatch(/never queued/);
    expect(
      retentionOverrideAccess({ scopes: ADMIN, mode: "session", online: true })
        .allowed,
    ).toBe(true);
  });
});

describe("inclusionProofAccess", () => {
  it("follows the MOUNT gate (ScopeAdmin), not the manifest's viewer row", () => {
    expect(inclusionProofAccess(SCOPED_READER)).toBe(false);
    expect(inclusionProofAccess(ADMIN)).toBe(true);
    expect(inclusionProofAccess(null)).toBe(false);
  });
});

describe("parseAuditChain", () => {
  it("keeps rows in server order and drops rows with no numeric id", () => {
    const result = parseAuditChain({
      requestId: "host/abc-000123",
      rows: [
        { id: 1, action: "auth.login", at: "2026-08-27T00:00:00Z" },
        { id: "not-a-number", action: "ghost" },
        { id: 2, action: "campaign.sent", metadata: { context: {} } },
      ],
      truncated: true,
    });
    expect(result.requestId).toBe("host/abc-000123");
    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
  });

  it("answers an empty, non-truncated chain for a malformed body", () => {
    expect(parseAuditChain(null)).toEqual({
      requestId: "",
      rows: [],
      truncated: false,
    });
  });
});

describe("correlationIdFromMetadata", () => {
  it("reads metadata.context.correlation_id and trims it", () => {
    expect(
      correlationIdFromMetadata({
        context: { correlation_id: " host/abc-000123 " },
      }),
    ).toBe("host/abc-000123");
  });

  it.each([
    ["no metadata", undefined],
    ["no context", {}],
    ["context not an object", { context: "x" }],
    ["context an array", { context: ["x"] }],
    ["blank id", { context: { correlation_id: "  " } }],
  ])("is null for %s — the trace affordance is then not offered", (_n, meta) => {
    expect(
      correlationIdFromMetadata(meta as Record<string, unknown> | undefined),
    ).toBeNull();
  });
});

describe("parseAnomalyExplanation", () => {
  it("carries reasons, confidence and MITRE techniques through", () => {
    const parsed = parseAnomalyExplanation({
      available: true,
      score: 0.91,
      bucket: "high",
      reasons: [
        {
          type: "impossible_travel",
          confidence: 0.8,
          reason: "Two countries in 9 minutes",
          mitre: ["T1078"],
        },
      ],
      baseline: { meanActionsPerDay: 41.4, typicalIps: ["1.2.3.4"] },
    });
    expect(parsed.available).toBe(true);
    expect(parsed.reasons[0]?.mitre).toEqual(["T1078"]);
    expect(parsed.baseline).toEqual([
      "typically 41 actions/day",
      "usual IPs: 1.2.3.4",
    ]);
  });

  it("treats a missing `available` as unavailable, never as a scored verdict", () => {
    expect(parseAnomalyExplanation({ score: 0.5 }).available).toBe(false);
  });
});

describe("parseInclusionProof", () => {
  it("reads the snake_case wire fields and derives signedness from the signature", () => {
    const parsed = parseInclusionProof({
      leaf_id: 7,
      leaf_hash: "aa",
      audit_path: ["h1", "h2", "h3"],
      tree_size: 1024,
      root_hash: "rr",
      root_kid: "k1",
      anchored_at: "2026-08-27T00:00:00Z",
      root_signature: "sig",
    });
    expect(parsed).toMatchObject({
      kind: "proof",
      leafId: 7,
      pathLength: 3,
      treeSize: 1024,
      signed: true,
    });
  });

  it("an absent signature reads as unsigned, not as broken", () => {
    const parsed = parseInclusionProof({ audit_path: [] });
    expect(parsed.kind).toBe("proof");
    if (parsed.kind === "proof") expect(parsed.signed).toBe(false);
  });
});

describe("parseSessionReplay", () => {
  it("available:true with no URL is treated as unavailable — never a dead link", () => {
    expect(parseSessionReplay({ available: true, replay_url: "" }).available).toBe(
      false,
    );
    expect(
      parseSessionReplay({
        available: true,
        replay_url: "https://replay.example/s/1",
        provider: "posthog",
      }),
    ).toMatchObject({ available: true, provider: "posthog" });
  });
});

describe("parseUnmaskResult", () => {
  it("keeps only string field names and tolerates a missing metadata object", () => {
    expect(
      parseUnmaskResult({ metadata: { email: "a@b.c" }, unmaskedFields: ["email", 3] }),
    ).toEqual({ metadata: { email: "a@b.c" }, unmaskedFields: ["email"] });
    expect(parseUnmaskResult(null)).toEqual({ metadata: {}, unmaskedFields: [] });
  });
});

describe("validUnmaskReason", () => {
  it("requires a real sentence even though the server accepts an empty one", () => {
    expect(validUnmaskReason("")).toBe(false);
    expect(validUnmaskReason("  ok  ")).toBe(false);
    expect(validUnmaskReason("Fraud case #4411")).toBe(true);
  });
});

describe("validRetentionOverrideDays", () => {
  it("mirrors the server bound 1..3650", () => {
    expect(validRetentionOverrideDays(0)).toBe(false);
    expect(validRetentionOverrideDays(1)).toBe(true);
    expect(validRetentionOverrideDays(3650)).toBe(true);
    expect(validRetentionOverrideDays(3651)).toBe(false);
    expect(validRetentionOverrideDays(2.5)).toBe(false);
  });
});
