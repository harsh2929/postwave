import { describe, expect, it } from "vitest";

import {
  streamableInvestigationId,
  INVESTIGATION_NO_EXECUTION_NOTE,
  investigationConfidenceLabel,
  investigationDecisionCopy,
  investigationDecisionError,
  investigationStatusLabel,
  investigationSummaryLine,
  isInvestigationDecidable,
  normalizeInvestigation,
  normalizeInvestigationList,
  type AuditInvestigation,
} from "./auditInvestigations";

const RAW = {
  id: "inv-1",
  seed_audit_id: 4021,
  findings: [
    {
      num: 1,
      hypothesis: "Credential stuffing against the admin console",
      mitre_techniques: ["T1110"],
      confidence: 0.72,
      evidence_audit_ids: [4021, 4022],
    },
  ],
  evidence_audit_ids: [4021, 4022, 4023],
  proposed_actions: [
    {
      id: "a1",
      action: "disable_api_key",
      target_id: "key_9",
      rationale: "Key used from a new ASN",
      severity: "high",
      requires_human_approval: true,
    },
  ],
  mitre_techniques: ["T1110"],
  confidence: 0.72,
  status: "draft",
};

describe("normalizeInvestigation", () => {
  it("reads the wire row", () => {
    const inv = normalizeInvestigation(RAW);
    expect(inv?.id).toBe("inv-1");
    expect(inv?.findings).toHaveLength(1);
    expect(inv?.proposed_actions[0]?.target_id).toBe("key_9");
  });

  it("rejects a row with no id rather than rendering a ghost", () => {
    expect(normalizeInvestigation({ seed_audit_id: 1 })).toBeNull();
    expect(normalizeInvestigation(null)).toBeNull();
  });

  it("clamps an unknown status to draft", () => {
    expect(normalizeInvestigation({ id: "x", status: "weird" })?.status).toBe(
      "draft",
    );
  });

  it("keeps a finding with no hypothesis visible instead of dropping it", () => {
    // Every finding cites audit ids; silently discarding one loses evidence.
    const inv = normalizeInvestigation({ id: "x", findings: [{ num: 2 }] });
    expect(inv?.findings[0]?.hypothesis).toBe("(no hypothesis recorded)");
  });

  it("defaults requires_human_approval to true, never to false", () => {
    const inv = normalizeInvestigation({ id: "x", proposed_actions: [{}] });
    expect(inv?.proposed_actions[0]?.requires_human_approval).toBe(true);
  });
});

describe("normalizeInvestigationList", () => {
  it("unwraps the handler's envelope", () => {
    expect(normalizeInvestigationList({ investigations: [RAW] })).toHaveLength(1);
  });

  it("tolerates a bare array and a null body", () => {
    expect(normalizeInvestigationList([RAW])).toHaveLength(1);
    expect(normalizeInvestigationList(null)).toEqual([]);
  });

  it("drops unusable rows without taking the list down", () => {
    expect(normalizeInvestigationList({ investigations: [RAW, null, 4] })).toHaveLength(
      1,
    );
  });
});

describe("isInvestigationDecidable", () => {
  it("is true only for a draft", () => {
    expect(isInvestigationDecidable({ status: "draft" })).toBe(true);
    for (const status of ["approved", "rejected", "executed"] as const) {
      expect(isInvestigationDecidable({ status })).toBe(false);
    }
    expect(isInvestigationDecidable(null)).toBe(false);
  });
});

describe("investigationConfidenceLabel", () => {
  it("renders a fraction as a percentage", () => {
    expect(investigationConfidenceLabel(0.72)).toBe("72%");
  });

  it("passes an already-percent value through, clamped", () => {
    expect(investigationConfidenceLabel(88)).toBe("88%");
    expect(investigationConfidenceLabel(140)).toBe("100%");
  });

  it("is an em-dash when unmeasured — never 0%", () => {
    expect(investigationConfidenceLabel(undefined)).toBe("—");
    expect(investigationConfidenceLabel(null)).toBe("—");
    expect(investigationConfidenceLabel(0)).toBe("—");
    expect(investigationConfidenceLabel(Number.NaN)).toBe("—");
  });
});

describe("investigationSummaryLine", () => {
  it("counts findings, actions and cited events", () => {
    const inv = normalizeInvestigation(RAW) as AuditInvestigation;
    expect(investigationSummaryLine(inv)).toBe(
      "1 finding · 1 proposed action · 3 cited events",
    );
  });

  it("omits the citation clause when nothing is cited", () => {
    const inv = normalizeInvestigation({ id: "x" }) as AuditInvestigation;
    expect(investigationSummaryLine(inv)).toBe("0 findings · 0 proposed actions");
  });
});

describe("investigationDecisionCopy", () => {
  it("always discloses that approval does not execute anything", () => {
    const inv = normalizeInvestigation(RAW) as AuditInvestigation;
    expect(investigationDecisionCopy(inv, "approve").consequence).toBe(
      INVESTIGATION_NO_EXECUTION_NOTE,
    );
    expect(INVESTIGATION_NO_EXECUTION_NOTE).toContain("does NOT apply");
  });

  it("says partial approval is not possible", () => {
    const inv = normalizeInvestigation(RAW) as AuditInvestigation;
    expect(investigationDecisionCopy(inv, "approve").message).toContain(
      "cannot be approved separately",
    );
  });

  it("marks rejection destructive and approval not", () => {
    const inv = normalizeInvestigation(RAW) as AuditInvestigation;
    expect(investigationDecisionCopy(inv, "reject").destructive).toBe(true);
    expect(investigationDecisionCopy(inv, "approve").destructive).toBe(false);
  });
});

describe("investigationDecisionError", () => {
  it("explains the 409 both decide routes return once the row left draft", () => {
    expect(investigationDecisionError({ status: 409 })).toContain(
      "already decided",
    );
  });

  it("names the admin gate on a 403 and the missing agent on a 503", () => {
    expect(investigationDecisionError({ status: 403 })).toContain("owners and admins");
    expect(investigationDecisionError({ status: 503 })).toContain("not configured");
  });

  it("never claims a change happened on an unknown failure", () => {
    expect(investigationDecisionError(new Error("boom"))).toContain(
      "Nothing was changed",
    );
  });
});

describe("investigationStatusLabel", () => {
  it("names a draft as awaiting review rather than as a draft document", () => {
    expect(investigationStatusLabel("draft")).toBe("Awaiting review");
  });
});

describe("streamableInvestigationId", () => {
  const row = (
    id: string,
    status: string,
    executed_at: string | null = null,
  ) =>
    ({ id, status, executed_at }) as Parameters<
      typeof streamableInvestigationId
    >[0] extends readonly (infer T)[] | null | undefined ? T : never;

  it("picks the newest still-mutable row: a draft, or an unexecuted approval", () => {
    expect(
      streamableInvestigationId([
        row("inv-2", "rejected"),
        row("inv-1", "draft"),
      ]),
    ).toBe("inv-1");
    expect(
      streamableInvestigationId([row("inv-3", "approved", null)]),
    ).toBe("inv-3");
  });

  it("holds no socket over a terminal queue — those rows never transition again", () => {
    expect(
      streamableInvestigationId([
        row("inv-1", "rejected"),
        row("inv-2", "executed"),
        row("inv-3", "approved", "2026-08-27T00:00:00Z"),
      ]),
    ).toBeNull();
    expect(streamableInvestigationId([])).toBeNull();
    expect(streamableInvestigationId(null)).toBeNull();
    expect(streamableInvestigationId(undefined)).toBeNull();
  });
});
