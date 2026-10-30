/**
 * The Android share target (NATIVE#23).
 *
 * Two things are pinned here, because neither can be checked by a compiler
 * from this side:
 *
 *   1. The manifest mutation, driven for real through the plugin's exported
 *      function against a realistic parsed AndroidManifest. `expo prebuild`
 *      re-runs mods, so idempotency is a build-breaking property, not a
 *      nicety — a duplicated `<activity>` fails the manifest merger.
 *
 *   2. The emitted Kotlin's POLICY LITERALS, against the shared route registry
 *      and against the iOS share extension. The two platforms cannot share
 *      code, so what stops them drifting is this file. If Android accepted a
 *      shape iOS rejects, "share into Moosewave" would mean two different
 *      things depending on the phone.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ENTITIES } from "@postwave/route-map";
import { describe, expect, it } from "vitest";

import { routeForNavLink } from "./navDeepLinks";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("../../plugins/withAndroidShareTarget.js") as {
  (config: unknown): {
    mods?: { android?: Record<string, (cfg: unknown) => Promise<unknown>> };
  };
  addShareTargetActivity: (manifest: unknown) => {
    manifest: { application: { activity?: unknown[] }[] };
  };
  renderShareActivityKotlin: (packageName: string) => string;
  SHARE_ACTIVITY_NAME: string;
  SHARE_ACTIVITY_CLASS: string;
};

type ManifestActivity = {
  $: Record<string, string>;
  "intent-filter"?: {
    action?: { $: Record<string, string> }[];
    category?: { $: Record<string, string> }[];
    data?: { $: Record<string, string> }[];
  }[];
};

function emptyManifest() {
  return {
    manifest: {
      application: [
        {
          $: { "android:name": ".MainApplication" },
          activity: [{ $: { "android:name": ".MainActivity" } }],
        },
      ],
    },
  };
}

function activities(manifest: ReturnType<typeof emptyManifest>) {
  return (manifest.manifest.application[0]?.activity ??
    []) as ManifestActivity[];
}

describe("AndroidManifest mutation", () => {
  it("adds one exported ACTION_SEND text/plain activity", () => {
    const manifest = emptyManifest();
    plugin.addShareTargetActivity(manifest);

    const share = activities(manifest).find(
      (activity) => activity.$["android:name"] === plugin.SHARE_ACTIVITY_NAME,
    );
    expect(share).toBeDefined();
    expect(share?.$["android:exported"]).toBe("true");

    const filter = share?.["intent-filter"]?.[0];
    expect(filter?.action?.[0]?.$["android:name"]).toBe(
      "android.intent.action.SEND",
    );
    expect(filter?.category?.[0]?.$["android:name"]).toBe(
      "android.intent.category.DEFAULT",
    );
    // Only text/plain: Moosewave has no action for an image or a file, and
    // claiming a MIME type it cannot use earns a permanent place in a share
    // sheet it never satisfies.
    expect(filter?.data?.[0]?.$["android:mimeType"]).toBe("text/plain");
    expect(filter?.data).toHaveLength(1);
  });

  it("keeps a shared link out of the recents screenshot", () => {
    const manifest = emptyManifest();
    plugin.addShareTargetActivity(manifest);
    const share = activities(manifest).find(
      (activity) => activity.$["android:name"] === plugin.SHARE_ACTIVITY_NAME,
    );
    expect(share?.$["android:excludeFromRecents"]).toBe("true");
    expect(share?.$["android:noHistory"]).toBe("true");
    expect(share?.$["android:theme"]).toBe("@android:style/Theme.NoDisplay");
  });

  it("leaves MainActivity untouched", () => {
    const manifest = emptyManifest();
    plugin.addShareTargetActivity(manifest);
    const main = activities(manifest).find(
      (activity) => activity.$["android:name"] === ".MainActivity",
    );
    expect(main).toEqual({ $: { "android:name": ".MainActivity" } });
  });

  it("is idempotent — prebuild runs mods more than once", () => {
    const manifest = emptyManifest();
    plugin.addShareTargetActivity(manifest);
    plugin.addShareTargetActivity(manifest);
    plugin.addShareTargetActivity(manifest);
    expect(
      activities(manifest).filter(
        (activity) => activity.$["android:name"] === plugin.SHARE_ACTIVITY_NAME,
      ),
    ).toHaveLength(1);
  });

  it("fails loudly on a manifest it does not recognise", () => {
    expect(() => plugin.addShareTargetActivity({ manifest: {} })).toThrow(
      /<application>/,
    );
  });
});

/**
 * The path `expo prebuild` actually takes.
 *
 * Everything above drives the plugin's EXPORTED HELPERS. That left the default
 * export — the only thing Expo ever calls — untested, and the gap was not
 * theoretical: removing the `withShareActivitySource(config)` line left all 26
 * tests green while the Kotlin was never written. The manifest still declared
 * `android:name=".PostwaveShareActivity"`, so the build succeeded, the app
 * installed, Moosewave appeared in the share sheet, and tapping it threw
 * ClassNotFoundException. A feature that fails at the moment it is used is
 * worse than one that is absent.
 *
 * So this runs the mods the way Expo runs them and asserts the file lands where
 * the manifest says the class lives. The two halves are only correct TOGETHER,
 * and nothing else in this repo checks that.
 */
describe("the plugin Expo actually runs", () => {
  const PACKAGE = "com.moosewave.app";

  function runMods() {
    const config = plugin({
      name: "Moosewave",
      slug: "postwave",
      android: { package: PACKAGE },
    });
    return config;
  }

  it("registers both mods — the manifest edit and the source emit", () => {
    const mods = runMods().mods?.android ?? {};
    // `dangerous` writes the Kotlin; `manifest` declares it. Losing either one
    // ships a share target that cannot work.
    expect(Object.keys(mods).sort()).toEqual(["dangerous", "manifest"]);
  });

  it("writes the activity source at the path the manifest points at", async () => {
    const config = runMods();
    const dangerous = config.mods?.android?.dangerous;
    expect(dangerous).toBeTypeOf("function");

    const projectRoot = mkdtempSync(join(tmpdir(), "postwave-share-"));
    try {
      await dangerous!({
        ...config,
        modRequest: { platformProjectRoot: projectRoot },
      });

      // `.PostwaveShareActivity` in the manifest resolves against the app's
      // package, so the source has to sit in that package's directory. A file
      // written anywhere else is a class the runtime cannot find.
      const expected = join(
        projectRoot,
        "app/src/main/java",
        ...PACKAGE.split("."),
        `${plugin.SHARE_ACTIVITY_CLASS}.kt`,
      );
      const emitted = readFileSync(expected, "utf8");
      expect(emitted).toContain(`package ${PACKAGE}`);
      expect(emitted).toContain(`class ${plugin.SHARE_ACTIVITY_CLASS}`);
      expect(plugin.SHARE_ACTIVITY_NAME).toBe(
        `.${plugin.SHARE_ACTIVITY_CLASS}`,
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("refuses to prebuild an app with no android.package", async () => {
    // Without a package there is no directory to write to and no name for the
    // manifest to resolve. Emitting nothing and continuing would produce the
    // same silent ClassNotFoundException at share time.
    const config = plugin({ name: "Moosewave", slug: "postwave", android: {} });
    const dangerous = config.mods?.android?.dangerous;
    const projectRoot = mkdtempSync(join(tmpdir(), "postwave-share-"));
    try {
      await expect(
        dangerous!({
          ...config,
          modRequest: { platformProjectRoot: projectRoot },
        }),
      ).rejects.toThrow(/android\.package/);
      expect(readdirSync(projectRoot)).toHaveLength(0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("emitted Kotlin", () => {
  const source = plugin.renderShareActivityKotlin("com.moosewave.app");

  it("declares the package it was asked for and nothing else", () => {
    expect(source.startsWith("package com.moosewave.app\n")).toBe(true);
    expect(source).toContain("class PostwaveShareActivity : Activity()");
  });

  it("refuses to emit sources for an implausible package name", () => {
    for (const bad of [
      "",
      "postwave",
      "Com.Example.App",
      "com/postwave",
      "../etc",
    ]) {
      expect(() => plugin.renderShareActivityKotlin(bad)).toThrow(
        /package name/,
      );
    }
  });

  it("accepts exactly the registry entities this app can actually open", () => {
    // The share target hands a pasted Moosewave URL to the mobile app, so the
    // allow-list is the registry filtered to entities mobile has a screen for.
    // Accepting an entity with `surfaces.mobile === "none"` (affiliates,
    // sequence templates) would consume the share and then land nowhere.
    const openable = Object.values(ENTITIES).filter(
      (e) => e.surfaces.mobile !== "none",
    );
    for (const entity of openable) {
      expect(source, entity.key).toContain(
        `"${entity.slug}" to "${entity.key}"`,
      );
    }
    for (const entity of Object.values(ENTITIES)) {
      if (entity.surfaces.mobile !== "none") continue;
      expect(source, entity.key).not.toContain(`"${entity.slug}" to `);
    }
    // …and nothing beyond them.
    const declared = [...source.matchAll(/"([a-z-]+)" to "([a-z-]+)"/gu)];
    expect(declared).toHaveLength(openable.length);
  });

  it("mirrors the iOS extension's resource-id and host allow-lists", () => {
    const ios = readFileSync(
      resolve(process.cwd(), "targets/share/index.swift"),
      "utf8",
    );
    expect(ios).toContain('"^[A-Za-z0-9_-]+$"');
    expect(source).toContain('Regex("^[A-Za-z0-9_-]{1,128}$")');
    expect(ios).toContain('components.host == "app.moosewave.com"');
    expect(source).toContain('value.startsWith("https://app.moosewave.com/")');
    expect(source).toContain(
      'action != "helpdesk-conversation" || CANONICAL_UUID.matches(id)',
    );
    expect(ios).toContain(
      'action != "helpdesk-conversation" || isCanonicalUUID(identifier)',
    );
    expect(source).not.toContain('"helpdesk" to "helpdesk-ticket"');
    expect(ios).not.toContain('"helpdesk-ticket"');
  });

  it("drops query strings and fragments before matching, as iOS does", () => {
    expect(source).toContain(
      "trimmed.substringBefore('?').substringBefore('#')",
    );
  });

  it("re-emits the custom scheme rather than trusting App Links", () => {
    // An https:// hand-off depends on Android App Links verification having
    // succeeded on THIS device; unverified, it opens the browser instead.
    expect(source).toContain('return "moosewave://" + action + "/" + parts[2]');
    expect(source).not.toContain('https://app.moosewave.com/app/" +');
  });

  it("persists nothing — no App Group equivalent, no queue, no TTL", () => {
    // The whole reason the iOS side needs a queue is that the extension is a
    // separate process. Android forwards in-process, so a stored copy of a
    // shared item would be pure retained risk.
    for (const forbidden of [
      "SharedPreferences",
      "getSharedPreferences",
      "openFileOutput",
      "Log.",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("targets its own package so the VIEW intent cannot be intercepted", () => {
    expect(source).toContain("view.setPackage(packageName)");
  });

  it("reads EXTRA_TEXT as a CharSequence, not a String", () => {
    // EXTRA_TEXT is declared CharSequence, and the senders that matter put a
    // Spanned in it — ShareCompat.IntentBuilder.setText() and Chrome's "Share
    // link" both do. getStringExtra returns null for a Spanned instead of
    // converting it, so the activity started, found nothing to open, and
    // called finish(): the share sheet closed with no error and nothing
    // happened. That is indistinguishable from a crash-free no-op, which is
    // why it survived review — the only visible symptom was "sharing does
    // nothing", from exactly the apps this feature exists to receive from.
    expect(source).toContain("intent?.getCharSequenceExtra(Intent.EXTRA_TEXT)");
    // The CALL, not the word: the emitted file explains in a comment why
    // getStringExtra is wrong, and a bare `not.toContain` would fail on that
    // explanation — a test that cannot survive its own subject being
    // documented is a test that will be deleted rather than fixed.
    expect(source).not.toMatch(/\.getStringExtra\s*\(/u);
  });
});

describe("the email hand-off actually lands on a search", () => {
  it("carries the shared address through to the subscribers list", () => {
    // The Kotlin emits `moosewave://subscribers?q=<encoded>`; without the `q`
    // forwarding in navDeepLinks the user would land on the full list having
    // lost the only reason they shared the address.
    expect(routeForNavLink("moosewave://subscribers?q=jane%40acme.com")).toBe(
      "/(tabs)/subscribers?q=jane%40acme.com",
    );
  });

  it("still resolves a plain destination link unchanged", () => {
    expect(routeForNavLink("moosewave://subscribers")).toBe(
      "/(tabs)/subscribers",
    );
    expect(routeForNavLink("moosewave://subscribers?q=")).toBe(
      "/(tabs)/subscribers",
    );
    expect(routeForNavLink("moosewave://subscribers?q=%20%20")).toBe(
      "/(tabs)/subscribers",
    );
  });

  it("drops every query parameter except the search term", () => {
    expect(routeForNavLink("moosewave://subscribers?id=1&mode=edit")).toBe(
      "/(tabs)/subscribers",
    );
    expect(routeForNavLink("moosewave://subscribers?q=jane&id=1")).toBe(
      "/(tabs)/subscribers?q=jane",
    );
  });

  it("refuses an oversized search term rather than truncating it", () => {
    expect(routeForNavLink(`moosewave://subscribers?q=${"a".repeat(321)}`)).toBe(
      "/(tabs)/subscribers",
    );
  });

  it("re-encodes the decoded term so a malformed escape cannot survive", () => {
    expect(routeForNavLink("moosewave://campaigns?q=summer%20sale")).toBe(
      "/(tabs)/campaigns?q=summer%20sale",
    );
    expect(routeForNavLink("moosewave://campaigns?q=a%2Fb")).toBe(
      "/(tabs)/campaigns?q=a%2Fb",
    );
  });
});
