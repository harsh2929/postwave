# Desktop performance qualification

Status: executable source/renderer budgets are enforced; signed installed-app
evidence remains a release input for both supported desktop platforms.

## What is enforced in the repository

`performance-budgets.json` is the single reviewed threshold file.

- `pnpm build` fails on any `INEFFECTIVE_DYNAMIC_IMPORT` warning.
- `pnpm check:bundle-size` enforces entry, preload, CSS, total, lazy-chunk and
  named Dashboard/Subscribers/Campaigns/Analytics/Settings recursive
  JS+CSS closure, request-count, raw and gzip budgets. It also rejects emitted
  dynamic imports whose target is already in the chunk's static closure.
- `pnpm test:performance` runs the optimized renderer in Chromium, measures
  cold shell readiness, first contentful paint, long tasks, DOM nodes and JS
  heap, then repeats the four heaviest primary routes and checks p95 transition
  latency plus retained-heap growth after garbage collection. The cold DOM
  budget uses Chromium's renderer-wide counter after an explicit garbage
  collection, so it includes the connected document and genuinely retained
  detached nodes without fluctuating on unreachable parser or React
  reconciliation intermediates. The raw pre-collection counter and direct
  connected-document counts remain in the attached diagnostics.
- `pnpm test:performance-evidence` tests the installed-artifact evidence gate.

The Chromium gate is deterministic source-side regression evidence. The
renderer route-transition clock stops when the destination route shell
heading commits. It does not claim that every background data request settled;
the installed first-interaction measurement covers usable native readiness.

It is not evidence about WebKit/WebView2 process startup, native RSS, signing,
an installer, minimum-OS hardware or sustained native use.

## Installed release evidence

For every production candidate, capture one JSON record for each required
target in `performance-budgets.json`: macOS Apple Silicon, macOS Intel, and
Windows x64. The two macOS records bind to the same universal installer. Every
record must describe the same expected version and source commit and contain:

- the installer filename, SHA-256, version and full source commit;
- successful signature/notarization verification and clean-install assertions;
- OS, architecture, CPU, installed RAM and exact WebKit/WebView2 version;
- the approved minimum-hardware profile identifier and an explicit assertion
  that the host satisfies that profile;
- at least five cold launch, first-interaction and idle-RSS samples;
- at least 30 minutes of representative navigation/editing/sync activity, with
  RSS start/peak/end and crash count.

Record the measurements with the platform's release UI automation and process
instrumentation. "First interaction" means the authenticated Dashboard accepts
a keyboard or pointer action, not merely that the native process exists. Idle
RSS is sampled after Dashboard settles; sustained peak includes the native
process and its WebView child processes.

Example record shape (illustrative values only; this is not release evidence):

```json
{
  "schema_version": 1,
  "recorded_at": "2026-07-15T08:00:00.000Z",
  "artifact": {
    "file_name": "Postwave_1.2.3.dmg",
    "sha256": "<64 lowercase hex characters>",
    "version": "1.2.3",
    "commit_sha": "<full source commit>",
    "signed_and_verified": true,
    "clean_install": true,
    "signature_verification": "codesign + spctl + stapler: PASS"
  },
  "environment": {
    "platform": "macos",
    "os_version": "11.7.10",
    "minimum_supported_os": true,
    "architecture": "x86_64",
    "cpu": "model and core count",
    "hardware_profile": "approved minimum-hardware qualification host",
    "minimum_supported_hardware": true,
    "memory_mib": 8192,
    "webview_version": "WebKit build",
    "measurement_tool": "xctrace + UI automation harness"
  },
  "runs": [
    {
      "cold_launch_ms": 1800,
      "first_interaction_ms": 2300,
      "idle_rss_mib": 190
    }
  ],
  "sustained": {
    "duration_minutes": 30,
    "rss_start_mib": 190,
    "rss_peak_mib": 245,
    "rss_end_mib": 205,
    "crash_count": 0
  }
}
```

The example abbreviates `runs`; a real record needs the minimum sample count in
the budget file. Validate all three records against the exact installer bytes:

```sh
pnpm --dir apps/desktop verify:installed-performance -- \
  --evidence /evidence/postwave-macos-aarch64.json \
  --evidence /evidence/postwave-macos-x86_64.json \
  --artifact macos=/artifacts/Postwave_1.2.3.dmg \
  --evidence /evidence/postwave-windows-x86_64.json \
  --artifact windows=/artifacts/Postwave_1.2.3_x64-setup.exe \
  --expected-version 1.2.3 \
  --expected-commit '<full release commit>' \
  --require-all-targets
```

The command fails for missing targets, unsupported/missing architectures, a
digest/filename mismatch, unsigned or non-clean-install records, minimum-OS or
minimum-hardware-profile gaps, too few runs, too-short soak, a crash, or any
p95/RSS threshold overrun. Mixed version/commit evidence and evidence that does
not match the expected release identity also fail. Sustained growth is retained
growth (`end - start`); the separate peak budget governs transient growth during
the soak. Retain the three JSON files, command log, raw platform traces and
installer digests with the release provenance bundle.
