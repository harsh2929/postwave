import { describe, expect, it } from "vitest";

import {
  gradeAccessibilityLabel,
  gradeTone,
  normalizeGrade,
  normalizeListHealth,
} from "./listHealth";

describe("normalizeGrade", () => {
  it("accepts the five grades the server issues", () => {
    for (const g of ["A", "B", "C", "D", "F"]) {
      expect(normalizeGrade(g)).toBe(g);
    }
  });

  it("upper-cases and trims", () => {
    expect(normalizeGrade("  b ")).toBe("B");
  });

  it("takes the letter off a decorated grade like 'B+'", () => {
    expect(normalizeGrade("B+")).toBe("B");
  });

  it("returns null (render nothing) rather than inventing a grade", () => {
    expect(normalizeGrade("E")).toBeNull();
    expect(normalizeGrade("")).toBeNull();
    expect(normalizeGrade(null)).toBeNull();
    expect(normalizeGrade(undefined)).toBeNull();
    expect(normalizeGrade(3)).toBeNull();
  });
});

describe("gradeTone", () => {
  it("splits healthy / warning / act-now", () => {
    expect(gradeTone("A")).toBe("success");
    expect(gradeTone("B")).toBe("success");
    expect(gradeTone("C")).toBe("warning");
    expect(gradeTone("D")).toBe("danger");
    expect(gradeTone("F")).toBe("danger");
  });

  it("is neutral — not falsely green — when there is no grade", () => {
    expect(gradeTone(null)).toBe("neutral");
    expect(gradeTone(undefined)).toBe("neutral");
    expect(gradeTone("zzz")).toBe("neutral");
  });
});

describe("gradeAccessibilityLabel", () => {
  it("expands the bare letter", () => {
    expect(gradeAccessibilityLabel("A")).toBe("List health grade A");
  });

  it("includes the score when present", () => {
    expect(gradeAccessibilityLabel("C", 61.4)).toBe(
      "List health grade C, score 61 out of 100",
    );
  });

  it("says 'not scored' rather than nothing", () => {
    expect(gradeAccessibilityLabel(null)).toBe("List health not scored");
    expect(gradeAccessibilityLabel("A", Number.NaN)).toBe(
      "List health grade A",
    );
  });
});

describe("normalizeListHealth", () => {
  it("projects the deliverability payload", () => {
    expect(
      normalizeListHealth({
        grade: "b",
        score: 78,
        bounce_rate: 0.012,
        complaint_rate: 0.0003,
        unsubscribe_rate: 0.004,
        engagement_rate: 0.31,
        notes: ["High bounce rate in the last 30 days", 7],
      }),
    ).toEqual({
      grade: "B",
      score: 78,
      bounceRate: 0.012,
      complaintRate: 0.0003,
      unsubscribeRate: 0.004,
      engagementRate: 0.31,
      notes: ["High bounce rate in the last 30 days"],
    });
  });

  it("keeps an absent rate NULL — '0% bounce' is not the same fact", () => {
    const health = normalizeListHealth({ grade: "A" });
    expect(health.bounceRate).toBeNull();
    expect(health.complaintRate).toBeNull();
    expect(health.score).toBeNull();
    expect(health.notes).toEqual([]);
  });

  it("survives a null / non-object payload", () => {
    expect(normalizeListHealth(null).grade).toBeNull();
    expect(normalizeListHealth(undefined).notes).toEqual([]);
  });

  it("drops a NaN rate rather than rendering NaN%", () => {
    expect(normalizeListHealth({ bounce_rate: Number.NaN }).bounceRate).toBeNull();
  });
});
