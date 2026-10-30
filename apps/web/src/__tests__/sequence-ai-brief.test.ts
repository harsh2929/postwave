// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure logic behind the sequence settings card and the brief panel:
//   - the quick-match heuristic over the local starter library (a port of the
//     desktop's lib/sequences-ai-brief.ts, tested here because the desktop
//     never unit-tested it directly);
//   - AI draft → canvas-step expansion (desktop draft-steps tests, ported);
//   - goal/stuck contract helpers (desktop sequence-settings tests, ported);
//   - the two transports in sequence-settings-api, through a mocked `api`.

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});

import { ApiError } from "@/lib/api";
import {
  AI_BRIEF_EXAMPLES,
  detectStepCount,
  draftStepsToCanvasSteps,
  formatDraftDelay,
  generateSequenceFromBrief,
  parseDraftStepCount,
  renumberSteps,
} from "@/lib/sequence-ai-brief";
import { SEQUENCE_BRIEF_TEMPLATES } from "@/lib/sequence-brief-templates";
import {
  DRAFT_STEP_COUNT_MAX,
  EMPTY_DRAFT_MESSAGE,
  EXIT_ON_GOAL_CAVEAT,
  GOAL_KIND_OPTIONS,
  STUCK_AFTER_DAYS_MAX,
  classifyDraftError,
  draftSequence,
  getSequenceSettings,
  goalKindCaveat,
  parseStuckAfterDays,
  sequenceSettingsKey,
  updateSequenceSettings,
  type SequenceDraftStep,
} from "@/lib/sequence-settings-api";

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

/* ------------------------------ quick match ------------------------------ */

describe("generateSequenceFromBrief (Quick match, no AI)", () => {
  it("adapts the matched starter to the email count named in the brief", () => {
    const draft = generateSequenceFromBrief("3-step welcome for B2C signups");
    expect(draft).not.toBeNull();
    expect(draft!.templateKey).toBe("welcome-series");
    expect(draft!.proposedName).toBe("3-step welcome for B2C signups");
    expect(draft!.summary).toBe(
      'Adapted the "Welcome series" template to 3 emails based on your brief.',
    );
    expect(draft!.steps.map((s) => s.step.type)).toEqual([
      "email",
      "delay",
      "email",
      "delay",
      "email",
    ]);
    expect(draft!.steps.map((s) => s.step.position)).toEqual([1, 2, 3, 4, 5]);
    expect(draft!.steps[1]?.rationale).toContain("Wait 2 days");
    for (const entry of draft!.steps) expect(entry.rationale).not.toBe("");
  });

  it("trims a longer starter to a smaller requested count without orphaning a trailing wait", () => {
    const draft = generateSequenceFromBrief(
      "Win back lapsed subscribers in 2 emails over 10 days",
    );
    expect(draft!.templateKey).toBe("win-back-lapsed");
    expect(draft!.steps.map((s) => s.step.type)).toEqual([
      "email",
      "delay",
      "email",
    ]);
    expect(draft!.summary).toContain("to 2 emails");
  });

  it("grows a shorter starter by replaying its last wait ahead of a generic follow-up", () => {
    const draft = generateSequenceFromBrief("5-email welcome for new readers");
    expect(draft!.templateKey).toBe("welcome-series");
    const types = draft!.steps.map((s) => s.step.type);
    expect(types).toEqual([
      "email",
      "delay",
      "email",
      "delay",
      "email",
      "delay",
      "email",
      "delay",
      "email",
    ]);
    const last = draft!.steps[8]!.step;
    expect(last.type === "email" && last.email.subject).toBe(
      "Follow-up — keep the conversation going",
    );
    const filler = draft!.steps[7]!.step;
    expect(filler.type === "delay" && filler.delay).toEqual({
      seconds: 3 * 86400,
      value: 3,
      unit: "days",
    });
  });

  it("keeps the canonical cadence when the brief names no count ('3 days' is not a count)", () => {
    const draft = generateSequenceFromBrief(
      "Recover abandoned carts over 3 days with one discount",
    );
    expect(draft!.templateKey).toBe("abandoned-cart");
    expect(draft!.summary).toBe(
      'Matched your brief to the "Abandoned cart" template — 3 emails across the canonical cadence.',
    );
    expect(draft!.steps[0]?.step.type).toBe("delay");
  });

  it("breaks ties by declaration order so 'welcome' beats 'onboarding'", () => {
    expect(generateSequenceFromBrief("welcome onboarding")!.templateKey).toBe(
      "welcome-series",
    );
  });

  it("falls back to the starter name when the brief is too long to be a name", () => {
    const long =
      "A welcome flow for readers who signed up through the footer form on the blog and want the weekly digest";
    expect(generateSequenceFromBrief(long)!.proposedName).toBe(
      "Welcome series",
    );
  });

  it("returns null for a blank brief or one that matches no starter", () => {
    expect(generateSequenceFromBrief("   ")).toBeNull();
    expect(
      generateSequenceFromBrief("Send the invoice PDF to accounting"),
    ).toBeNull();
  });

  it("never mutates the starter library", () => {
    const before = JSON.stringify(SEQUENCE_BRIEF_TEMPLATES);
    generateSequenceFromBrief("2-step welcome");
    generateSequenceFromBrief("6-email welcome");
    expect(JSON.stringify(SEQUENCE_BRIEF_TEMPLATES)).toBe(before);
  });

  it("every example brief matches a starter", () => {
    for (const example of AI_BRIEF_EXAMPLES) {
      expect(generateSequenceFromBrief(example), example).not.toBeNull();
    }
  });
});

describe("detectStepCount", () => {
  it("reads N-step / N emails / N messages and ignores other numbers", () => {
    expect(detectStepCount("3-step welcome")).toBe(3);
    expect(detectStepCount("send 4 emails")).toBe(4);
    expect(detectStepCount("2 messages over 10 days")).toBe(2);
    expect(detectStepCount("over 3 days")).toBeNull();
    expect(detectStepCount("12 emails")).toBeNull();
    expect(detectStepCount("welcome")).toBeNull();
  });
});

describe("renumberSteps", () => {
  it("deep-copies and renumbers 1..n by array order", () => {
    const source = SEQUENCE_BRIEF_TEMPLATES[0]!.steps;
    const out = renumberSteps(source);
    expect(out.map((s) => s.position)).toEqual(source.map((_, i) => i + 1));
    expect(out[0]).not.toBe(source[0]);
    expect(source[0]!.position).toBe(0);
  });
});

/* --------------------------- AI draft → canvas --------------------------- */

const step = (
  position: number,
  delay_hours: number,
  subject = `Email ${position}`,
): SequenceDraftStep => ({
  subject,
  body: `body ${position}`,
  delay_hours,
  position,
});

describe("draftStepsToCanvasSteps", () => {
  it("expands delay_hours into delay nodes ahead of each email", () => {
    const out = draftStepsToCanvasSteps([step(1, 0), step(2, 48), step(3, 3)]);
    expect(out.map((s) => s.type)).toEqual([
      "email",
      "delay",
      "email",
      "delay",
      "email",
    ]);
    expect(out.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
    expect(out[1]!.type === "delay" && out[1]!.delay).toEqual({
      seconds: 48 * 3600,
      value: 2,
      unit: "days",
    });
    expect(out[3]!.type === "delay" && out[3]!.delay).toEqual({
      seconds: 3 * 3600,
      value: 3,
      unit: "hours",
    });
  });

  it("carries subject and body onto email nodes with delay_seconds 0", () => {
    const out = draftStepsToCanvasSteps([step(1, 0, "Welcome!")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type === "email" && out[0]!.email).toEqual({
      subject: "Welcome!",
      body: "body 1",
      delay_seconds: 0,
    });
  });

  it("orders by draft position even when the response array is shuffled", () => {
    const out = draftStepsToCanvasSteps([step(3, 24), step(1, 0), step(2, 24)]);
    expect(
      out
        .filter((s) => s.type === "email")
        .map((s) => (s.type === "email" ? s.email.subject : "")),
    ).toEqual(["Email 1", "Email 2", "Email 3"]);
  });

  it("clamps negative / fractional delays instead of emitting junk nodes", () => {
    const out = draftStepsToCanvasSteps([step(1, -5), step(2, 0.4)]);
    expect(out.map((s) => s.type)).toEqual(["email", "email"]);
  });

  it("returns an empty list for an empty draft", () => {
    expect(draftStepsToCanvasSteps([])).toEqual([]);
  });
});

describe("formatDraftDelay", () => {
  it("renders immediately / hours / whole days", () => {
    expect(formatDraftDelay(0)).toBe("Immediately");
    expect(formatDraftDelay(1)).toBe("Wait 1 hour");
    expect(formatDraftDelay(36)).toBe("Wait 36 hours");
    expect(formatDraftDelay(24)).toBe("Wait 1 day");
    expect(formatDraftDelay(72)).toBe("Wait 3 days");
    expect(formatDraftDelay(-4)).toBe("Immediately");
  });
});

describe("parseDraftStepCount", () => {
  it("blank = auto, integers within the server cap pass, anything else is NaN", () => {
    expect(DRAFT_STEP_COUNT_MAX).toBe(10);
    expect(parseDraftStepCount("")).toBeNull();
    expect(parseDraftStepCount("  ")).toBeNull();
    expect(parseDraftStepCount("3")).toBe(3);
    expect(parseDraftStepCount("10")).toBe(10);
    for (const raw of ["0", "11", "2.5", "abc"]) {
      expect(parseDraftStepCount(raw), raw).toBeNaN();
    }
  });
});

/* ------------------------- goal / stuck contract ------------------------- */

describe("goal kind options", () => {
  it("offers exactly the server's three kinds", () => {
    expect(GOAL_KIND_OPTIONS.map((o) => o.value)).toEqual([
      "open",
      "click",
      "conversion",
    ]);
  });

  it("the conversion caveat states the goal is stored but not evaluated", () => {
    const copy = goalKindCaveat("conversion");
    expect(copy).toMatch(/stored but not yet evaluated/i);
    expect(copy).toMatch(/no conversion event source/i);
  });

  it("open/click caveats describe planning preferences without claiming evaluation", () => {
    expect(goalKindCaveat("open")).toMatch(/does not evaluate/i);
    expect(goalKindCaveat("click")).toMatch(/does not evaluate/i);
  });

  it("the exit-on-goal caveat is honest about engine-side sends", () => {
    expect(EXIT_ON_GOAL_CAVEAT).toMatch(/Stored exit preference only/i);
    expect(EXIT_ON_GOAL_CAVEAT).toMatch(/evaluation are unavailable/i);
  });
});

describe("parseStuckAfterDays", () => {
  it("treats blank and 0 as off", () => {
    expect(parseStuckAfterDays("")).toEqual({ ok: true, value: 0 });
    expect(parseStuckAfterDays("   ")).toEqual({ ok: true, value: 0 });
    expect(parseStuckAfterDays("0")).toEqual({ ok: true, value: 0 });
  });

  it("accepts whole days within the server bounds", () => {
    expect(parseStuckAfterDays("1")).toEqual({ ok: true, value: 1 });
    expect(parseStuckAfterDays("14")).toEqual({ ok: true, value: 14 });
    expect(parseStuckAfterDays(String(STUCK_AFTER_DAYS_MAX))).toEqual({
      ok: true,
      value: STUCK_AFTER_DAYS_MAX,
    });
  });

  it("rejects out-of-range, fractional, and non-numeric input", () => {
    for (const raw of ["-1", "366", "3.5", "abc", "1e9", "Infinity"]) {
      const out = parseStuckAfterDays(raw);
      expect(out.ok, raw).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/between 0 \(off\) and 365/);
    }
  });
});

describe("classifyDraftError", () => {
  it("maps 429 to quota, 503 to unconfigured, everything else to other", () => {
    expect(classifyDraftError(new ApiError("quota", 429))).toBe("quota");
    expect(classifyDraftError(new ApiError("no llm", 503))).toBe(
      "unconfigured",
    );
    expect(classifyDraftError(new ApiError("boom", 500))).toBe("other");
    expect(classifyDraftError(new Error("network"))).toBe("other");
    expect(classifyDraftError(undefined)).toBe("other");
  });
});

describe("sequenceSettingsKey", () => {
  it("is tenant/role scoped like every other dashboard key", () => {
    const key = sequenceSettingsKey("tenant-a", "admin", "seq_1");
    expect(key).toContain("tenant-a");
    expect(key).toContain("admin");
    expect(key[key.length - 1]).toBe("seq_1");
    expect(sequenceSettingsKey("tenant-b", "admin", "seq_1")).not.toEqual(key);
    expect(sequenceSettingsKey("tenant-a", "admin", "seq_2")).not.toEqual(key);
  });
});

/* ------------------------------- transports ------------------------------ */

describe("getSequenceSettings", () => {
  it("reads goal + stuck off the sequence row, encoding the id, and normalizes junk to off", async () => {
    mocks.get.mockResolvedValue({
      id: "seq/1",
      version: 3,
      status: "draft",
      goal: { kind: "purchase", exit_on_goal: true },
      stuck_after_days: 900,
    });
    const settings = await getSequenceSettings("seq/1");
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/v1/voice/sequences/seq%2F1",
      expect.objectContaining({
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
    expect(settings).toEqual({
      version: 3,
      status: "draft",
      goal: null,
      stuckAfterDays: 0,
    });
  });

  it("keeps a valid goal and threshold", async () => {
    mocks.get.mockResolvedValue({
      version: 3,
      goal: { kind: "open", exit_on_goal: true },
      stuck_after_days: 30,
    });
    await expect(getSequenceSettings("seq_1")).resolves.toEqual({
      version: 3,
      goal: { kind: "open", exit_on_goal: true },
      stuckAfterDays: 30,
    });
  });
});

describe("updateSequenceSettings", () => {
  const patch = {
    goal: { kind: "click" as const, exit_on_goal: false },
    stuck_after_days: 14,
  };

  it("PATCHes both fields under If-Match and returns the confirmed next version", async () => {
    mocks.patch.mockResolvedValue({
      id: "seq/1",
      version: 5,
      status: "draft",
      goal: { kind: "click", exit_on_goal: false },
      stuck_after_days: 14,
    });
    const saved = await updateSequenceSettings("seq/1", 4, patch);
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/voice/sequences/seq%2F1",
      { goal: { kind: "click", exit_on_goal: false }, stuck_after_days: 14 },
      expect.objectContaining({
        headers: { "If-Match": '"4"' },
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
    expect(saved).toEqual({
      version: 5,
      status: "draft",
      goal: { kind: "click", exit_on_goal: false },
      stuckAfterDays: 14,
    });
  });

  it("rejects an incomplete receipt instead of inventing a successful save", async () => {
    mocks.patch.mockResolvedValue({ id: "seq_1", version: 5, status: "draft" });
    await expect(updateSequenceSettings("seq_1", 4, patch)).rejects.toThrow(
      /did not confirm the sequence identity, next version, and saved settings/,
    );
  });

  it("refuses a response that does not confirm the next version", async () => {
    mocks.patch.mockResolvedValue({
      id: "seq_1",
      version: 4,
      status: "draft",
      goal: patch.goal,
      stuck_after_days: patch.stuck_after_days,
    });
    await expect(updateSequenceSettings("seq_1", 4, patch)).rejects.toThrow(
      /did not confirm the sequence identity, next version, and saved settings/,
    );
  });

  it("threads cancellation and one stable idempotency key into the live PATCH", async () => {
    mocks.patch.mockResolvedValue({
      id: "seq_1",
      version: 5,
      status: "draft",
      goal: patch.goal,
      stuck_after_days: patch.stuck_after_days,
    });
    const controller = new AbortController();
    await updateSequenceSettings("seq_1", 4, patch, {
      signal: controller.signal,
      idempotencyKey: "idem-sequence-settings-1",
    });
    expect(mocks.patch.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        signal: controller.signal,
        idempotencyKey: "idem-sequence-settings-1",
      }),
    );
  });

  it("refuses to send without a confirmed version or with an out-of-range threshold", async () => {
    await expect(updateSequenceSettings("seq_1", 0, patch)).rejects.toThrow(
      /fresh sequence version/,
    );
    await expect(
      updateSequenceSettings("seq_1", 4, { goal: null, stuck_after_days: 400 }),
    ).rejects.toThrow(/between 0 \(off\) and 365/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe("draftSequence", () => {
  it("POSTs the trimmed brief with optional count/tone as a non-replayable online-only call", async () => {
    mocks.post.mockResolvedValue({
      name: "Draft",
      steps: [{ subject: "S", body: "B", delay_hours: 24, position: 1 }],
    });
    const controller = new AbortController();
    await expect(
      draftSequence(
        { brief: "  3-step welcome  ", step_count: 3, tone: " warm " },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({
      name: "Draft",
      steps: [{ subject: "S", body: "B", delay_hours: 24, position: 1 }],
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/voice/sequences/draft",
      { brief: "3-step welcome", step_count: 3, tone: "warm" },
      {
        requireOnline: true,
        maxAttempts: 1,
        timeoutMs: 60_000,
        signal: controller.signal,
      },
    );
  });

  it("omits count and tone when not given", async () => {
    mocks.post.mockResolvedValue({
      name: "Draft",
      steps: [{ subject: "S", body: "B", delay_hours: 0, position: 1 }],
    });
    await draftSequence({ brief: "welcome", tone: "   " });
    expect(mocks.post.mock.calls[0]?.[1]).toEqual({ brief: "welcome" });
  });

  it("rejects an empty draft and a blank brief (the latter without a request)", async () => {
    mocks.post.mockResolvedValue({ name: "Draft", steps: [] });
    await expect(draftSequence({ brief: "welcome" })).rejects.toThrow(
      EMPTY_DRAFT_MESSAGE,
    );
    mocks.post.mockReset();
    await expect(draftSequence({ brief: "   " })).rejects.toThrow(
      /Describe the sequence/,
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
