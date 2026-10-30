#!/usr/bin/env node
/**
 * check-production-autologin — refuse to build a production bundle that would
 * carry developer sign-in credentials.
 *
 * `src/lib/devAutoSignIn.ts` refuses to USE the credentials when
 * BUILD_PROFILE is production, but that is a RUNTIME refusal and the secret is
 * substituted at BUILD time: babel-preset-expo replaces every
 * `process.env.EXPO_PUBLIC_*` with a string literal before the runtime check
 * ever exists. A production bundle compiled on a machine whose environment
 * still carries EXPO_PUBLIC_DEV_PASSWORD would therefore contain that password
 * verbatim — inert, but present and readable by anyone who unzips the app.
 *
 * The only place that can be prevented is here, before the bundle is written.
 * Run this in the release pipeline ahead of any production export.
 *
 * Exit 0 = safe to build. Exit 1 = a credential would be embedded.
 */
import process from "node:process";

/** Variables that must never be present when compiling for production. */
export const DEV_ONLY_ENV_KEYS = [
  "EXPO_PUBLIC_DEV_AUTOLOGIN",
  "EXPO_PUBLIC_DEV_EMAIL",
  "EXPO_PUBLIC_DEV_PASSWORD",
];

/**
 * Decide, from an environment, whether a build may proceed.
 *
 * Exported and pure so the rule is unit-testable rather than only observable
 * by running a release build.
 */
export function autologinBuildVerdict(env) {
  const profile = String(env.EXPO_PUBLIC_BUILD_PROFILE ?? "")
    .trim()
    .toLowerCase();
  if (profile !== "production") {
    return { ok: true, profile, offenders: [] };
  }
  // Present-but-blank is not a leak: babel inlines "" and there is nothing to
  // read. Only a value that would appear in the bundle counts.
  const offenders = DEV_ONLY_ENV_KEYS.filter(
    (key) => String(env[key] ?? "").trim() !== "",
  );
  return { ok: offenders.length === 0, profile, offenders };
}

const verdict = autologinBuildVerdict(process.env);
if (!verdict.ok) {
  console.error(
    "[postwave-mobile] REFUSING to build for production: developer sign-in " +
      "credentials are present in the environment and would be inlined into " +
      "the bundle.\n" +
      verdict.offenders.map((key) => `  - ${key}`).join("\n") +
      "\n\nUnset them (they belong in a local, gitignored .env only) and " +
      "rebuild. See src/lib/devAutoSignIn.ts.",
  );
  process.exitCode = 1;
} else if (verdict.profile === "production") {
  console.log(
    "[postwave-mobile] production build carries no developer credentials.",
  );
}
