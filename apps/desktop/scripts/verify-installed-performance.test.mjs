import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import budgets from "../performance-budgets.json" with { type: "json" };
import {
  PerformanceEvidenceError,
  validateInstalledPerformanceEvidence,
  verifyInstalledPerformanceEvidenceSet,
} from "./verify-installed-performance.mjs";

let directory;
let artifactPath;
let artifactDigest;
let windowsArtifactPath;
let windowsArtifactDigest;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "postwave-desktop-performance-"));
  artifactPath = join(directory, "Postwave_1.2.3.dmg");
  const bytes = Buffer.from("signed-test-installer");
  writeFileSync(artifactPath, bytes);
  artifactDigest = createHash("sha256").update(bytes).digest("hex");
  windowsArtifactPath = join(directory, "Postwave_1.2.3_x64-setup.exe");
  const windowsBytes = Buffer.from("signed-test-windows-installer");
  writeFileSync(windowsArtifactPath, windowsBytes);
  windowsArtifactDigest = createHash("sha256")
    .update(windowsBytes)
    .digest("hex");
});

after(() => rmSync(directory, { recursive: true, force: true }));

function evidence(platform = "macos", architecture = "x86_64") {
  const windows = platform === "windows";
  return {
    schema_version: 1,
    recorded_at: "2026-07-15T08:00:00.000Z",
    artifact: {
      file_name: windows
        ? "Postwave_1.2.3_x64-setup.exe"
        : "Postwave_1.2.3.dmg",
      sha256: windows ? windowsArtifactDigest : artifactDigest,
      version: "1.2.3",
      commit_sha: "a".repeat(40),
      signed_and_verified: true,
      clean_install: true,
      signature_verification: windows
        ? "signtool verify /pa: PASS"
        : "codesign + spctl + stapler: PASS",
    },
    environment: {
      platform,
      os_version: platform === "macos" ? "11.7.10" : "10.0.19045",
      minimum_supported_os: true,
      architecture,
      cpu: "representative test CPU",
      hardware_profile: "approved minimum-hardware qualification host",
      minimum_supported_hardware: true,
      memory_mib: 8192,
      webview_version: platform === "macos" ? "WebKit 16.2" : "WebView2 111",
      measurement_tool: platform === "macos" ? "xctrace" : "WPR",
    },
    runs: Array.from({ length: 5 }, (_, index) => ({
      cold_launch_ms: 1800 + index * 20,
      first_interaction_ms: 2200 + index * 20,
      idle_rss_mib: 180 + index,
    })),
    sustained: {
      duration_minutes: 30,
      rss_start_mib: 180,
      rss_peak_mib: 230,
      rss_end_mib: 195,
      crash_count: 0,
    },
  };
}

describe("installed desktop performance evidence", () => {
  it("accepts signed, digest-bound measurements within every budget", () => {
    const summary = validateInstalledPerformanceEvidence(
      evidence(),
      budgets,
      artifactPath,
    );
    assert.equal(summary.platform, "macos");
    assert.equal(summary.runCount, 5);
    assert.equal(summary.coldLaunchP95Ms, 1880);
    assert.equal(summary.sustainedRssGrowthMiB, 15);
  });

  it("rejects evidence that is not bound to the supplied artifact", () => {
    const record = evidence();
    record.artifact.sha256 = "b".repeat(64);
    assert.throws(
      () => validateInstalledPerformanceEvidence(record, budgets, artifactPath),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("artifact digest mismatch"),
    );
  });

  it("rejects unqualified OS/hardware profiles and unsupported architectures", () => {
    const record = evidence();
    record.environment.minimum_supported_os = false;
    record.environment.minimum_supported_hardware = false;
    record.environment.hardware_profile = "";
    record.environment.architecture = "arm64";
    record.artifact.clean_install = false;
    record.recorded_at = "July 15, 2026 08:00:00 UTC";
    assert.throws(
      () => validateInstalledPerformanceEvidence(record, budgets, artifactPath),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("minimum_supported_os") &&
        error.message.includes("minimum_supported_hardware") &&
        error.message.includes("hardware_profile") &&
        error.message.includes("macos/arm64") &&
        error.message.includes("canonical ISO-8601") &&
        error.message.includes("clean_install"),
    );
  });

  it("rejects a web runtime below the renderer capability floor", () => {
    const macos = evidence();
    macos.environment.webview_version = "WebKit 14";
    assert.throws(
      () => validateInstalledPerformanceEvidence(macos, budgets, artifactPath),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("webview_version must be 16.2+ for macos"),
    );

    const windows = evidence("windows", "x86_64");
    windows.environment.webview_version = "WebView2 109";
    assert.throws(
      () =>
        validateInstalledPerformanceEvidence(
          windows,
          budgets,
          windowsArtifactPath,
        ),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("webview_version must be 111+ for windows"),
    );
  });

  it("rejects p95, sustained growth and crash budget overruns", () => {
    const record = evidence();
    record.runs[4].cold_launch_ms = budgets.installed.coldLaunchP95Ms + 1;
    record.sustained.rss_end_mib =
      record.sustained.rss_start_mib +
      budgets.installed.sustainedRssGrowthMiB +
      1;
    record.sustained.rss_peak_mib = record.sustained.rss_end_mib;
    record.sustained.crash_count = 1;
    assert.throws(
      () => validateInstalledPerformanceEvidence(record, budgets, artifactPath),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("coldLaunchP95Ms") &&
        error.message.includes("sustainedRssGrowthMiB") &&
        error.message.includes("crashCount"),
    );
  });

  it("requires every supported platform/architecture target", () => {
    const qualification = {
      requireAllTargets: true,
      expectedVersion: "1.2.3",
      expectedCommit: "a".repeat(40),
    };
    assert.throws(
      () =>
        verifyInstalledPerformanceEvidenceSet(
          [{ evidence: evidence("macos"), artifactPath }],
          budgets,
          qualification,
        ),
      /missing installed performance evidence for targets: macos\/aarch64, windows\/x86_64/,
    );

    const summaries = verifyInstalledPerformanceEvidenceSet(
      [
        {
          evidence: evidence("macos", "aarch64"),
          artifactPath,
        },
        { evidence: evidence("macos"), artifactPath },
        {
          evidence: evidence("windows"),
          artifactPath: windowsArtifactPath,
        },
      ],
      budgets,
      qualification,
    );
    assert.deepEqual(
      summaries.map((summary) => `${summary.platform}/${summary.architecture}`),
      ["macos/aarch64", "macos/x86_64", "windows/x86_64"],
    );
  });

  it("rejects mixed releases and an unexpected release identity", () => {
    const wrongRelease = evidence("windows");
    wrongRelease.artifact.version = "1.2.4";
    wrongRelease.artifact.commit_sha = "b".repeat(40);
    assert.throws(
      () =>
        verifyInstalledPerformanceEvidenceSet(
          [
            { evidence: evidence("macos"), artifactPath },
            { evidence: wrongRelease, artifactPath: windowsArtifactPath },
          ],
          budgets,
        ),
      /mixed release evidence/,
    );

    assert.throws(
      () =>
        verifyInstalledPerformanceEvidenceSet(
          [{ evidence: evidence("macos"), artifactPath }],
          budgets,
          { expectedVersion: "9.9.9", expectedCommit: "c".repeat(40) },
        ),
      /does not match expected/,
    );
  });

  it("fails closed when the installed budget schema is malformed", () => {
    const malformed = structuredClone(budgets);
    malformed.installed.minimumRuns = 0;
    delete malformed.installed.coldLaunchP95Ms;
    malformed.installed.requiredTargets.push(
      structuredClone(malformed.installed.requiredTargets[0]),
    );
    assert.throws(
      () =>
        validateInstalledPerformanceEvidence(
          evidence(),
          malformed,
          artifactPath,
        ),
      (error) =>
        error instanceof PerformanceEvidenceError &&
        error.message.includes("minimumRuns") &&
        error.message.includes("coldLaunchP95Ms") &&
        error.message.includes("duplicate installed target"),
    );
  });
});
