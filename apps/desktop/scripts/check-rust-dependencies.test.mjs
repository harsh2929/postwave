import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIT_COMMAND,
  EVIDENCE_TARGET,
  SUPPORTED_TARGETS,
  collectAuditReportIssues,
  collectPatchIssues,
  collectPolicyIssues,
  collectWorkflowIssues,
  compareFindings,
  flattenAuditFindings,
  reachablePackages,
} from "./check-rust-dependencies.mjs";

const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const SHA = "a".repeat(64);
const PATCH_SHA = "b".repeat(40);

function exception(overrides = {}) {
  return {
    advisoryId: "RUSTSEC-2024-0001",
    kind: "unmaintained",
    package: "linux-only",
    version: "1.2.3",
    checksum: SHA,
    source: SOURCE,
    advisoryDate: "2024-01-02",
    advisoryUrl: "https://example.com/advisory",
    rationale:
      "This dependency is reachable only through an unsupported platform graph and is absent from every reviewed release target graph.",
    removalTrigger:
      "Remove the exception when upstream removes the dependency or before the unsupported platform becomes releasable.",
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    scanner: { name: "cargo-audit", version: "0.22.2", deny: "warnings" },
    owner: "Desktop Platform and Security Engineering",
    acceptedOn: "2026-07-15",
    lastReviewedOn: "2026-07-15",
    expiresOn: "2026-08-29",
    supportedTargets: [...SUPPORTED_TARGETS],
    evidenceTarget: EVIDENCE_TARGET,
    requiredPatch: {
      package: "tauri-utils",
      version: "2.9.3",
      source: `git+https://github.com/tauri-apps/tauri?rev=${PATCH_SHA}#${PATCH_SHA}`,
      upstreamCommit: `https://github.com/tauri-apps/tauri/commit/${PATCH_SHA}`,
      replacementDependency: { package: "urlpattern", version: "0.6.0" },
      removedPackages: [
        "unic-char-property",
        "unic-char-range",
        "unic-common",
        "unic-ucd-ident",
        "unic-ucd-version",
      ],
    },
    exceptions: [exception()],
    ...overrides,
  };
}

function auditItem(entry = exception()) {
  return {
    kind: entry.kind,
    package: {
      name: entry.package,
      version: entry.version,
      checksum: entry.checksum,
      source: entry.source,
    },
    advisory: {
      id: entry.advisoryId,
      date: entry.advisoryDate,
      url: entry.advisoryUrl,
    },
  };
}

function report(entry = exception()) {
  return {
    database: {
      "advisory-count": 100,
      "last-commit": "c".repeat(40),
      "last-updated": "2026-07-14T12:00:00Z",
    },
    lockfile: { "dependency-count": 500 },
    settings: {
      target_arch: [],
      target_os: [],
      severity: null,
      ignore: [],
      informational_warnings: ["unmaintained", "unsound", "notice"],
    },
    vulnerabilities: { found: false, count: 0, list: [] },
    warnings: { [entry.kind]: [auditItem(entry)] },
  };
}

function workflows() {
  const install = "run: cargo install cargo-audit --version 0.22.2 --locked";
  const gate = `run: ${AUDIT_COMMAND}`;
  return {
    ci: `${install}\n${gate}\nruns-on: macos-14`,
    release:
      `${install}\n${gate}\n- platform: macos-14\n- platform: windows-2022\n` +
      `rust_targets: "${SUPPORTED_TARGETS.slice(0, 2).join(",")}"\n` +
      `rust_targets: "${SUPPORTED_TARGETS[2]}"`,
  };
}

test("accepts a closed, short-lived policy", () => {
  assert.deepEqual(
    collectPolicyIssues(policy(), { today: new Date("2026-07-15T12:00:00Z") }),
    [],
  );
});

test("rejects expiry, stale review, long acceptance and schema drift", () => {
  assert.match(
    collectPolicyIssues(policy({ expiresOn: "2026-10-01", extra: true }), {
      today: new Date("2026-09-01T00:00:00Z"),
    }).join("\n"),
    /keys must be exactly/,
  );
  assert.match(
    collectPolicyIssues(policy({ expiresOn: "2026-10-01" }), {
      today: new Date("2026-09-01T00:00:00Z"),
    }).join("\n"),
    /at most 45 days|older than 30 days/,
  );
  assert.match(
    collectPolicyIssues(policy({ expiresOn: "2026-07-14" }), {
      today: new Date("2026-07-15T00:00:00Z"),
    }).join("\n"),
    /expired/,
  );
});

test("requires exact advisory, kind, package, version and checksum fingerprints", () => {
  const expected = exception();
  const actual = flattenAuditFindings(report(expected));
  assert.deepEqual(compareFindings(actual, [expected]), []);

  for (const mutation of [
    { advisoryId: "RUSTSEC-2024-9999" },
    { kind: "unsound" },
    { package: "different" },
    { version: "9.9.9" },
    { checksum: "d".repeat(64) },
    { advisoryUrl: "https://example.com/changed" },
  ]) {
    const issues = compareFindings(
      flattenAuditFindings(report(exception(mutation))),
      [expected],
    );
    assert.equal(issues.length, 2);
    assert.match(issues.join("\n"), /unexpected finding/);
    assert.match(issues.join("\n"), /stale or changed exception/);
  }
});

test("rejects a stale or suppressed cargo-audit report", () => {
  assert.deepEqual(
    collectAuditReportIssues(report(), {
      today: new Date("2026-07-15T00:00:00Z"),
    }),
    [],
  );
  const stale = report();
  stale.database["last-updated"] = "2026-06-01T00:00:00Z";
  stale.settings.ignore = ["RUSTSEC-2024-0001"];
  assert.match(
    collectAuditReportIssues(stale, {
      today: new Date("2026-07-15T00:00:00Z"),
    }).join("\n"),
    /days old.*ignored advisories/s,
  );
});

test("requires identical CI and release gates and a non-Linux release matrix", () => {
  const base = workflows();
  assert.deepEqual(collectWorkflowIssues(base), []);
  assert.match(
    collectWorkflowIssues({
      ...base,
      release: base.release.replace(
        AUDIT_COMMAND,
        "cargo audit --deny warnings --ignore X",
      ),
    }).join("\n"),
    /shared Rust dependency gate|inline cargo audit|inline advisory ignores/,
  );
  assert.match(
    collectWorkflowIssues({
      ...base,
      release: `${base.release}\n- platform: ubuntu-24.04`,
    }).join("\n"),
    /runner matrix must be exactly/,
  );
});

test("walks only normal and build dependency edges", () => {
  const metadata = {
    packages: [
      { id: "root", name: "root", version: "1" },
      { id: "normal", name: "normal", version: "1" },
      { id: "build", name: "build", version: "1" },
      { id: "dev", name: "dev", version: "1" },
    ],
    resolve: {
      root: "root",
      nodes: [
        {
          id: "root",
          deps: [
            { pkg: "normal", dep_kinds: [{ kind: null }] },
            { pkg: "build", dep_kinds: [{ kind: "build" }] },
            { pkg: "dev", dep_kinds: [{ kind: "dev" }] },
          ],
        },
        { id: "normal", deps: [] },
        { id: "build", deps: [] },
        { id: "dev", deps: [] },
      ],
    },
  };
  assert.deepEqual(
    reachablePackages(metadata)
      .map((pkg) => pkg.name)
      .sort(),
    ["build", "normal", "root"],
  );
});

test("requires the immutable Tauri patch, direct urlpattern replacement and unic removal", () => {
  const p = policy().requiredPatch;
  const tauri = {
    id: "tauri",
    name: p.package,
    version: p.version,
    source: p.source,
  };
  const url = {
    id: "url",
    name: p.replacementDependency.package,
    version: p.replacementDependency.version,
    source: SOURCE,
  };
  const metadata = {
    packages: [tauri, url],
    resolve: {
      nodes: [
        { id: tauri.id, deps: [{ pkg: url.id, dep_kinds: [{ kind: null }] }] },
        { id: url.id, deps: [] },
      ],
    },
  };
  assert.deepEqual(collectPatchIssues(metadata, p), []);
  metadata.packages.push({
    id: "unic",
    name: "unic-common",
    version: "0.9.0",
    source: SOURCE,
  });
  assert.match(
    collectPatchIssues(metadata, p).join("\n"),
    /returned to Cargo.lock/,
  );
});
