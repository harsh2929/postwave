import { describe, expect, it } from "vitest";

import {
  GOLDEN_BRIEF_MAX,
  GOLDEN_OUTPUT_MAX,
  REGRESSION_DEFAULT_HARD_GATE_THRESHOLD,
  REGRESSION_DEFAULT_MIN_EXAMPLES,
  REGRESSION_DEFAULT_WARN_THRESHOLD,
  REGRESSION_MAX_MIN_EXAMPLES,
  RUN_MODEL_TAG_MAX,
  buildGoldenExampleBody,
  buildSettingsPut,
  buildTriggerRunBody,
  parseRegressionSettings,
  recordingPolicySentence,
  regressionAdminErrorMessage,
  regressionTriggerFailure,
  settingsUnchanged,
  surfaceKindLabel,
} from "./aiRegressionAdmin";

const UUID = "3f2a8c1e-4b5d-4f6a-9c8b-1d2e3f4a5b6c";

describe("parseRegressionSettings", () => {
  it("reads a full settings object", () => {
    expect(
      parseRegressionSettings({
        warn_threshold: 55,
        hard_gate_enabled: true,
        hard_gate_threshold: 80,
        min_examples_for_gate: 12,
      }),
    ).toEqual({
      warnThreshold: 55,
      hardGateEnabled: true,
      hardGateThreshold: 80,
      minExamplesForGate: 12,
    });
  });

  it("falls back to the server's DOCUMENTED defaults, not to zero", () => {
    // A zeroed warn threshold would mean "never warn", which is the opposite
    // of the advisory-first posture DefaultSettings ships.
    const s = parseRegressionSettings(null);
    expect(s.warnThreshold).toBe(REGRESSION_DEFAULT_WARN_THRESHOLD);
    expect(s.hardGateThreshold).toBe(REGRESSION_DEFAULT_HARD_GATE_THRESHOLD);
    expect(s.minExamplesForGate).toBe(REGRESSION_DEFAULT_MIN_EXAMPLES);
    // Advisory-first: the hard gate is OFF unless the server says true.
    expect(s.hardGateEnabled).toBe(false);
    expect(parseRegressionSettings({ hard_gate_enabled: "yes" }).hardGateEnabled).toBe(
      false,
    );
  });
});

describe("buildSettingsPut", () => {
  const base = {
    warnThreshold: "60",
    hardGateEnabled: false,
    hardGateThreshold: "70",
    minExamplesForGate: "5",
  };

  it("mirrors validateSettings' 0..100 bounds", () => {
    expect(buildSettingsPut({ ...base, warnThreshold: "0" }).ok).toBe(true);
    expect(buildSettingsPut({ ...base, warnThreshold: "100" }).ok).toBe(true);
    expect(buildSettingsPut({ ...base, warnThreshold: "101" }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, warnThreshold: "-1" }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, hardGateThreshold: "100.5" }).ok).toBe(
      false,
    );
  });

  it("requires min_examples_for_gate to be a whole number in 1..MaxInt32", () => {
    expect(buildSettingsPut({ ...base, minExamplesForGate: "0" }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, minExamplesForGate: "1" }).ok).toBe(true);
    expect(buildSettingsPut({ ...base, minExamplesForGate: "2.5" }).ok).toBe(
      false,
    );
    expect(
      buildSettingsPut({
        ...base,
        minExamplesForGate: String(REGRESSION_MAX_MIN_EXAMPLES),
      }).ok,
    ).toBe(true);
    expect(
      buildSettingsPut({
        ...base,
        minExamplesForGate: String(REGRESSION_MAX_MIN_EXAMPLES + 1),
      }).ok,
    ).toBe(false);
  });

  it("refuses a blank or non-numeric field instead of sending Number('') === 0", () => {
    // Number("") is 0 and Number("  ") is 0. Either would silently write a
    // threshold of zero the operator never typed.
    expect(buildSettingsPut({ ...base, warnThreshold: "" }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, warnThreshold: "   " }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, warnThreshold: "60abc" }).ok).toBe(false);
    expect(buildSettingsPut({ ...base, minExamplesForGate: "1e3" }).ok).toBe(
      false,
    );
  });

  it("sends ALL FOUR fields, because the PUT is a whole-object replace", () => {
    const built = buildSettingsPut({ ...base, hardGateEnabled: true });
    expect(built.ok).toBe(true);
    expect(Object.keys(built.body ?? {}).sort()).toEqual([
      "hard_gate_enabled",
      "hard_gate_threshold",
      "min_examples_for_gate",
      "warn_threshold",
    ]);
  });

  it("detects a no-op save", () => {
    const built = buildSettingsPut(base);
    const current = parseRegressionSettings({
      warn_threshold: 60,
      hard_gate_enabled: false,
      hard_gate_threshold: 70,
      min_examples_for_gate: 5,
    });
    expect(built.ok && settingsUnchanged(current, built.body)).toBe(true);
    const changed = buildSettingsPut({ ...base, warnThreshold: "61" });
    expect(changed.ok && settingsUnchanged(current, changed.body)).toBe(false);
  });
});

describe("recordingPolicySentence", () => {
  it("says a run can NEVER be recorded as a failure while the gate is off", () => {
    const s = recordingPolicySentence({
      warnThreshold: 60,
      hardGateEnabled: false,
      hardGateThreshold: 70,
      minExamplesForGate: 5,
    });
    expect(s).toContain("Advisory only");
    expect(s).toContain("no run can be recorded as a failure");
  });

  it("names the minimum sample the gate needs before it may record a failure", () => {
    // ComputeGate returns advisory below min_examples_for_gate regardless of
    // the score, so a sentence that omitted the sample size would overclaim.
    const s = recordingPolicySentence({
      warnThreshold: 60,
      hardGateEnabled: true,
      hardGateThreshold: 70,
      minExamplesForGate: 8,
    });
    expect(s).toContain("at least 8 scored examples");
    expect(s).toContain("below 70");
    expect(s).toContain("stays advisory");
  });
});

describe("buildTriggerRunBody", () => {
  it("requires the operator's label", () => {
    expect(buildTriggerRunBody("").ok).toBe(false);
    expect(buildTriggerRunBody("   ").error).toBe(
      "model_version_tag is required",
    );
  });

  it("enforces validBoundedText's 160-rune cap in code points", () => {
    expect(buildTriggerRunBody("x".repeat(RUN_MODEL_TAG_MAX)).ok).toBe(true);
    expect(buildTriggerRunBody("x".repeat(RUN_MODEL_TAG_MAX + 1)).ok).toBe(false);
    expect(buildTriggerRunBody("🙂".repeat(RUN_MODEL_TAG_MAX)).ok).toBe(true);
  });

  it("rejects control characters, which validBoundedText also rejects", () => {
    // A pasted tag carrying a newline would otherwise come back as an opaque
    // 422 invalid_run with no field named.
    expect(buildTriggerRunBody("v1\nv2").ok).toBe(false);
    expect(buildTriggerRunBody("v1\u0007").ok).toBe(false);
    expect(buildTriggerRunBody("  v1.2.3  ").body?.model_version_tag).toBe(
      "v1.2.3",
    );
  });
});

describe("buildGoldenExampleBody", () => {
  const ok = {
    surfaceKind: "campaign_draft",
    brief: "Write a launch email",
    approvedOutput: "Here is the launch email.",
    requestId: UUID,
  };

  it("refuses before submitting when no UUID could be minted", () => {
    // The handler checks request_id FIRST (422 invalid_golden_request_id), so
    // a fabricated or empty id would be recorded as provenance if it slipped.
    expect(buildGoldenExampleBody({ ...ok, requestId: "" }).ok).toBe(false);
    expect(buildGoldenExampleBody({ ...ok, requestId: "not-a-uuid" }).ok).toBe(
      false,
    );
    expect(
      buildGoldenExampleBody({ ...ok, requestId: UUID.toUpperCase() }).ok,
    ).toBe(false);
    expect(buildGoldenExampleBody({ ...ok, requestId: "" }).error).toContain(
      "Nothing was submitted",
    );
  });

  it("accepts only the five surface kinds the CHECK constraint allows", () => {
    expect(buildGoldenExampleBody({ ...ok, surfaceKind: "reply_intent" }).ok).toBe(
      true,
    );
    const bad = buildGoldenExampleBody({ ...ok, surfaceKind: "blog_post" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("campaign_draft");
  });

  it("mirrors the 1..8000 / 1..32000 rune bounds after trimming", () => {
    expect(buildGoldenExampleBody({ ...ok, brief: "   " }).ok).toBe(false);
    expect(
      buildGoldenExampleBody({ ...ok, brief: "b".repeat(GOLDEN_BRIEF_MAX) }).ok,
    ).toBe(true);
    expect(
      buildGoldenExampleBody({ ...ok, brief: "b".repeat(GOLDEN_BRIEF_MAX + 1) })
        .ok,
    ).toBe(false);
    expect(buildGoldenExampleBody({ ...ok, approvedOutput: "" }).ok).toBe(false);
    expect(
      buildGoldenExampleBody({
        ...ok,
        approvedOutput: "o".repeat(GOLDEN_OUTPUT_MAX + 1),
      }).ok,
    ).toBe(false);
  });

  it("sends exactly the four public keys and trims them", () => {
    const built = buildGoldenExampleBody({
      ...ok,
      brief: "  padded  ",
      approvedOutput: "  output  ",
    });
    expect(built.body).toEqual({
      surface_kind: "campaign_draft",
      brief: "padded",
      approved_output: "output",
      request_id: UUID,
    });
  });
});

describe("regressionTriggerFailure", () => {
  it("renders the server's sentence verbatim for each documented refusal", () => {
    expect(
      regressionTriggerFailure(
        409,
        "run_in_flight",
        "a regression run is already in progress for this tenant",
      ),
    ).toEqual({
      message: "a regression run is already in progress for this tenant",
      retryable: false,
    });
    expect(
      regressionTriggerFailure(422, "no_golden_examples", "no golden examples")
        .message,
    ).toBe("no golden examples");
    expect(
      regressionTriggerFailure(
        503,
        "regression_executor_unavailable",
        "the regression executor is not configured",
      ).message,
    ).toBe("the regression executor is not configured");
  });

  it("offers no retry for any refusal a repeat press cannot change", () => {
    for (const code of [
      "run_in_flight",
      "no_golden_examples",
      "regression_executor_unavailable",
    ]) {
      expect(regressionTriggerFailure(422, code, "x").retryable).toBe(false);
    }
    expect(regressionTriggerFailure(403, undefined, "").retryable).toBe(false);
    // A 500 is a genuine transient; that one may be pressed again.
    expect(regressionTriggerFailure(500, undefined, "").retryable).toBe(true);
  });

  it("keeps a fallback for a stripped body", () => {
    expect(regressionTriggerFailure(409, undefined, undefined).message).toContain(
      "already in progress",
    );
    expect(regressionTriggerFailure(503, undefined, "  ").message).toContain(
      "not configured",
    );
  });
});

describe("surfaceKindLabel + admin errors", () => {
  it("labels every known surface and title-cases an unknown one", () => {
    expect(surfaceKindLabel("campaign_summary")).toBe("Campaign summary");
    expect(surfaceKindLabel("future_surface")).toBe("Future surface");
    expect(surfaceKindLabel("")).toBe("Unknown surface");
  });

  it("separates role denial from an undeployed harness", () => {
    expect(regressionAdminErrorMessage(403, "nope")).toContain("admin-only");
    expect(regressionAdminErrorMessage(404, "nope")).toContain("doesn't run");
    expect(regressionAdminErrorMessage(422, "invalid_settings")).toBe(
      "invalid_settings",
    );
  });
});
