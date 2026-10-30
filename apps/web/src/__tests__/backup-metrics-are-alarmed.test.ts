// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup pipeline publishes CloudWatch metrics from shell scripts and
// alarms on them from CloudFormation. Nothing connected the two, so a metric
// could be published forever with no alarm reading it — a monitor that runs,
// costs money, and tells nobody.
//
// That had happened. `BaseBackupHealthy` and `LogicalBackupHealthy` were both
// published — including a `0` from each script's EXIT trap within seconds of a
// failed run — while only their sibling `WalIntegrityHealthy` was wired to the
// alarm topic. The failure was still caught eventually, via the
// `*AgeSeconds` staleness alarms, but only once the age crossed its window
// hours later. For backups the delay IS the risk: every hour between "it broke"
// and "we noticed" is unaccounted-for RPO.
//
// This is checked from apps/web because that is the enforced gate; infra/ has
// no test runner. It reads the shell and the YAML as text rather than executing
// anything.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BACKUP_DIR = resolve(process.cwd(), "../../infra/backup");
const IMAGE_DIR = join(BACKUP_DIR, "image");

/**
 * Metrics published but deliberately NOT alarmed, each with the reason.
 *
 * An entry here is a decision, not an exemption to reach for: it says the
 * metric is a diagnostic read while investigating, and that some OTHER alarmed
 * metric covers the failure it would indicate.
 */
const INFORMATIONAL: Record<string, string> = {
  BaseBackupDurationSeconds:
    "how long a run took; a run that failed is covered by BaseBackupHealthy, one that never ran by BaseBackupAgeSeconds",
  LogicalBackupDurationSeconds:
    "as above, for the pg_dump path",
  BaseBackupEvidenceSignatures:
    "count of evidence signatures produced; the signer's own health is EvidenceSignerSuccess, which is alarmed",
};

function publishedMetrics(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(IMAGE_DIR)) {
    if (!file.endsWith(".sh")) continue;
    const src = readFileSync(join(IMAGE_DIR, file), "utf8");
    for (const m of src.matchAll(
      /\bput_metric(?:_best_effort)?\s+([A-Za-z][A-Za-z0-9]*)/g,
    )) {
      // The helper definitions in common.sh call `put_metric "$@"` — skip the
      // shell-variable form, which is not a metric name.
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

function alarmedMetrics(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(BACKUP_DIR)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const src = readFileSync(join(BACKUP_DIR, file), "utf8");
    for (const m of src.matchAll(/MetricName:\s*([A-Za-z][A-Za-z0-9]*)/g)) {
      names.add(m[1]!);
    }
  }
  return [...names].sort();
}

describe("every backup metric is either alarmed or explicitly informational", () => {
  it("reads both sides", () => {
    // Guard the guard: a wrong directory yields two empty sets, and an empty
    // set is trivially a subset of anything.
    expect(existsSync(IMAGE_DIR), `missing ${IMAGE_DIR}`).toBe(true);
    expect(publishedMetrics().length).toBeGreaterThan(8);
    expect(alarmedMetrics().length).toBeGreaterThan(8);
  });

  it("alarms on every published metric that is not marked informational", () => {
    const alarmed = new Set(alarmedMetrics());
    const unwatched = publishedMetrics().filter(
      (name) => !alarmed.has(name) && !(name in INFORMATIONAL),
    );
    expect(
      unwatched,
      "published to CloudWatch with no alarm reading it — a monitor that tells nobody",
    ).toEqual([]);
  });

  it("keeps the informational list honest", () => {
    // An entry that IS alarmed, or that nothing publishes any more, is stale
    // reasoning. Either way the comment beside it has stopped being true.
    const published = new Set(publishedMetrics());
    const alarmed = new Set(alarmedMetrics());
    for (const [name, reason] of Object.entries(INFORMATIONAL)) {
      expect(published.has(name), `${name} is exempted but nothing publishes it`).toBe(
        true,
      );
      expect(alarmed.has(name), `${name} is exempted but IS alarmed`).toBe(false);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });

  it("holds the three health booleans to an alarm apiece", () => {
    // Stated separately because these are the ones that were wrong, and
    // because a health boolean is the fastest signal the pipeline produces —
    // published by the EXIT trap, seconds after a failure, rather than waiting
    // for a staleness window to expire.
    const alarmed = new Set(alarmedMetrics());
    for (const metric of [
      "BaseBackupHealthy",
      "LogicalBackupHealthy",
      "WalIntegrityHealthy",
    ]) {
      expect(alarmed.has(metric), `${metric} has no alarm`).toBe(true);
    }
  });
});
