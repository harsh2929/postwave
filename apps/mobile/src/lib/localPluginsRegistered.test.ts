/**
 * Every local config plugin must be registered.
 *
 * `plugins/withAndroidShareTarget.js` shipped with 242 lines of manifest
 * mutation, a Kotlin emitter, and a unit test pinning its policy literals
 * against the iOS extension — and was referenced by nothing but itself. It was
 * never in `app.json`'s plugins array, so `expo prebuild` never ran it,
 * `AndroidManifest.xml` had zero `ACTION_SEND` filters, and Moosewave did not
 * appear in the Android share sheet at all.
 *
 * Nothing could catch that. The plugin's own test drives its exported function
 * directly against a parsed manifest, so it passes whether or not the build ever
 * calls it — the test proves the mutation is correct, not that it happens. A
 * compiler cannot help either: an unreferenced .js file is not an error.
 *
 * This asserts the one property neither covers: a plugin that exists is a
 * plugin the build runs.
 */
import { describe, expect, it } from "vitest";

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..", "..");

/** Local plugins that are deliberately not registered, each with a reason. */
const INTENTIONALLY_UNREGISTERED: Record<string, string> = {
  // (none today)
};

describe("local config plugins", () => {
  it("are all registered in app.json", () => {
    const app = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8"));
    const registered = JSON.stringify(app.expo.plugins ?? []);

    const local = readdirSync(resolve(root, "plugins"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, ""));

    expect(local.length).toBeGreaterThan(0);

    for (const name of local) {
      if (name in INTENTIONALLY_UNREGISTERED) continue;
      if (!registered.includes(name)) {
        throw new Error(
          `plugins/${name}.js exists and app.json never references it, so ` +
            `expo prebuild never runs it. A config plugin that is not ` +
            `registered produces no native change at all — the feature is ` +
            `absent from the build while its source and its unit test both ` +
            `look healthy. Either register it, or add it to ` +
            `INTENTIONALLY_UNREGISTERED with a reason.`,
        );
      }
    }
  });
});
