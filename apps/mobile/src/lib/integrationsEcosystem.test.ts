import { describe, expect, it } from "vitest";

import {
  coverageMaturityLabel,
  coverageTargetLine,
  normalizeCoverageReport,
  normalizeReadinessReport,
  normalizeStackReport,
  readinessCheckTone,
  readinessChecksByOutcome,
  readinessVerdictLine,
  stackCoverageLine,
  stackStatusLabel,
  stackStatusTone,
  stacksByUrgency,
} from "./integrationsEcosystem";

describe("normalizeCoverageReport", () => {
  const view = normalizeCoverageReport({
    public_entries: 614,
    target_public_entries: 350,
    native_managed: 186,
    target_native_managed: 70,
    native_verified: 41,
    target_native_verified: 70,
    public_parity: true,
    native_parity: true,
    native_verification_parity: false,
    bridge_ready: 240,
    planned: 88,
    available_recipes: 310,
    categories: [
      {
        key: "ecommerce",
        label: "Ecommerce",
        total: 60,
        native_managed: 12,
        bridge_ready: 30,
        planned: 4,
        maturity: "verified_hybrid_ready",
      },
      { key: "crm", total: 20, maturity: "bridge_ready" },
    ],
    priority_gaps: [
      {
        slug: "acme",
        name: "Acme",
        category: "crm",
        current_badge: "planned",
        runtime_status: "planned",
        bridge_available: false,
        reason: "No bridge recipe and no native foundation.",
      },
      { name: "no slug" },
    ],
  });

  it("keeps the three targets with their own parity verdicts", () => {
    expect(view.targets.map((target) => target.parity)).toEqual([
      true,
      true,
      false,
    ]);
    expect(coverageTargetLine(view.targets[0]!)).toBe("614 of 350");
  });

  it("drops a category with no key and falls back to the key as a label", () => {
    expect(view.categories).toHaveLength(2);
    expect(view.categories[1]!.label).toBe("crm");
  });

  it("drops a priority gap with no slug", () => {
    expect(view.priorityGaps.map((gap) => gap.slug)).toEqual(["acme"]);
    expect(view.priorityGaps[0]!.reason).toBe(
      "No bridge recipe and no native foundation.",
    );
  });

  it("parses a missing number as null, never as zero", () => {
    const empty = normalizeCoverageReport({});
    expect(empty.bridgeReady).toBeNull();
    expect(empty.planned).toBeNull();
    expect(empty.availableRecipes).toBeNull();
    expect(empty.targets.every((target) => target.value === null)).toBe(true);
    expect(empty.targets.every((target) => target.parity === null)).toBe(true);
  });

  it("refuses a non-numeric count rather than coercing it", () => {
    const odd = normalizeCoverageReport({ bridge_ready: "240" });
    expect(odd.bridgeReady).toBeNull();
  });

  it("survives junk", () => {
    expect(normalizeCoverageReport(null).categories).toEqual([]);
    expect(normalizeCoverageReport({ categories: "nope" }).categories).toEqual(
      [],
    );
  });
});

describe("coverageTargetLine", () => {
  it("says nothing when either half is missing", () => {
    expect(
      coverageTargetLine({ label: "x", value: 5, target: null, parity: null }),
    ).toBeNull();
    expect(
      coverageTargetLine({ label: "x", value: null, target: 5, parity: null }),
    ).toBeNull();
  });
});

describe("coverageMaturityLabel", () => {
  it("maps the server tokens and passes unknown ones through", () => {
    expect(coverageMaturityLabel("foundation_cataloged")).toBe("Foundation only");
    expect(coverageMaturityLabel("brand_new")).toBe("brand_new");
    expect(coverageMaturityLabel("")).toBe("Unclassified");
  });
});

describe("normalizeReadinessReport", () => {
  const view = normalizeReadinessReport({
    ready: false,
    marketable_public_claim: false,
    public_claim: "Integration parity is in progress; use readiness checks.",
    checks: [
      {
        key: "a",
        label: "Public entries",
        state: "pass",
        severity: "ok",
        count: 614,
        message: "614 public entries.",
      },
      {
        key: "b",
        label: "Native verified",
        state: "fail",
        severity: "blocker",
        count: 29,
        message: "29 short of the verified target.",
      },
      {
        key: "c",
        label: "Recipes",
        state: "fail",
        severity: "warning",
        count: 3,
        message: "3 connectors have no recipe.",
      },
      { label: "no key" },
    ],
    issues: [
      { key: "i1", severity: "blocker", message: "Missing metadata.", name: "Acme" },
      { key: "i2", message: "" },
    ],
    issue_counts: { total: 4, "severity:blocker": 1, "severity:warning": 3 },
    recommendations: ["Do the thing.", ""],
  });

  it("keeps only checks with a key and issues with a message", () => {
    expect(view.checks.map((check) => check.key)).toEqual(["a", "b", "c"]);
    expect(view.issues.map((issue) => issue.key)).toEqual(["i1"]);
    expect(view.recommendations).toEqual(["Do the thing."]);
  });

  it("renders failing checks first", () => {
    expect(readinessChecksByOutcome(view).map((check) => check.key)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("tones a failure by its severity", () => {
    const [blocker, warning, pass] = readinessChecksByOutcome(view);
    expect(readinessCheckTone(blocker!)).toBe("danger");
    expect(readinessCheckTone(warning!)).toBe("warning");
    expect(readinessCheckTone(pass!)).toBe("success");
  });

  it("states the verdict with the server's blocker count", () => {
    expect(readinessVerdictLine(view)).toBe(
      "Release gate does not pass. 1 blocker.",
    );
    expect(
      readinessVerdictLine({ ...view, ready: true, issueCounts: { "severity:blocker": 0 } }),
    ).toBe("Release gate passes. 0 blockers.");
  });

  it("invents no verdict when the server sent no `ready`", () => {
    expect(readinessVerdictLine(normalizeReadinessReport({}))).toBeNull();
    expect(normalizeReadinessReport({}).ready).toBeNull();
  });

  it("omits the blocker clause when the count is absent, rather than saying zero", () => {
    expect(readinessVerdictLine({ ...view, issueCounts: {} })).toBe(
      "Release gate does not pass.",
    );
  });
});

describe("normalizeStackReport", () => {
  const view = normalizeStackReport({
    target_coverage_pct: 90,
    covered_pct: 80,
    covered_stacks: 8,
    total_stacks: 10,
    stacks: [
      {
        key: "ready-one",
        name: "Ready one",
        status: "ready",
        coverage_pct: 100,
        required_covered: 4,
        required_total: 4,
        next_actions: ["Maintain connector health."],
      },
      {
        key: "gap-one",
        name: "Gap one",
        status: "gap",
        coverage_pct: 25,
        required_covered: 1,
        required_total: 4,
        next_actions: ["Ship coverage for Acme."],
      },
      {
        key: "partial-one",
        name: "Partial one",
        status: "partial",
        required_covered: 2,
        required_total: 4,
      },
      { name: "no key" },
    ],
    highest_impact_gaps: [
      { slug: "acme", name: "Acme", stacks: 3, reason: "Planned only." },
      { name: "no slug" },
    ],
  });

  it("drops a stack with no key and a gap with no slug", () => {
    expect(view.stacks.map((stack) => stack.key)).toEqual([
      "ready-one",
      "gap-one",
      "partial-one",
    ]);
    expect(view.highestImpactGaps.map((gap) => gap.slug)).toEqual(["acme"]);
  });

  it("orders worst first", () => {
    expect(stacksByUrgency(view).map((stack) => stack.key)).toEqual([
      "gap-one",
      "partial-one",
      "ready-one",
    ]);
  });

  it("builds the coverage line from the numbers the server sent", () => {
    expect(stackCoverageLine(view)).toBe(
      "8 of 10 stacks covered (80%, target 90%)",
    );
  });

  it("drops each clause independently when its number is missing", () => {
    expect(
      stackCoverageLine({ ...view, coveredPct: null, targetCoveragePct: null }),
    ).toBe("8 of 10 stacks covered");
    expect(stackCoverageLine({ ...view, totalStacks: null })).toBeNull();
  });

  it("labels and tones the server's status vocabulary", () => {
    expect(stackStatusLabel("gap")).toBe("Gap");
    expect(stackStatusLabel("mystery")).toBe("mystery");
    expect(stackStatusTone("gap")).toBe("danger");
    expect(stackStatusTone("partial")).toBe("warning");
    expect(stackStatusTone("ready")).toBe("success");
    expect(stackStatusTone("covered")).toBe("success");
    expect(stackStatusTone("empty")).toBe("neutral");
  });

  it("survives junk", () => {
    expect(normalizeStackReport(null).stacks).toEqual([]);
    expect(normalizeStackReport({ stacks: 7 }).stacks).toEqual([]);
    expect(normalizeStackReport({}).coveredStacks).toBeNull();
  });
});
