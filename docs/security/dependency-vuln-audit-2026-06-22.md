<!-- Generated 2026-06-22 by osv-scanner 1.9.2 + govulncheck v1.4.0 + pnpm audit. Raw scan data: /tmp/pwscan/ (ephemeral). Regenerate via the scanners in §6. -->

# Moosewave Monorepo — Dependency Vulnerability Audit

**Date:** 2026-06-22 · **Lead:** Security Engineering · **Scanners:** osv-scanner 1.9.2 (lockfile match), govulncheck v1.4.0 (Go symbol-level reachability), pnpm audit (GitHub Advisory DB), cargo/RUSTSEC cross-check
**Scope:** npm (pnpm workspace), Go (10 modules), Rust (Tauri v2 desktop), Python SDK, PHP SDK

> Historical snapshot: scanner behavior and findings below describe the
> 2026-06-22 run. Current JavaScript exception policy lives in
> `config/dependency-risk-register.json` and
> `docs/security/dependency-risk-governance.md`. In particular, root
> `pnpm.auditConfig` ignores were removed on 2026-07-14; do not copy the old
> suppression approach from this record.
> Rust closure was updated on 2026-07-15: current policy and executable target
> proof live in `docs/security/dependency-risk-governance.md` and
> `apps/desktop/scripts/check-rust-dependencies.mjs`. Historical Rust counts
> below are retained only as the original scan record.

---

## 0. Remediation Applied (2026-06-22)

**Round 1 — npm overrides + Go libraries** (root workspace **35 → 5** advisories; **0 critical, 0 high**):

- **npm root `pnpm.overrides`** — fixed 3 stale pins (`protobufjs`→`<7.6.3:7.6.3`, `vite`→`<8.0.16:8.0.16`, `ws`→`<8.21.0:8.21.0`) and added `ws@<7.5.11:7.5.11`, `shell-quote@<1.8.4:1.8.4`, `@xmldom/xmldom@<0.8.13:0.8.13`, `hono@<4.12.25:4.12.25`, `dompurify@<3.4.11:3.4.11`, `markdown-it@<14.2.0:14.2.0`, `js-yaml@<3.15.0:3.15.0`, and `js-yaml@>=4 <4.2.0:4.2.0`. Root `pnpm-lock.yaml` regenerated; `--frozen-lockfile` passes (CI-safe). All old vulnerable versions = 0 occurrences; `next-intl`→4.12.0.
- **Go libraries** — `go-redis v9.7.0→v9.7.3` (services/automation), `golang-jwt/jwt/v5 v5.2.1→v5.2.2` (apps/api). Build + vet clean; osv re-scan confirms both gone.

**Round 2 — the deferred items** (all applied + verified):

- **Go toolchain 1.25 → 1.26.4** — set `toolchain go1.26.4` on `go.work` (governs workspace builds) + all 10 module go.mod files; `Dockerfile.go` base image → `golang:1.26.4-alpine@sha256:3ad57304…`; CI go pins (ci.yml ×3, test.yml, e2e.yml, openapi-check.yml) → `1.26.4` (codeql/govulncheck read go.mod → auto). **Verified:** all 10 modules build with go1.26.4; **govulncheck symbol-level = 0 reachable vulns across every module, including apps/api** (the 1.26.4 toolchain also resolved the earlier symbol-scan panic — coverage gap CLOSED). Note: `go` directive left at 1.25.0 deliberately (avoids GODEBUG/semantic changes that can't be test-verified here); the **toolchain** is what compiles in the patched stdlib. osv-scanner (reads the `go` directive) will still *list* stdlib advisories, but they are proven non-reachable and binaries ship patched 1.26.4 stdlib.
- **`@opentelemetry/core`** — scoped override `@opentelemetry/core@>=2.0.0 <2.8.0: 2.8.0` clears the 2.x exposure (2.2.0/2.7.1 → 2.8.0); install + frozen-lockfile clean, no otel/Sentry conflict. **Residual:** `@opentelemetry/core@1.30.1` (pulled by `@sentry/node@8.55.2`'s `@opentelemetry/instrumentation-*` packages) remains flagged by the `<2.8.0` GHSA range; the otel-1.x line has no patch and force-upgrading it to 2.x would break Sentry 8's instrumentation. Real fix = **Sentry 8→10 major upgrade** (touches `sentry.*.config.ts`) — tracked as its own runtime-tested PR.
- **Nested `apps/web` / `apps/desktop` lockfiles** — confirmed **vestigial** (web Dockerfile copies the *root* lock; desktop release + visual-regression install from root; pnpm workspace-mode always uses the root lock regardless of cwd — no build consumes the nested locks). **Removed both.**

**Round 3 — full closure** (everything remaining addressed; repo is push-ready):

- **Sentry 8 → 10** (`apps/web` `@sentry/nextjs` + `@sentry/core` → `^10`, `apps/desktop` `@sentry/react` → `^10`; dropped the v9-removed `hideSourceMaps` in `next.config.mjs` for `sourcemaps.deleteSourcemapsAfterUpload`). This pulls `@opentelemetry/core ^2.6.1`, so the **otel-1.x residual is GONE** — `@opentelemetry/core` now resolves to **only 2.8.0** (1.30.1/2.2.0/2.7.1 = 0 occurrences). **Verified:** `apps/web` `next build` EXIT 0 ("Compiled successfully", full static/SSG/dynamic generation); `apps/desktop` has 0 Sentry/otel type errors. (Sentry API surface used — `init`/`captureException`/`captureRequestError`/`ErrorBoundary` — is unchanged across v8→v10.)
- **npm low/moderate (updated 2026-07-14)** — `esbuild` and `@babel/core` are fixed; both `js-yaml` major lines are patched through scoped overrides. MJML was upgraded to stable 5.4.0 after a registry check showed pnpm's `review` action understated fix availability. Root `pnpm.auditConfig` is gone, the machine-readable register is empty, and raw production pnpm audit exits **0**.
- **grapesjs** `GHSA-589f-c66p-hxr4` / CVE-2022-21802 — **FALSE POSITIVE** (osv range malformed: `introduced:0`, no `fixed` event; actually patched in 0.19.5, we run 0.21.13; GitHub DB / pnpm audit don't flag it). Documented + suppressed in `osv-scanner.toml`.
- **Rust/Tauri (updated 2026-07-15)** — Tauri is current at 2.11.5. A focused immutable upstream `tauri-utils` patch upgrades `urlpattern` 0.3→0.6 and removes all five reachable `unic-*` advisories. The 13 residual GTK3/netlink findings are absent from every supported macOS/Windows graph and governed by an exact, expiring machine-readable policy rather than `audit.toml` or a workflow-level ignore.
- **Python/PHP SDK coverage** — added `pip` (`/packages/sdk-py`) + `composer` (`/packages/sdk-php`) ecosystems to `.github/dependabot.yml` (now 5 ecosystems). Best-effort scan of the Python deps (`httpx ^0.27`, `pydantic ^2.5`) = no known CVEs; PHP SDK declares zero third-party runtime deps.

**Current npm scanner state (updated 2026-07-14):** raw production pnpm audit exits 0 with zero advisories; `pnpm audit:js` independently validates the complete report and rejects every unregistered or stale exception. The remaining text in this document is historical evidence, not the current gate contract.

---

## 1. Executive Summary

Overall posture is **GOOD with two concrete, cheap actions required**. The headline number — 1 critical / 11 high (npm) plus a large Go/Rust advisory count — collapses sharply under reachability analysis: **the npm critical/high cluster is entirely transitive dev/build tooling** (Expo/React-Native/Metro/Vite) that never ships in any production bundle, and **all 19 Rust RUSTSEC advisories are unmaintained-crate warnings or Linux-only GTK code that is not compiled into the shipped macOS/Windows desktop binaries.**

The two highest-leverage fixes are:

1. **Bump the Go build toolchain to 1.26.4.** A single change clears every CALLED stdlib vulnerability (HTTP/2 SETTINGS loop, two `html/template` XSS, x509, net panic) across 8 production Go services in one move. This is the only finding set with confirmed runtime reachability on internet-facing code.
2. **Repair three stale pnpm overrides that pin to versions that are *themselves* still vulnerable** — and one (`vite`) that actively dragged the dependency *into* a vulnerable range. This is a self-inflicted false-comfort bug verified directly in root `package.json`.

The former residual npm item, **mjml** (CVE-2025-67898), is fixed in the current tree by pinning both direct importers to stable 5.4.0 and qualifying its asynchronous compiler contract.

---

## 2. Severity Scorecard

Counts reflect distinct findings after de-duplication, tiered by *real* exposure (not raw advisory count). Go stdlib is counted as **2 findings** (sibling modules where CALLED is confirmed; apps/api where it is UNKNOWN) covering ~11 advisory IDs.

| Ecosystem | Critical | High | Moderate | Low / Info | Tier split |
|---|---|---|---|---|---|
| npm — critical/high cluster | 1 (`shell-quote`) | 5 | — | — | 1 fix-now (`protobufjs`), 5 fix-soon |
| npm — moderate/low | — | — | 7 | 2 low | 5 fix-soon, 1 monitor (`mjml`), 2 monitor (babel/esbuild) |
| Go (stdlib + 3rd-party) | — | 2 (stdlib sets) | 2 (`go-redis`, `golang-jwt`) | 3 (chi, x/crypto, x/net) | 3 fix-now, 1 fix-soon, 3 monitor |
| Rust (Tauri v2 desktop) | — | — | — | 19 (1 low soundness `glib`, 18 info) | 19 monitor |
| Python SDK | — | — | — | 5 info | 5 monitor (coverage gap) |
| PHP SDK | — | — | — | 4 info | 4 monitor (coverage gap) |

**Raw scanner counts (ground truth):** npm root = 1 critical / 11 high / 23 moderate / 5 low; npm apps/desktop = 18; npm apps/web = 4; Rust = 19 RUSTSEC; Go = ~6–8 CALLED per service (predominantly stdlib → toolchain bump).

**Triage tiers (de-duplicated):** **Fix Now: 4** · **Fix Soon: 11** · **Monitor: 30**

---

## 3. Fix Now — runtime-exposed criticals/highs

These have a genuine production-runtime path (or, for Go, confirmed CALLED reachability on internet-facing services). Do these first.

### 3.1 Go stdlib (toolchain) — 8 production services · **CALLED, confirmed reachable**
- **Advisories:** GO-2026-4918 (HTTP/2 SETTINGS loop), GO-2026-4980 / 4982 (`html/template` XSS, CALLED in automation/deliverability/migration/voice), GO-2026-5038 / 4986 (CALLED in deliverability), GO-2026-4971 / 5037 / 5039 (x509, net/textproto, net panic) + imported-only 4976/4977/4981.
- **Affected:** packages/{kms,migrate,runtime,secrets}, services/{automation,deliverability,migration,voice}.
- **Current → Fix:** Go 1.25.x → **Go 1.26.4** (1.26.3 fixes 4918/4971/4976/4977/4980/4981/4982/4986; 1.26.4 adds 5037/5038/5039).
- **Remediation (verified wiring):** `Dockerfile.go` uses `FROM golang:1.25-alpine@sha256:8d22e29d...` with `GOTOOLCHAIN=local` — a go.mod `toolchain` directive alone will **NOT** auto-download 1.26.4; the base image must actually ship it.
  1. `Dockerfile.go`: `FROM golang:1.26.4-alpine@sha256:<new-digest>` (re-pin digest).
  2. Every module: `go mod edit -toolchain=go1.26.4`.
  3. CI: workflows using `go-version-file: apps/api/go.mod` auto-pick up the bump; raise literal pins in `ci.yml` (1.23), `test.yml`/`e2e.yml` (1.24), `openapi-check.yml` (1.23) to 1.26.4.

### 3.2 Go stdlib (toolchain) — apps/api · **IMPORTED, reachability UNKNOWN (treated fix-now)**
- **Advisories:** same 11 stdlib IDs as 3.1, confirmed IMPORTED.
- **Why fix-now despite UNKNOWN:** apps/api is the primary internet-facing chi HTTP server; its govulncheck **symbol-scan PANICKED** (Go 1.26 generics + x/tools bug → package-mode fallback), so CALLED-status could not be computed. Identical stdlib usage to sibling modules where these are CALLED ⇒ assume reachable. **The same single 1.26.4 toolchain bump fixes all of them regardless of reachability** (go.mod confirmed `go 1.25.0`).

### 3.3 `github.com/redis/go-redis/v9` — services/automation · **CALLED**
- **Advisory:** GO-2025-3540 / CVE-2025-29923 (out-of-order response on connection establishment, via asynq's redis client).
- **Current → Fix:** v9.7.0 → **v9.7.3** (indirect, pulled via `hibiken/asynq@v0.25.1`).
- **Command:** `cd services/automation && go get github.com/redis/go-redis/v9@v9.7.3 && go mod tidy` then `go test ./...`.

### 3.4 `protobufjs` — apps/web (+ apps/desktop) · **prod-runtime path, exploit unproven** · STALE-OVERRIDE BUG
- **Advisory:** CVE-2026-48712 (unbounded Any-expansion DoS during protobuf→JSON). Source: `@opentelemetry/otlp-transformer` ← `@sentry/opentelemetry@8.55.2` — loaded in the production Next.js server runtime.
- **The bug (verified in root `package.json`):** override is `"protobufjs@<7.5.8": "7.5.8"`, but the CVE is patched only in **>=7.6.1**, so 7.5.8 is *still vulnerable* — the override gives false comfort. apps/desktop independently resolves 7.5.7 (also vulnerable).
- **Fix:** change override to **`"protobufjs@<7.6.3": "7.6.3"`** (7.6.3 also clears moderate CVE-2026-54269 property-shadowing). Re-run `pnpm install -w` AND `pnpm --filter postwave-desktop-shell install` (separate lockfile pins 7.5.7).
- **Honesty note:** the DoS triggers on protobuf→JSON of *inbound* Any messages; OTel here serializes our *own outbound* spans, so a hostile trigger is not obvious (reachability rated **unknown/low**). Fixed-now on prod-path + cheap-override grounds, **not** proven exploitability.

---

## 4. Fix Soon — build/dev-tooling highs + notable moderates

Real advisories, but exposure is build-time/dev-only or behind admin-authored input. Batch these into the next dependency-refresh PR.

### 4.1 npm critical/high cluster — all transitive dev/build tooling (not in any prod bundle)

| Package | Severity | CVE(s) | Current → Fix | Source / why not prod | Action |
|---|---|---|---|---|---|
| `shell-quote` | **critical** | CVE-2026-9277 | 1.8.3 → **1.8.4** | `react-devtools-core` (RN/Expo DevTools); the "apps/web" tag is root-hoisting noise | Add `"shell-quote@<1.8.4": "1.8.4"` |
| `@xmldom/xmldom` | high | CVE-2026-41672/73/74/75, 34601 | 0.7.13 → **0.8.13** | `@expo/plist@0.0.18` (build-machine plist gen, never bundled) | Add `"@xmldom/xmldom@<0.8.13": "0.8.13"`; verify `expo prebuild` still parses plist |
| `hono` | high | CVE-2026-54290 | 4.12.18 → **4.12.25** | `@modelcontextprotocol/sdk@1.29.0`; **PROVEN UNREACHABLE** — our MCP transport uses raw `node:http` + bearer auth, **never** calls `hono.cors()` | Add `"hono@<4.12.25": "4.12.25"` (also clears 8 moderate hono CVEs) |
| `vite` | high | CVE-2026-53571, 53632 | override forces **8.0.10** / per-app 5.4.21 → **8.0.16** | Dev-server-only, Windows `fs.deny` bypass + launch-editor NTLM | **STALE-OVERRIDE FIX** (see below) |
| `ws` | high | CVE-2026-48779 | override **8.20.1** + 7.5.10 → **8.21.0** / **7.5.11** | `@expo/cli` (8.x) + `react-devtools-core` (7.x); localhost dev servers only | **STALE-OVERRIDE FIX** (see below) |

> **STALE-OVERRIDE BUGS — confirmed in root `package.json`:**
> - **`vite`**: current override is `"vite@<=6.4.1": "8.0.10"`. CVE-2026-53571 affects **8.0.0–8.0.15**, so the override forced vite *from a safe 5.4.21 line INTO a vulnerable 8.x point release*. Per-app lockfiles (desktop/web/audit-portal) independently resolve 5.4.21. Change to **`"vite@<8.0.16": "8.0.16"`**. If any app must stay on vite 5.x, use a targeted per-range override instead.
> - **`ws`**: current override is `"ws@>=8.0.0 <8.20.1": "8.20.1"`. CVE-2026-48779 is patched in **8.21.0**, so 8.20.1 is one version short. Change to **`"ws@>=8.0.0 <8.21.0": "8.21.0"`** and **add** `"ws@>=7.0.0 <7.5.11": "7.5.11"`.

### 4.2 npm moderate — runtime-reachable parsers/sanitizers (override or lock-refresh)

| Package | CVE(s) | Current → Fix | Source / reachability | Action |
|---|---|---|---|---|
| `dompurify` | GHSA-76mc-f452-cxcm, CVE-2026-49458/59/978 (+3 low) | 3.4.2 → **>=3.4.11** | `mermaid` / `posthog-js` / `redoc` (analytics path most clearly prod); not the IN_PLACE usage the residual no-fix advisories require | `"dompurify": ">=3.4.11"` |
| `markdown-it` | CVE-2026-48988 | 14.1.1 → **>=14.2.0** | `prosemirror-markdown` (grapesjs editor); reachable only on untrusted markdown at scale — admin-authored content lowers risk | `"markdown-it": ">=14.2.0"` |
| `@opentelemetry/core` | CVE-2026-54285 | 2.2.0/2.7.1 → **>=2.8.0** | Sentry instrumentation; W3C Baggage memory alloc on inbound headers. **Verify Sentry SDK 8.55.2 compat — a Sentry bump may be cleaner** | `"@opentelemetry/core": ">=2.8.0"` |
| `js-yaml` | CVE-2026-53550 | 3.14.2 → **3.15.0**; 4.1.1 → **4.2.0** | Scoped overrides preserve both major-line APIs while fixing the vulnerable versions. | `"js-yaml@<3.15.0": "3.15.0"` and `"js-yaml@>=4 <4.2.0": "4.2.0"` (completed) |
| `next-intl` | GHSA-4c35-wcg5-mm9h, 8f24-v5vv-gm5j | lock pins 3.26.5 → **4.12.0** | **STALE LOCK** — `apps/web/package.json` already declares `^4.12.0` | **Lock refresh only**, no override |
| `postcss` | GHSA-qx2v-qp2m-jg93 | lock pins 8.4.31 → **8.4.47** | Build-time CSS DoS. Note: root already has `"postcss@<8.5.10": "8.5.10"` — a lock refresh + the existing root override both resolve this | **Lock refresh** (root override already covers) |

### 4.3 Go third-party — `golang-jwt` (fix-soon)
- **`github.com/golang-jwt/jwt/v5`** — apps/api, GO-2025-3553 / CVE-2025-30204 (header-parsing memory-alloc DoS). v5.2.1 → **v5.2.2** (indirect). Reachability UNKNOWN (apps/api symbol-scan panicked). Cheap patch bump — do it alongside the toolchain work: `cd apps/api && go get github.com/golang-jwt/jwt/v5@v5.2.2 && go mod tidy`.

---

## 5. Monitor / Accepted Risk

### 5.1 mjml — resolved 2026-07-14
- **CVE-2025-67898 / GHSA-45h5-66jx-r2wf** (`mj-include` directory traversal) affected 4.18.0. Both direct importers now pin stable 5.4.0.
- The upgrade's asynchronous compiler contract is propagated through `@postwave/email-react` and the CLI. Web and package boundary tests pass.
- Defense in depth remains: both caller-facing compiler paths reject `mj-include` and disable include/config resolution.

### 5.2 npm low — Windows/dev-server build-time only
- **`@babel/core`** 7.29.0 → 7.29.6 (CVE-2026-49356, sourceMappingURL file-read, build-time transform only) — optional, fold into routine refresh.
- **`esbuild`** 0.27.7 (+ 0.21.5 in desktop) → 0.28.1 (GHSA-g7r4-m6w7-qqqr, Windows dev-server only) — note root already overrides `esbuild@<=0.24.2` → 0.27.7; bump optional.

### 5.3 Rust / Tauri v2 desktop — reachable chain closed; 13 target-excluded lockfile findings
The desktop app is **Tauri v2 (2.11.5)** and ships **macOS (universal) + Windows (x86_64) only — no Linux target**.
- **Reachable `unic-*` chain resolved:** Tauri's focused upstream commit `dd725f4b13c30a86b398ccc59eb498f151f461c5` upgrades `tauri-utils` from `urlpattern` 0.3 to 0.6. All five `unic-*` crates and advisories are absent from the lockfile and supported graphs.
- **GTK3/netlink residual:** 13 findings remain in the shared cross-platform lockfile. Filtered Cargo metadata proves all 13 absent from both macOS architecture graphs and Windows x64, and present in the unsupported Linux evidence graph. This includes the genuine `glib` RUSTSEC-2024-0429 soundness finding.
- **Fail-closed action:** `pnpm --dir apps/desktop check:rust-dependencies` runs raw `cargo audit --deny warnings`, exact-matches every residual advisory/package/checksum, enforces review and expiry, recomputes all target graphs, and rejects workflow-level ignores. The policy expires 2026-08-29. Adding Linux support is prohibited until these findings are removed.

### 5.4 Go — not-reachable hygiene bumps
- **`go-chi/chi/v5`** v5.1.0 → v5.2.2 (GHSA-vrw8-fxc6-2r93) — absent from govulncheck output entirely; host-routing path not exercised. Currency, not urgency.
- **`golang.org/x/crypto`** v0.51.0 → v0.52.0 — all 13 advisories are in `ssh/*`; repo-wide grep returns **zero** `x/crypto/ssh` imports. Not compiled. Hygiene only.
- **`golang.org/x/net`** — **no x/net *package* CVE in scan**; the HTTP/2 loop is the stdlib bundled copy (fixed by the toolchain bump). No action.

### 5.5 Python / PHP SDKs — coverage gap, no confirmed CVE
All findings are `info` / reachable=`unknown` — the issue is **coverage, not a known vuln**. See §7.

---

## 6. Remediation Playbook

### 6.1 npm — root `pnpm.overrides` (edit `<repo>/package.json`)

Update the three **stale** pins and add the new ones. Existing block already contains `esbuild`, `vite@<=6.4.1`, `ws@>=8.0.0 <8.20.1`, `postcss@<8.5.10`, `protobufjs@<7.5.8` — replace/extend as marked:

```jsonc
"pnpm": {
  "overrides": {
    // --- FIX STALE PINS (these currently pin to still-vulnerable versions) ---
    "protobufjs@<7.6.3": "7.6.3",        // was <7.5.8 -> 7.5.8 (still hit by CVE-2026-48712)
    "vite@<8.0.16": "8.0.16",            // was <=6.4.1 -> 8.0.10 (INSIDE CVE-2026-53571 range)
    "ws@>=8.0.0 <8.21.0": "8.21.0",      // was <8.20.1 -> 8.20.1 (one short of CVE-2026-48779)
    // --- ADD ---
    "ws@>=7.0.0 <7.5.11": "7.5.11",      // react-devtools-core ws@7.5.10
    "shell-quote@<1.8.4": "1.8.4",       // CVE-2026-9277 (critical)
    "@xmldom/xmldom@<0.8.13": "0.8.13",  // 5 xmldom highs
    "hono@<4.12.25": "4.12.25",          // CORS high + 8 moderate hono CVEs
    "dompurify": ">=3.4.11",
    "markdown-it": ">=14.2.0",
    "js-yaml@<3.15.0": "3.15.0",
    "js-yaml@>=4 <4.2.0": "4.2.0",
    "@opentelemetry/core": ">=2.8.0"
    // (existing: esbuild, underscore, postcss, uuid, rollup, mermaid, js-cookie, html-minifier, qs, turbo)
  }
}
```

```bash
# 1) Refresh the STALE apps/web lock (clears next-intl ->4.12 and postcss ->8.4.47 with no override):
pnpm install --filter @postwave/web --lockfile-only && pnpm install
# 2) Apply overrides + regenerate root lock:
pnpm install -w
# 3) apps/desktop has its OWN lockfile pinning protobufjs@7.5.7 + vite@5.4.21 — refresh it:
pnpm --filter postwave-desktop-shell install
# 4) Verify no peer-dep conflicts (xmldom 0.7->0.8, hono ^4 vs MCP SDK, scoped js-yaml overrides, Sentry vs OTel core 2.8):
pnpm --filter @postwave/web --filter @postwave/desktop why @opentelemetry/core
# 5) Re-scan:
pnpm -w audit --audit-level moderate   # + re-run osv-scanner over each lockfile
```

### 6.2 Go — toolchain bump + targeted go gets

```bash
# PRIMARY: bump toolchain to 1.26.4 (clears all CALLED + imported stdlib vulns)
# Dockerfile.go: FROM golang:1.26.4-alpine@sha256:<new-digest>  (GOTOOLCHAIN=local => base image MUST ship 1.26.4)
for d in apps/api packages/kms packages/migrate packages/runtime packages/secrets \
         services/automation services/deliverability services/migration services/voice tests/e2e; do
  (cd "$d" && go mod edit -toolchain=go1.26.4)
done
# CI: raise literal pins in ci.yml(1.23) test.yml/e2e.yml(1.24) openapi-check.yml(1.23) to 1.26.4
#     (govulncheck.yml/codeql.yml use go-version-file: apps/api/go.mod -> auto-pick up)

# Third-party (fix-now / fix-soon):
cd services/automation && go get github.com/redis/go-redis/v9@v9.7.3 && go mod tidy && go test ./...
cd apps/api && go get github.com/golang-jwt/jwt/v5@v5.2.2 && go mod tidy

# Optional hygiene (monitor):
for d in apps/api services/automation services/deliverability services/migration services/voice; do
  (cd "$d" && go get github.com/go-chi/chi/v5@v5.2.2 && go mod tidy); done
cd apps/api && go get golang.org/x/crypto@v0.52.0 && go mod tidy
```

### 6.3 Rust / Tauri — required live gate

```bash
cargo install cargo-audit --version 0.22.2 --locked
pnpm --dir apps/desktop check:rust-dependencies
```

Do not add `audit.toml` or inline `--ignore` arguments. The shared gate owns
exact exceptions and verifies supported-target reachability before applying
the approved IDs to its final deny-warnings check.

### 6.4 Python / PHP SDKs — close the coverage gap

```bash
# Python SDK — generate + commit a lockfile so osv-scanner/pip-audit can scan it:
cd packages/sdk-py && poetry lock   # (or: uv lock -> uv.lock)
git add packages/sdk-py/poetry.lock
# PHP SDK — generate + commit composer.lock (covers phpunit dev tree):
cd packages/sdk-php && composer install && git add packages/sdk-php/composer.lock && composer audit
```

Add the missing Dependabot ecosystems (`.github/dependabot.yml` currently configures only npm / gomod / github-actions — confirmed):

```yaml
- package-ecosystem: "pip"
  directory: "/packages/sdk-py"
  schedule: { interval: "weekly", day: "thursday" }
  labels: ["dependencies","ecosystem:pip","scope:sdk-py"]
- package-ecosystem: "composer"
  directory: "/packages/sdk-php"
  schedule: { interval: "weekly", day: "thursday" }
  labels: ["dependencies","ecosystem:composer","scope:sdk-php"]
```

---

## 7. Coverage Gaps & Caveats

1. **apps/api Go reachability is UNKNOWN.** govulncheck symbol-scan **PANICKED** (Go 1.26 generics + x/tools bug) → package-mode fallback. The 11 stdlib vulns + `golang-jwt` are confirmed IMPORTED but CALLED-status is unknown. Treated conservatively as fix-now/fix-soon (it's the main internet-facing service). **Re-run symbol mode after bumping govulncheck (CI pins v1.1.4; v1.4.0 used here)** to confirm reachability.

2. **GOTOOLCHAIN=local trap (verified in Dockerfile.go).** A go.mod `toolchain go1.26.4` directive alone will **not** auto-download 1.26.4 in the container — the base image must ship it. Confirm the `golang:1.26.4-alpine` digest exists before merging or the build fails with a toolchain-mismatch error.

3. **Python & PHP SDKs are entirely unscanned** (both confirmed lockfile-absent). `packages/sdk-py` has `pyproject.toml` but no `poetry.lock`/`uv.lock`; its `.venv` is an empty uv shell, so exact httpx/pydantic versions could not be enumerated — all SDK findings are **NEEDS-VERIFICATION**. `packages/sdk-php` has `composer.json` but no `composer.lock`, declares **zero** third-party runtime deps (only php>=8.1, ext-curl, ext-json — security tracks the PHP/libcurl/OpenSSL runtime, outside Composer's purview), and has **no PHP/Composer step anywhere in CI**.

4. **pnpm audit walks to workspace root → over-attribution.** `shell-quote` and `ws` are tagged "apps/web" but are absent from apps/web's independent lockfile (they are Expo/RN/Metro dev tooling for apps/mobile). Dependency-path counts (2269, 11568, 4625) reflect deep tooling fan-out, not runtime surface, and were taken from scanner output, not independently re-derived.

5. **Override resolution not dry-run-verified.** The proposed `@xmldom` 0.7→0.8, `hono` 4.12.25 vs MCP SDK's `hono ^4`, `js-yaml@>=4` against 3.x consumers, and `@opentelemetry/core` 2.8.0 vs Sentry 8.55.2 should each be confirmed with a `--lockfile-only` install before merge. The `vite` 5.x-vs-8.x override interaction is subtle — determine which lockfile takes precedence per app's build invocation.

6. **Reachability ratings for dompurify / markdown-it / @opentelemetry/core / js-yaml are lockfile-derived, not call-site-traced.** A code-level reachability pass would tighten these tiers. protobufjs reachability is rated `unknown` (not `no`) — not every OTel code path was traced to prove the JSON-conversion routine is never invoked on inbound data.

7. **Rust verdict remains contingent on the macOS+Windows-only distribution.** The earlier manual cfg review has been superseded by executable Cargo metadata traversal on `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, and a Linux evidence target. CI and release recompute it. Adding Linux invalidates the policy and makes all 13 residual findings release-reachable.

**Recommendation:** wire **osv-scanner + govulncheck + `pnpm audit` (+ pip-audit / composer audit once SDK locks land)** into CI as required checks so these regressions — especially stale overrides that pin to vulnerable versions — are caught automatically rather than in a periodic manual audit.
