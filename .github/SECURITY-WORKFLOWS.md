# Security CI workflows

This repo ships four complementary security workflows under `.github/`. Each
one has a tightly scoped responsibility and a documented manual remediation
recipe. Skim this page when a workflow fails on a PR and you need to know
which scanner is blocking you and how to clear it.

| File                                | What it does                                    | Blocks PR? |
| ----------------------------------- | ----------------------------------------------- | ---------- |
| `.github/dependabot.yml`            | Weekly grouped dependency PRs (npm, gomod, GHA) | No         |
| `.github/workflows/codeql.yml`      | Static analysis for JS/TS + Go                  | Yes        |
| `.github/workflows/trivy.yml`       | Container CVE scan for every published image    | Yes        |
| `.github/workflows/govulncheck.yml` | Reachability-aware Go module CVE scan           | Yes        |

Supporting files:

- `.github/codeql/codeql-config.yml` — CodeQL path filters (excludes generated code, testdata).
- `.trivyignore` — repo-root list of CVE IDs we've explicitly waived (each with a rationale + review date).
- `scripts/check-security-scan-coverage.mjs` — fail-closed inventory contract for all Go modules and published images.

---

## 1. Dependabot (`.github/dependabot.yml`)

**Cadence:** weekly per ecosystem (npm Mondays, gomod Tuesdays, github-actions Wednesdays).
**PR mode:** grouped — minor/patch bumps land in a single PR per ecosystem per directory. Majors and security updates still open separately so we read the changelog.
**Go scope:** every discovered `go.mod` directory. The repository contract rejects missing, stale, or duplicate gomod entries.

### Manual fix recipe — Dependabot PR failing CI

1. Check out the PR locally: `gh pr checkout <PR-number>`
2. Reinstall lockfile state:
   - npm/pnpm: `rm -rf node_modules && pnpm install`
   - Go: `cd <module-directory> && GOWORK=off go mod tidy && go build ./...`
3. Run the targeted module/package tests that the failing CI job ran.
4. Push the lockfile fix back to the PR branch. Dependabot will not overwrite human commits.
5. If a peer-dep conflict blocks the bump, merge unrelated Dependabot PRs first and rebase — Dependabot re-resolves on rebase.

---

## 2. CodeQL (`.github/workflows/codeql.yml`)

**Triggers:** push to main, PR to main, weekly cron (Mon 04:00 UTC).
**Languages:** `javascript-typescript`, `go`.
**Suite:** `security-extended` (no `security-and-quality` style noise).
**Go build:** manual, dynamic compilation of all 13 current modules (including
observability and e2e), followed by a no-test execution compile so test source
is extracted too. Adding a module requires no workflow-list edit, but its
Dependabot and CodeQL path coverage must exist before the build can run.

### Manual fix recipe — handling a CodeQL alert

1. Open the GitHub **Security** tab → **Code scanning** → click the alert.
2. Reproduce locally (one-time setup: `brew install --cask codeql`):
   ```bash
   gh codeql database create db --language=<lang> --source-root=.
   gh codeql database analyze db --format=sarif-latest --output=ql.sarif
   ```
3. Verify the alert points to reachable code. CodeQL emits false positives on test fixtures and generated code (those should already be filtered via `.github/codeql/codeql-config.yml`).
4. **Real finding:** patch the code; push.
5. **False positive:** add `// lgtm[<query-id>]` (Go) or `// codeql[<query-id>]` (JS) with a one-line justification.

---

## 3. Trivy (`.github/workflows/trivy.yml`)

**Triggers:** push to main, PR to main (on Dockerfile/app/service/package/infra changes), daily cron (02:00 UTC).
**Targets:** all eight published images: API, automation, deliverability,
migration, voice, database migrator, web, and observability collector. The
repository contract compares the publish and scan matrices and also discovers
deployable Go services from the source tree.
**Threshold:** fails on `HIGH` or `CRITICAL` CVEs with a fix available. Unfixed CVEs are reported but non-blocking.

### Manual fix recipe — handling a Trivy CVE

1. Reproduce locally (`brew install aquasecurity/trivy/trivy`):
   ```bash
   docker build -f Dockerfile.go --build-arg SERVICE_PATH=apps/api -t pw-api:scan .
   trivy image --severity HIGH,CRITICAL --ignore-unfixed pw-api:scan
   ```
2. Remediate by source:
   - **OS package CVE:** bump the base image `FROM` line in the Dockerfile.
   - **Go module CVE:** `cd apps/api && go get <module>@<fixed-version> && go mod tidy && go build ./...`
   - **npm CVE (web):** `cd apps/web && pnpm up <package>@<fixed-version>`
3. If no fix is available _and_ the CVE is genuinely not exploitable in our deployment, append the CVE ID to `.trivyignore` at the repo root with a rationale and a re-evaluation date (max 6 months out).

---

## 4. govulncheck (`.github/workflows/govulncheck.yml`)

**Triggers:** push to main, PR to main (on `*.go` / `go.mod` / `go.sum` changes), daily cron (03:00 UTC).
**Scope:** every Go module discovered in the checkout (13 at the time of this document update).
**Why it complements Trivy:** govulncheck does call-graph reachability analysis against source code — it only flags CVEs we actually reach, so it catches issues before Trivy's image-level scan and has dramatically fewer false positives.

### Manual fix recipe — handling a govulncheck finding

1. Reproduce locally:
   ```bash
   go install golang.org/x/vuln/cmd/govulncheck@v1.1.4
   cd apps/api && govulncheck ./...
   ```
2. The output prints an OSV ID — e.g. `GO-2024-1234` → look it up at `https://pkg.go.dev/vuln/GO-2024-1234`.
3. Bump the offending module: `go get <module>@<fixed-version> && go mod tidy && go build ./...`
4. If no fixed version exists yet:
   - Check the govulncheck output for `Your code is affected` vs `Your code does not appear to be affected`. If unreachable, document with an inline comment in the relevant Go file citing the OSV ID + reachability proof. govulncheck has no `.ignore` file — the suppression must live next to the code.
5. Re-run `govulncheck ./...` and confirm clean exit (status 0).

---

## Threat-model triage cheat sheet

| Symptom on PR                              | Most likely scanner | First action                         |
| ------------------------------------------ | ------------------- | ------------------------------------ |
| "SQL injection in handlers.go"             | CodeQL              | Audit the query; param it via pgx    |
| "Vulnerability GO-2024-NNNN in dependency" | govulncheck         | `go get <mod>@<fixed>`               |
| "HIGH severity CVE-YYYY-NNNN in image"     | Trivy               | Bump base image or affected dep      |
| "Outdated github-actions in workflows/"    | Dependabot          | Wait for the auto-PR; review & merge |
