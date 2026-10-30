# Dependency risk governance

Date: 2026-07-15

`pnpm audit:js` is the required production JavaScript dependency gate. Normal
installs and workspace commands remain pinned to pnpm 9.12.0. npm retired the
legacy audit endpoint used by pnpm 10 and earlier in July 2026, so the gate
invokes pnpm 11.4.0 through Corepack only for its read-only audit. The Corepack
package-manager specification includes the exact SHA-512 integrity digest; it
does not rewrite the pnpm 9 lockfile or change the project's package-manager
contract. See the [pnpm endpoint incident](https://github.com/pnpm/pnpm/issues/11265)
and [pnpm 11 bulk-audit migration notes](https://github.com/orgs/pnpm/discussions/11377).

The raw command is equivalent to:

```text
corepack pnpm@11.4.0+sha512.<pinned-digest> --pm-on-fail=ignore audit --prod --audit-level moderate --registry=https://registry.npmjs.org/ --json
```

pnpm 11 uses npm's bulk advisory endpoint. The gate accepts only the observed,
closed `advisories` plus `metadata` JSON shape and cross-checks every advisory,
finding, severity count, dependency total, production flag, path, ID, range,
GHSA URL and exit code. Empty dependency graphs, empty output, invalid JSON,
unknown fields, changed field types, count drift, registry errors, signals and
unexpected stderr all fail closed. The one exact pnpm 11 warning that the
project's pnpm 9 `pnpm.overrides` and `pnpm.patchedDependencies` fields are not
configuration inputs to the audit-only CLI is allowlisted; all other stderr is
an error. The lockfile already contains those pnpm 9 install decisions.

The effective pnpm 9 configuration and the audit CLI must use
`https://registry.npmjs.org/`, with no scoped alternate registry. The gate
also rejects audit suppression in `package.json`, `pnpm-workspace.yaml`,
`.npmrc`, effective pnpm configuration and `NPM_CONFIG_*`/`PNPM_CONFIG_*`
environment variables, including legacy `ignoreCves`, pnpm 11 `ignoreGhsas`,
`ignore-unfixable`, disabled audit and ignored registry errors.

If an accepted risk is present, the raw command is expected to remain non-zero.
A zero exit from the wrapper means only that the raw report is internally
consistent and every moderate-or-higher finding is either absent or matched by
the reviewed, unexpired policy below.

## Sources of truth

- `config/dependency-risk-register.json` is the machine-readable exception
  register.
- `config/schemas/dependency-risk-register.schema.json` documents its closed
  schema.
- `scripts/audit-js.mjs` validates both registry and scanner data at runtime.
- `scripts/audit-js.test.mjs` and `scripts/__fixtures__/audit-js/` prove clean,
  accepted, expired, newly fixable, mismatched, malformed, schema-drift,
  suppression and registry-error behavior without network access.

Scanner ignore lists are not an acceptance mechanism. Every temporary entry
must have an owner role, acceptance/review/expiry dates, exact registry ID,
GHSA, documentary CVE aliases, module, severity, advisory ranges, vulnerable
versions, finding paths, affected importers, rationale, upgrade trigger and
executable compensating-control evidence. The npm bulk response does not
contain CVE aliases or remediation actions; therefore the GHSA is the dynamic
canonical identity, while CVEs are reviewed documentation and are not claimed
to be registry-cross-checked. The gate requires exact set equality for every
field the endpoint does return, so a new path, importer, version or changed
advisory cannot inherit an old exception. Verification commands are restricted
to exact, existing root pnpm scripts, invoked without a shell, and run on every
accepted-risk gate after the raw finding is matched.

Acceptance is limited to 45 days and must be reviewed at least every 30 days.
The gate fails after expiry or review staleness. It also fails immediately if
the bulk endpoint changes either version range, reports a different
path/module/advisory, or the registry's latest stable version changes. The
wrapper fetches the complete published version history and invalidates an
exception if any stable version satisfies the advisory's patched range. This
independent release-history check prevents the endpoint's lack of remediation
actions or an unchanged `latest` tag from concealing an available stable fix.

## Current production dependency position

`config/dependency-risk-register.json` currently carries two accepted
production JavaScript dependency risks, both in `image-size` 1.2.1 (high),
reached only through Metro asset tooling on the root importer:
`GHSA-w3rx-r6r6-pgpr` / `CVE-2025-71330` (registry ID 1138808) and
`GHSA-5p2g-fcmc-qvqq` / `CVE-2025-71329` (registry ID 1138809). Both were
accepted and last reviewed on 2026-08-30, are owned by Security Engineering,
and expire on 2026-10-14. No patched `image-size` release exists (latest
stable 2.0.2; patched range `>=2.0.3`); the installed parser is reproducibly
patched to reject non-progressing ICNS and ISO-BMFF structures. Because
accepted risks are present, the raw production audit is expected to exit
non-zero; `pnpm audit:js` passes only while both findings match the register
exactly and the register is unexpired.

The vulnerable `js-yaml` 3.14.2 path is overridden to 3.15.2, the 4.x line
is overridden to 4.3.2, and the lockfile is regenerated.

MJML `GHSA-45h5-66jx-r2wf` / `CVE-2025-67898` was not accepted after final
triage. Although pnpm emitted `review` and its advisory text named an alpha
patch boundary, the npm `latest` tag was already MJML 5.4.0. Both direct
production importers now pin 5.4.0. The major makes compilation asynchronous,
so the email package, CLI adapter, declarations, tests, and documentation were
updated together. The authenticated web compiler and published email package
retain defense-in-depth rejection of `mj-include` and disabled include/config
resolution.

Local verification on 2026-07-15:

- `pnpm install --frozen-lockfile --ignore-scripts` passed across all 30
  workspace projects.
- `pnpm test:audit-js` passed 42 offline policy/parser cases.
- The integrity-pinned pnpm 11.4.0 raw audit and `pnpm audit:js` reported zero
  production advisories across 1,932 dependencies (1,736 required and 196
  optional).
- An isolated pnpm 11.4.0 project pinned to vulnerable js-yaml 3.14.2 returned
  exit 1 and one moderate bulk advisory; the validator accepted its exact
  non-clean schema and rejected mutated variants. A separate pnpm 9 fixture
  preserves regression coverage for the former `actions`-only false green,
  but the retired legacy endpoint is not used as a live security source.
- `@postwave/email-react` passed its build, typecheck, and 21 tests;
  `@postwave/cli` passed its build, typecheck, and 138 tests; web typecheck and
  the eight focused MJML route tests passed.
- The production graph contains only js-yaml 3.15.2/4.3.2 and MJML 5.4.0
  along the previously vulnerable paths.

Review procedure:

1. Run `pnpm test:audit-js` and `pnpm audit:js`.
2. Run every `verificationCommands` entry for any proposed exception.
3. Independently check the package registry and upstream release channel; do
   not treat the bulk response's lack of remediation guidance as proof that no
   stable fix exists.
4. Prefer upgrading. If no supported fix is viable, record a short expiry and
   reviewed path/control evidence in one change owned by Security Engineering.

## Rust desktop dependency policy

`pnpm --dir apps/desktop check:rust-dependencies` is the required RustSec gate
for both desktop CI and signed release jobs. Both workflows pin cargo-audit
0.22.2 and invoke the same command. The gate performs an unsuppressed
`cargo audit --deny warnings --json` scan first; no workflow, Cargo config, or
static scanner ignore list is an acceptance boundary. The root
`scripts/check-ci-release-contracts.mjs` check independently fails if either
workflow removes or changes this gate, so the control cannot silently remove
its own enforcement path.

The crates.io Tauri 2.11.5 graph previously carried five reachable,
unmaintained `unic-*` crates through `tauri-utils -> urlpattern 0.3`. The
manifest now pins Tauri's focused upstream commit
`dd725f4b13c30a86b398ccc59eb498f151f461c5`, which moves `tauri-utils` to
`urlpattern` 0.6 and its maintained ICU4X implementation. The gate requires
the exact Git source, direct replacement dependency, and absence of all five
retired crates; the patch should be removed when the same change reaches a
released `tauri-utils` version.

The shared cross-platform Cargo lockfile still contains 3 findings from
Tauri's GTK3 backend and if-watch's Linux netlink backend: the unmaintained
`paste` 1.0.15 and `proc-macro-error` 1.0.4 crates and the `glib` 0.18.5
RUSTSEC-2024-0429 unsoundness. They are not present in the normal/build graph
for the shipped targets (`aarch64-apple-darwin`, `x86_64-apple-darwin`, or
`x86_64-pc-windows-msvc`); they are present only on the
`x86_64-unknown-linux-gnu` evidence graph. Cargo-audit does not use Cargo
target predicates to prune lockfile findings, so a raw audit cannot
distinguish this state. Its own `--target-os macos --target-arch aarch64`
filter still returns all 3 warnings, while Cargo's filtered metadata graph
contains none of their packages.

`apps/desktop/src-tauri/audit-exceptions.json` is therefore a temporary,
machine-checked lockfile exception—not a blanket ignore. It records the owner,
acceptance/review/expiry dates, exact advisory metadata and package SHA-256 for
each finding, rationale, and removal trigger. The wrapper requires exact set
equality with the raw report, an advisory database no older than seven days,
review within 30 days, expiry within 45 days, absence on every supported
target, and presence on the Linux evidence graph. Only after those checks does
it pass the exact IDs back to a second `--deny warnings` invocation. An added
Linux release target, new advisory, version/checksum drift, stale exception,
or disappeared finding fails closed and requires review.

Local verification:

```bash
cargo install cargo-audit --version 0.22.2 --locked
pnpm --dir apps/desktop check:rust-dependencies
```

The exceptions were accepted and last reviewed on 2026-09-12; the next review
is due no later than 2026-10-12 and the policy expires on 2026-10-12.
Desktop Platform and Security Engineering must upgrade the Linux
backend chain or renew only after a fresh review. Linux must not become a
production desktop target while any of these exceptions remain.

## External-provider boundary

Dependency acceptance is not provider certification. No committed evidence in
this repository proves live payment, OAuth, sending, rendering, seed-list,
DMARC, or SMS behavior for a target production account. Provider-dependent
features therefore remain unavailable, read-only, or conditional as recorded
in `docs/production-supported-feature-matrix-2026-07-14.md`; they must not be
promoted to generally available based on environment-variable presence or a
mock rehearsal. Credentialed staging evidence and an accountable launch
approval remain external release blockers.
