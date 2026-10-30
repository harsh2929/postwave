/**
 * The stub that removes Sentry's DOM user-feedback widget from native bundles.
 *
 * `@sentry-internal/feedback` is 78,103 source bytes of HTML dialog, canvas
 * screenshot and `document` access. Nothing on Hermes can run it, and
 * @sentry/react-native ships its own native feedback surface that does not
 * import it. It arrives only through @sentry/browser's barrel.
 *
 * THE DANGEROUS PART, AND WHY THESE TESTS EXIST.
 * `@sentry/browser/feedbackAsync.js` and `feedbackSync.js` call
 * `buildFeedbackIntegration({...})` at MODULE SCOPE, and both ship in the
 * bundle. Resolving the package to an empty module makes that binding
 * `undefined` and throws `TypeError` the moment either file is evaluated — a
 * crash at app startup. Metro resolves an empty module without complaint, so
 * "the export succeeded" is NOT evidence here. These tests exercise the call
 * pattern itself.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");
const require_ = createRequire(import.meta.url);

type FeedbackStub = {
  buildFeedbackIntegration: (options?: unknown) => () => { name: string };
  feedbackModalIntegration: () => { name: string };
  feedbackScreenshotIntegration: () => { name: string };
  getFeedback: () => unknown;
  sendFeedback: () => Promise<unknown>;
};

function stub(): FeedbackStub {
  return require_(join(APP_ROOT, "metro-stubs/sentry-feedback-noop.js"));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.[jt]sx?$/u.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

describe("the Sentry DOM feedback stub survives its real call sites", () => {
  it("satisfies feedbackSync's module-scope construction", () => {
    // Byte-for-byte the shape of @sentry/browser/feedbackSync.js. If the stub
    // regresses to an empty module this line throws, which is the startup
    // crash reproduced in a unit test.
    const s = stub();
    const factory = s.buildFeedbackIntegration({
      getModalIntegration: () => s.feedbackModalIntegration,
      getScreenshotIntegration: () => s.feedbackScreenshotIntegration,
    });
    expect(typeof factory).toBe("function");
    expect(factory()).toHaveProperty("name");
  });

  it("satisfies feedbackAsync's module-scope construction", () => {
    const s = stub();
    const factory = s.buildFeedbackIntegration({ lazyLoadIntegration: () => {} });
    expect(typeof factory).toBe("function");
  });

  it("exports every binding the browser barrel re-exports", () => {
    // index.js does `export { getFeedback, sendFeedback } from ...`.
    const s = stub();
    for (const name of [
      "buildFeedbackIntegration",
      "feedbackModalIntegration",
      "feedbackScreenshotIntegration",
      "getFeedback",
      "sendFeedback",
    ] as const) {
      expect(typeof s[name]).toBe("function");
    }
  });

  it("still describes how @sentry/browser actually calls it", () => {
    // VACUITY FLOOR against the real package. The whole shim is shaped around
    // one upstream fact: these calls happen at module scope. If a Sentry
    // upgrade changes that, the shim's contract needs rereading rather than
    // silently continuing to satisfy a pattern nobody uses.
    // The package's `exports` map blocks deep subpaths, so resolve the
    // package root and walk to the file rather than require.resolve()-ing it.
    const entry = require_.resolve("@sentry/browser", { paths: [APP_ROOT] });
    // Derive the sibling file from whatever entry resolution returns, rather
    // than counting "..".
    const candidate = entry.replace(/[^/\\]+$/u, "feedbackSync.js");
    let sync: string;
    try {
      sync = readFileSync(candidate, "utf8");
    } catch {
      // Layout changed upstream — that is itself the signal to re-read the
      // stub's contract rather than assume it still matches.
      expect.unreachable(
        `@sentry/browser feedbackSync.js not found at ${candidate}; re-verify the stub contract`,
      );
      return;
    }
    expect(sync).toContain("buildFeedbackIntegration(");
    expect(sync).toContain("@sentry-internal/feedback");
  });

  it("keeps the stub wired in metro.config.js", () => {
    const metro = stripComments(
      readFileSync(join(APP_ROOT, "metro.config.js"), "utf8"),
    );
    expect(metro).toContain("SENTRY_DOM_FEEDBACK");
    expect(metro).toMatch(/moduleName === SENTRY_DOM_FEEDBACK/u);
  });

  it("uses no Sentry feedback API in app source", () => {
    // The integrations are inert, so a screen that started offering feedback
    // would render nothing and report nothing.
    const files = [
      ...sourceFiles(join(APP_ROOT, "src")),
      ...sourceFiles(join(APP_ROOT, "app")),
    ].filter((f) => !f.endsWith("sentryFeedbackStub.test.ts"));
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter((f) => {
      const src = stripComments(readFileSync(f, "utf8"));
      return /\b(showFeedbackWidget|showFeedbackButton|getFeedback|sendFeedback|feedbackIntegration)\b/u.test(
        src,
      );
    });
    expect(offenders).toEqual([]);
  });
});
