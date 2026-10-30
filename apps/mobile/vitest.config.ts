import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// ── HOST-LOCALE PIN (TESTS-3) ─────────────────────────────────────────────
// lib/format passes `undefined` to Intl until localization.ts hands it the
// device locale, so under test every formatter follows the ICU default of the
// machine running the suite: on a de_DE shell 25 format tests went red, on
// en_IN two, with `LC_ALL=` (empty) ICU resolved `und` and six did. CI was
// green only because ubuntu's C.UTF-8 happens to map to en-US.
//
// This runs in vitest's MAIN process, before the default `forks` pool spawns
// its workers, and the workers inherit this env. ICU fixes its default when a
// process starts, so it cannot be changed from inside a worker (a setupFile
// calling setFormatLocale("en-US") also leaves tests that reset the locale to
// `undefined` on the host default). Switching to pool "threads" would share
// this already-started process and silently re-couple the suite to the host
// locale; src/lib/formatLocalePin.test.ts is the canary that goes red then.
process.env.LC_ALL = "en_US.UTF-8";
process.env.LANG = "en_US.UTF-8";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/*.native.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reportsDirectory: `${root}coverage`,
      reporter: ["text", "json-summary", "lcov"],
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "src/types/**",
        "src/api/generated/**",
      ],
      thresholds: {
        // ── NATIVE#52: A RATCHET, NOT A DECORATION ────────────────────────
        // The first floors (2026-07-15) were 27 / 20 / 20 / 27, seeded from a
        // 27.07 / 20.74 / 20.74 / 27.84 measurement. The suite has since grown
        // to 6,152 tests across 458 files and nobody moved them, so a "20%
        // branch floor" had stopped describing anything: every commit passed a
        // gate it cleared by more than twice over, which is the exact failure
        // mode a floor without a ratchet has.
        //
        // RE-MEASURED 2026-08-02 with `npx vitest run --environment node
        // --coverage`: 43.83 statements / 42.35 branches / 35.60 functions /
        // 42.98 lines (16,981 of 38,739 statements). These floors are set just
        // under that so the next uncovered module fails the gate rather than
        // being absorbed by 20 points of slack.
        //
        // The measurement excluded two suites that were red at the time under
        // concurrent work elsewhere in the tree (src/api/request.test.ts,
        // src/lib/nav.consistency.test.ts). Excluding a suite can only LOWER
        // the number, so the figures above are a strict lower bound and these
        // floors are safe against the full green suite.
        //
        // MOVING THESE IS ONE-WAY. Re-measure, then raise. If a number has to
        // come down, the coverage went down and that is the thing to fix.
        statements: 42,
        branches: 41,
        functions: 34,
        lines: 41,

        // ── PER-FILE FLOORS: MODULES NOTHING ELSE EXECUTES ────────────────
        // jest.routes.config.cjs routes these hook modules to the query-hook
        // proxy (or its react-query stub never calls a mutationFn, so the
        // api/ops.ts writes under them never run either), which leaves their
        // sibling vitest files the ONLY place the real code runs. A 0%
        // file is invisible inside a 42% global floor: `throw` at the top of
        // useAgencyOps.ts left every suite green (TESTS-1), and the
        // governance write verbs and the brand-voice save mapping ran on
        // neither runner (TESTS-2, TESTS-4). Deleting or gutting the sibling
        // test now fails this gate instead of passing silently.
        //
        // Each is floor(measured) - 2, measured 2026-09-14 with the sibling
        // test run ALONE (a strict lower bound for the full suite). Same rule
        // as above: ONE-WAY. Re-measure, then raise; never lower.
        "src/hooks/useAgencyOps.ts": { lines: 92, branches: 78 },
        "src/hooks/useGovernanceOps.ts": { lines: 98, branches: 98 },
        "src/hooks/useAgentMandates.ts": { lines: 98, branches: 73 },
        "src/api/ops.ts": { lines: 50, branches: 98 },
        "src/hooks/useVoice.ts": { lines: 85, branches: 70 },
        // TESTS-6, the landing-scope write hooks: jest loads them, but its
        // react-query stub never calls a mutationFn, so an inverted publish
        // status, `request_id = campaignId`, a Cancel that STARTED a run, a
        // note DELETE aimed at the subscriber id, or a dropped un-suppress
        // restore all passed both runners. useReferrals' branch floor is
        // lower because REFERRAL_RUNTIME_AVAILABLE is false: it short-circuits
        // the payout and variant `enabled` conjunctions until the server
        // mounts those routes.
        "src/hooks/useLandingPages.ts": { lines: 98, branches: 92 },
        "src/hooks/useCampaignAssuranceActions.ts": { lines: 98, branches: 98 },
        "src/hooks/useReferrals.ts": { lines: 98, branches: 76 },
        "src/hooks/useSubscriberNotes.ts": { lines: 98, branches: 98 },
        "src/hooks/useSubscriberSuppressionWrites.ts": {
          lines: 98,
          branches: 98,
        },
      },
    },
  },
});
