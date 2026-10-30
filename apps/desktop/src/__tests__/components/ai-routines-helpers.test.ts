// Agent-routines helpers (roadmap R5): kind/schedule label maps cover
// the wire enums, run-status tones never invent success, output links
// only route to drafts we can actually open (campaign/sequence), and
// the draft validation matches the server's required fields.

import { describe, expect, it } from "vitest";

import {
  ROUTINE_KINDS,
  ROUTINE_NAME_MAX,
  ROUTINE_PROMPT_MAX,
  ROUTINE_SCHEDULES,
  kindLabel,
  routineDraftFingerprint,
  routineFailureMessage,
  routineRunFailureMessage,
  runOutputLink,
  runStatusLabel,
  runStatusTone,
  scheduleLabel,
  targetIdOrNull,
  validateRoutineDraft,
} from "../../components/ai/routines-helpers";

describe("catalogs", () => {
  it("covers both routine kinds and all four schedules", () => {
    expect(ROUTINE_KINDS.map((k) => k.value)).toEqual([
      "draft_campaign",
      "draft_sequence",
    ]);
    expect(ROUTINE_SCHEDULES.map((s) => s.value)).toEqual([
      "manual",
      "daily",
      "weekly",
      "monthly",
    ]);
  });

  it("uses truthful interval labels and bounds unknown wire values", () => {
    expect(kindLabel("draft_campaign")).toBe("Draft a campaign");
    expect(kindLabel("mystery/internal/table")).toBe("Unknown draft type");
    expect(scheduleLabel("weekly")).toBe("Every 7 days after a run starts");
    expect(scheduleLabel("cron:*/5 /internal/table")).toBe(
      "Schedule unavailable",
    );
    expect(ROUTINE_SCHEDULES.map((schedule) => schedule.label)).toEqual([
      "Manual (Run now only)",
      "Every 24 hours after a run starts",
      "Every 7 days after a run starts",
      "Every 30 days after a run starts",
    ]);
  });
});

describe("runStatusTone", () => {
  it("maps the three known statuses and bounds unknown status copy", () => {
    expect(runStatusTone("succeeded")).toBe("success");
    expect(runStatusTone("failed")).toBe("danger");
    expect(runStatusTone("running")).toBe("accent");
    expect(runStatusTone("queued")).toBe("");
    expect(runStatusLabel("succeeded")).toBe("Draft created");
    expect(runStatusLabel("running")).toBe("Drafting");
    expect(runStatusLabel("queued on internal-worker-7")).toBe(
      "Status unavailable",
    );
  });
});

describe("runOutputLink", () => {
  it("routes campaign and sequence outputs to their sections", () => {
    expect(
      runOutputLink({ output_kind: "campaign", output_ref: "c-1" }),
    ).toEqual({
      section: "campaigns",
      id: "c-1",
      label: "Open draft campaign",
    });
    expect(
      runOutputLink({ output_kind: "sequence", output_ref: "s-9" }),
    ).toEqual({
      section: "sequences",
      id: "s-9",
      label: "Open draft sequence",
    });
  });

  it("returns null without a ref or for unknown kinds", () => {
    expect(
      runOutputLink({ output_kind: "campaign", output_ref: "" }),
    ).toBeNull();
    expect(
      runOutputLink({ output_kind: undefined, output_ref: undefined }),
    ).toBeNull();
    expect(
      runOutputLink({ output_kind: "report", output_ref: "r-1" }),
    ).toBeNull();
  });
});

describe("validateRoutineDraft", () => {
  it("requires name and prompt", () => {
    expect(validateRoutineDraft("", "draft something")).toContain("name");
    expect(validateRoutineDraft("Weekly", "  ")).toContain("prompt");
    expect(validateRoutineDraft("Weekly", "draft something")).toBeNull();
  });

  it("matches the server's rune limits", () => {
    expect(
      validateRoutineDraft("n".repeat(ROUTINE_NAME_MAX + 1), "brief"),
    ).toContain(`${ROUTINE_NAME_MAX}`);
    expect(
      validateRoutineDraft("Weekly", "p".repeat(ROUTINE_PROMPT_MAX + 1)),
    ).toContain(ROUTINE_PROMPT_MAX.toLocaleString());
    expect(
      validateRoutineDraft("é".repeat(ROUTINE_NAME_MAX), "brief"),
    ).toBeNull();
  });
});

describe("bounded failure copy", () => {
  const secret = "pq: relation tenant_agent_keys does not exist";

  it("never passes an upstream API message through", () => {
    expect(
      routineFailureMessage(
        { status: 500, code: "internal", message: secret },
        "load",
      ),
    ).toBe(
      "The routines service couldn't complete the request. Retry when ready.",
    );
    expect(
      routineFailureMessage(
        { status: 409, code: "name_taken", message: secret },
        "save",
      ),
    ).toBe("A routine with this name already exists. Choose a different name.");
    expect(routineFailureMessage(new Error(secret), "delete")).not.toContain(
      secret,
    );
  });

  it("replaces stored execution errors while preserving useful outcome truth", () => {
    expect(
      routineRunFailureMessage({ error: secret, output_ref: "draft-7" }),
    ).toContain("A draft was created");
    expect(
      routineRunFailureMessage({ error: secret, output_ref: undefined }),
    ).toBe("The draft couldn't be completed. Retry the routine when ready.");
    expect(
      routineRunFailureMessage({ error: "", output_ref: undefined }),
    ).toBeNull();
  });
});

describe("routineDraftFingerprint", () => {
  it("changes for every persisted editor control", () => {
    const base = {
      name: "Weekly",
      prompt: "Draft it",
      kind: "draft_campaign" as const,
      schedule: "weekly" as const,
      targetSegmentId: "segment-1",
      clearLegacyTargetList: false,
      requireApproval: true,
      enabled: true,
    };
    const fingerprint = routineDraftFingerprint(base);
    for (const changed of [
      { ...base, name: "Monthly" },
      { ...base, prompt: "A different brief" },
      { ...base, kind: "draft_sequence" as const },
      { ...base, schedule: "daily" as const },
      { ...base, targetSegmentId: "segment-2" },
      { ...base, clearLegacyTargetList: true },
      { ...base, requireApproval: false },
      { ...base, enabled: false },
    ]) {
      expect(routineDraftFingerprint(changed)).not.toBe(fingerprint);
    }
  });
});

describe("targetIdOrNull", () => {
  // GAP-2#4: the backend clears the target via NULLIF($n,'')::uuid, so the
  // empty picker value must be sent as "" (a JSON null is invisible to Go's
  // *string and silently keeps the old target). "" is what actually clears.
  it("maps the empty picker value to '' so the backend NULLIF clears it", () => {
    expect(targetIdOrNull("")).toBe("");
    expect(targetIdOrNull("  ")).toBe("");
    expect(targetIdOrNull("list-1")).toBe("list-1");
  });
});
