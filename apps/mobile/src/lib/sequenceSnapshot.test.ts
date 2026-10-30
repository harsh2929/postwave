import { describe, expect, it } from "vitest";

import {
  SNAPSHOT_LIST_ROW_LIMIT,
  SNAPSHOT_STEP_LIMIT,
  SNAPSHOT_VOICE_SAMPLES,
  SNAPSHOT_VOICE_SAMPLE_CHARS,
  projectSequenceDetailSnapshot,
  projectSequenceListSnapshot,
  projectVoiceProfileSnapshot,
} from "./sequenceSnapshot";

/** The vault silently drops payloads over this size (secureVault MAX_BYTES). */
const VAULT_MAX_BYTES = 24_000;

const countSteps = (row: { steps?: unknown }) =>
  Array.isArray(row.steps) ? row.steps.length : Number(row.steps ?? 0);

describe("projectSequenceListSnapshot", () => {
  it("keeps only the five fields the row renders", () => {
    expect(
      projectSequenceListSnapshot(
        [
          {
            id: "s1",
            name: "Welcome",
            status: "draft",
            updated_at: "2026-01-01T00:00:00Z",
            steps: [{}, {}, {}],
            active_runs: 4,
            emails: [{ body: "x".repeat(5000) }],
          },
        ],
        countSteps,
      ),
    ).toEqual([
      {
        id: "s1",
        name: "Welcome",
        status: "draft",
        updated_at: "2026-01-01T00:00:00Z",
        steps: 3,
        active_runs: 4,
      },
    ]);
  });

  it("drops rows with no usable id rather than writing 'undefined' keys", () => {
    expect(
      projectSequenceListSnapshot(
        [{ id: "" }, { id: null }, { name: "orphan" }, { id: "ok" }],
        countSteps,
      ).map((r) => r.id),
    ).toEqual(["ok"]);
  });

  it("caps the row count", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}` }));
    expect(projectSequenceListSnapshot(rows, countSteps)).toHaveLength(
      SNAPSHOT_LIST_ROW_LIMIT,
    );
  });

  it("stays inside the vault envelope for a hostile list", () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      id: `sequence-${i}`,
      name: "N".repeat(500),
      status: "draft",
      updated_at: "2026-01-01T00:00:00Z",
      steps: Array.from({ length: 50 }, () => ({ body: "x".repeat(4000) })),
    }));
    const bytes = Buffer.byteLength(
      JSON.stringify(projectSequenceListSnapshot(rows, countSteps)),
      "utf8",
    );
    expect(bytes).toBeLessThan(VAULT_MAX_BYTES);
  });

  it("returns an empty list for a non-array", () => {
    expect(projectSequenceListSnapshot(null, countSteps)).toEqual([]);
    expect(
      projectSequenceListSnapshot(
        undefined as unknown as never[],
        countSteps,
      ),
    ).toEqual([]);
  });
});

describe("projectSequenceDetailSnapshot", () => {
  it("keeps topology in the server's wire shape and drops email bodies", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "seq-1",
      version: 7,
      name: "Welcome",
      status: "draft",
      updated_at: "2026-01-01T00:00:00Z",
      stuck_after_days: 3,
      trigger: { kind: "list_subscribe", list_id: 4 },
      goal: { kind: "click", exit_on_goal: true },
      steps: [
        {
          type: "email",
          position: 0,
          email: {
            subject: "Hello",
            body: "x".repeat(8000),
            body_html: "y".repeat(8000),
            variants: [
              { key: "a", subject: "A", body: "x".repeat(8000) },
              { key: "b", subject: "B", body: "x".repeat(8000) },
            ],
          },
        },
        {
          type: "delay",
          position: 1,
          delay: { seconds: 86400, value: 1, unit: "days" },
        },
      ],
    });
    expect(projected?.steps[0]).toEqual({
      type: "email",
      position: 0,
      email: {
        subject: "Hello",
        body: "",
        variants: [
          { key: "a", subject: "A", body: "" },
          { key: "b", subject: "B", body: "" },
        ],
      },
    });
    expect(projected?.steps[1]?.delay).toEqual({
      seconds: 86400,
      value: 1,
      unit: "days",
    });
    expect(JSON.stringify(projected)).not.toContain("xxxx");
    expect(projected?.trigger).toEqual({ kind: "list_subscribe", list_id: 4 });
    expect(projected?.snapshot).toBe(true);
  });

  it("never carries a version, so a save can never be built on a snapshot", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "seq-1",
      version: 12,
    });
    expect(projected).not.toHaveProperty("version");
  });

  it("projects condition branches, including the legacy flat shape", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "seq-1",
      steps: [
        {
          type: "condition",
          condition: {
            predicate: "opened",
            value: "prev",
            yes_branch: [{ type: "email", email: { subject: "Yes" } }],
            no_branch: [{ type: "exit" }],
          },
        },
        {
          type: "condition",
          condition_type: "clicked_any",
          condition_value: "cta",
          yes_branch: [{ type: "tag_add", tag: { tag: "vip" } }],
        },
      ],
    });
    expect(projected?.steps[0]?.condition?.predicate).toBe("opened");
    expect(projected?.steps[0]?.condition?.value).toBe("prev");
    expect(projected?.steps[0]?.condition?.yes_branch[0]?.email?.subject).toBe(
      "Yes",
    );
    expect(projected?.steps[0]?.condition?.no_branch[0]?.type).toBe("exit");
    expect(projected?.steps[1]?.condition?.predicate).toBe("clicked_any");
    expect(projected?.steps[1]?.condition?.yes_branch[0]?.tag).toEqual({
      tag: "vip",
    });
    expect(projected?.steps[1]?.condition?.no_branch).toEqual([]);
  });

  it("infers a type the same way wireToCanvas does when the row has none", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "s",
      steps: [{ subject: "flat" }, { delay_value: 2, delay_unit: "hours" }],
    });
    expect(projected?.steps[0]?.type).toBe("email");
    expect(projected?.steps[0]?.email?.subject).toBe("flat");
    expect(projected?.steps[1]?.type).toBe("delay");
    expect(projected?.steps[1]?.delay).toEqual({
      seconds: 0,
      value: 2,
      unit: "hours",
    });
  });

  it("converts legacy interval_days into wire seconds", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "s",
      steps: [{ type: "delay", interval_days: 3 }],
    });
    expect(projected?.steps[0]?.delay?.seconds).toBe(259_200);
  });

  it("falls back to the legacy emails projection when steps is empty", () => {
    const projected = projectSequenceDetailSnapshot({
      id: "seq-1",
      steps: [],
      emails: [{ subject: "Legacy", body: "z".repeat(9000) }],
    });
    expect(projected?.steps).toHaveLength(1);
    expect(projected?.steps[0]?.email?.subject).toBe("Legacy");
    expect(projected?.steps[0]?.email?.body).toBe("");
  });

  it("caps total steps across branches so a deep tree cannot blow the budget", () => {
    const steps = Array.from({ length: 400 }, (_, i) => ({
      type: "email",
      position: i,
      email: { subject: `S${i}` },
    }));
    const projected = projectSequenceDetailSnapshot({ id: "seq-1", steps });
    expect(projected?.steps).toHaveLength(SNAPSHOT_STEP_LIMIT);
  });

  it("stops recursing past the branch-depth limit", () => {
    let node: Record<string, unknown> = { type: "exit" };
    for (let i = 0; i < 20; i += 1) {
      node = { type: "condition", condition: { yes_branch: [node] } };
    }
    const projected = projectSequenceDetailSnapshot({ id: "s", steps: [node] });
    let depth = 0;
    let cursor = projected?.steps[0];
    while (cursor?.condition?.yes_branch[0]) {
      depth += 1;
      cursor = cursor.condition.yes_branch[0];
    }
    expect(depth).toBeLessThanOrEqual(6);
  });

  it("stays inside the vault envelope for a hostile detail", () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({
      type: "email",
      position: i,
      email: {
        subject: "S".repeat(600),
        body: "x".repeat(6000),
        body_html: "y".repeat(6000),
      },
    }));
    const bytes = Buffer.byteLength(
      JSON.stringify(projectSequenceDetailSnapshot({ id: "s", steps })),
      "utf8",
    );
    expect(bytes).toBeLessThan(VAULT_MAX_BYTES);
  });

  it("returns null when the row has no id", () => {
    expect(projectSequenceDetailSnapshot(null)).toBeNull();
    expect(projectSequenceDetailSnapshot({ name: "no id" })).toBeNull();
  });
});

describe("projectVoiceProfileSnapshot", () => {
  it("caps sample count and sample length but keeps the numeric sections", () => {
    const projected = projectVoiceProfileSnapshot({
      generated_at: "2026-01-01T00:00:00Z",
      tonal: { humor: 0.2, optimism: 0.6, personal_vs_observational: 0.4, directness: 0.8 },
      representative_samples: Array.from({ length: 12 }, (_, i) => ({
        id: `s${i}`,
        text: "w".repeat(4000),
      })),
    });
    expect(projected?.representative_samples).toHaveLength(
      SNAPSHOT_VOICE_SAMPLES,
    );
    const first = (
      projected?.representative_samples as { text: string }[] | undefined
    )?.[0];
    expect(first?.text.length).toBeLessThanOrEqual(SNAPSHOT_VOICE_SAMPLE_CHARS);
    expect(projected?.tonal).toEqual({
      humor: 0.2,
      optimism: 0.6,
      personal_vs_observational: 0.4,
      directness: 0.8,
    });
  });

  it("leaves a profile without samples untouched", () => {
    const input = { generated_at: "x", tonal: { humor: 1 } };
    expect(projectVoiceProfileSnapshot(input)).toEqual(input);
  });

  it("returns null for nothing", () => {
    expect(projectVoiceProfileSnapshot(null)).toBeNull();
    expect(projectVoiceProfileSnapshot(undefined)).toBeNull();
  });
});
