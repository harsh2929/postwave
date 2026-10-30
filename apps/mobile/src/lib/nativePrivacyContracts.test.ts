import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITIES } from "@postwave/route-map";

const mobileRoot = process.cwd();
const require = createRequire(import.meta.url);

function source(relativePath: string): string {
  return readFileSync(join(mobileRoot, relativePath), "utf8");
}

describe("native widget privacy contract", () => {
  const swift = source("targets/widget/index.swift");
  const bridge = source("src/lib/widgetData.ts");
  /**
   * The Settings SCREEN plus the component the widget/app-lock controls were
   * extracted into.
   *
   * This assertion is about a privacy contract — arming the app lock must
   * revoke the widget opt-in BEFORE the lock is persisted — and that contract
   * is a property of the code, not of the file it happens to live in. Reading
   * only the screen made the guard go red the moment the pair moved into
   * `DeviceProtectionSection`, which is precisely the refactor that keeps them
   * together. Concatenating both means the ordering check still measures the
   * two calls against each other wherever they sit.
   */
  const settings = [
    source("app/(tabs)/settings.tsx"),
    source("src/components/settings/DeviceProtectionSection.tsx"),
  ].join("\n");

  it("keeps JS and Swift on the same opt-in, transaction, and TTL contract", () => {
    expect(swift).toContain(
      'private let widgetOptInKey = "pw_widget_metrics_opt_in_v1"',
    );
    expect(bridge).toContain(
      'const WIDGET_OPT_IN_KEY = "pw_widget_metrics_opt_in_v1"',
    );
    // FRESHNESS and DISCLOSURE EXPIRY are two different numbers (see the note
    // on WIDGET_SNAPSHOT_FRESH_MS in src/lib/widgetData.ts). Both are
    // re-validated natively, so both are pinned on both sides: a JS/Swift
    // drift here either blanks a valid snapshot or renders an expired one.
    expect(swift).toContain(
      "private let freshSnapshotAge: TimeInterval = 15 * 60",
    );
    expect(swift).toContain(
      "private let maxSnapshotAge: TimeInterval = 12 * 60 * 60",
    );
    // NATIVE#46. This was 0, which purged a perfectly valid snapshot whenever
    // the clock stepped backwards between the JS write and the widget read —
    // an NTP correction is enough. What it defends is a snapshot outliving its
    // disclosure by winding the clock back, and the exposure that costs is
    // bounded by this number and nothing else.
    expect(swift).toContain(
      "private let maxFutureClockSkew: TimeInterval = 120",
    );
    expect(bridge).toContain(
      "export const WIDGET_SNAPSHOT_FRESH_MS = 15 * 60 * 1000",
    );
    expect(bridge).toContain(
      "export const WIDGET_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000",
    );
    expect(swift).toContain('defaults.integer(forKey: "pw_widget_ready") == 1');
    expect(bridge).toContain("st.set(WIDGET_READY_KEY, 0)");
    expect(bridge).toContain("st.set(WIDGET_READY_KEY, 1)");
  });

  it("redacts OS previews and inserts an explicit expiry timeline entry", () => {
    expect(
      swift.match(/\.privacySensitive\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    // The invariant is that the TTL boundary gets its own entry carrying the
    // `.expired` snapshot, so previously-rendered metrics cannot survive in an
    // already-built timeline. Matched structurally rather than as one literal
    // line: the entry gained a `configuration:` argument in DASHBOARD#47 and
    // wrapped, and a whitespace-sensitive assertion would have read as a
    // privacy regression when nothing about the privacy behaviour moved.
    expect(swift).toMatch(
      /entries\.append\(PostwaveEntry\(\s*date: expiresAt,\s*snapshot: \.expired/,
    );
    expect(swift).toContain("purgeSnapshotPreservingOptIn(defaults)");
    expect(swift).toContain(
      'Text(isEnabled ? "Data expired" : "Metrics hidden")',
    );
  });

  /**
   * NATIVE#46. The allowance exists so a legitimate backwards clock step does
   * not destroy a valid snapshot; what it must never become is a way to keep a
   * lapsed disclosure alive. The worst-case window is
   * `maxSnapshotAge + maxFutureClockSkew`, so the only thing that matters is
   * that the second number stays a rounding error beside the first.
   */
  it("keeps the clock-skew allowance a rounding error beside the TTL", () => {
    const skew = /private let maxFutureClockSkew: TimeInterval = (\d+)/.exec(
      swift,
    );
    expect(skew, "no maxFutureClockSkew in the widget").not.toBeNull();
    const seconds = Number(skew?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(0);
    // 1% of the twelve-hour disclosure window.
    expect(
      seconds,
      "a clock-skew allowance this large is a way to extend the disclosure window, not a way to tolerate NTP",
    ).toBeLessThanOrEqual(0.01 * 12 * 60 * 60);
    // The declared-lifetime cap is what makes the bound `TTL + skew` rather
    // than unbounded; losing it would make the allowance load-bearing.
    expect(swift).toContain("declaredLifetime <= maxSnapshotAge + 1");
    expect(swift).toContain("expiresAt > nowSeconds");
  });

  /**
   * DASHBOARD#72 — absence is not zero.
   *
   * The App Group stores Ints, so an unmeasured figure used to arrive as a 0
   * and the widget guessed what a 0 meant: counts were drawn as a confident
   * "0", and a genuine 0% open rate hid behind the same em-dash as a missing
   * field. The markers below are what stop the reader inferring meaning from
   * the value, and none of it is checked by a compiler.
   */
  it("publishes an absence marker beside every figure that can be absent", () => {
    for (const key of [
      "pw_widget_subs_known",
      "pw_widget_open_rate_known",
      "pw_widget_sent30d_known",
    ]) {
      expect(bridge, `${key} is not written by widgetData.ts`).toContain(
        `st.set("${key}"`,
      );
      expect(swift, `${key} is not read by the widget`).toContain(key);
      // Purged with the disclosure it describes.
      expect(
        swift.slice(
          swift.indexOf("private let widgetSnapshotKeys"),
          swift.indexOf("private func purgeSnapshotPreservingOptIn"),
        ),
        `${key} is not purged with the snapshot`,
      ).toContain(key);
    }
  });

  it("never infers 'not measured' from the value itself", () => {
    // `pct()` returning an em-dash for `<= 0` WAS the bug: it made a real 0%
    // unreachable. The dash now has exactly one source — the marker.
    expect(swift).not.toMatch(/value <= 0 \? "—"/);
    expect(swift).toContain('private let unmeasuredMark = "—"');
    expect(swift).toContain(
      "guard isMeasured(metric) else { return unmeasuredMark }",
    );
    // An absent marker means "written before this contract existed", not
    // "false" — otherwise updating the extension blanks a valid snapshot.
    expect(swift).toContain("func measuredFlag(");
    expect(swift).toContain("legacyMeaning: openRate > 0");
  });

  it("states a stale snapshot's age instead of presenting it as current", () => {
    // The counterpart to the longer disclosure window: showing yesterday's
    // numbers is only acceptable while the widget says they are yesterday's.
    expect(swift).toContain("func staleness(at now: Date) -> String?");
    expect(swift).toContain(
      "guard age >= freshSnapshotAge else { return nil }",
    );
    expect(swift).toContain('Text(staleness ?? "Overview")');
  });

  it("gives every widget family a destination (DASHBOARD#49)", () => {
    expect(swift).toContain(
      'private let dashboardWidgetURL = "moosewave://dashboard"',
    );
    expect(swift).toContain(
      'private let approvalsWidgetURL = "moosewave://approvals"',
    );
    expect(swift).toContain(".widgetURL(widgetDestination(destination))");
    // The medium family's approvals metric is its own `Link`, and resolving
    // that destination is optional-bound rather than force-unwrapped. The
    // binding moved inside a `ForEach` when the metric order became the user's
    // choice (DASHBOARD#47), so match the binding, not the line it sits on.
    expect(swift).toMatch(
      /let approvals = widgetDestination\(approvalsWidgetURL\)/,
    );
    expect(swift).toContain("Link(destination: approvals)");
    // A widget extension that traps is a blank tile the user cannot recover
    // from, so the destinations are never force-unwrapped.
    expect(swift).not.toMatch(/URL\(string:[^)]*\)!/);
  });

  it("documents explicit opt-in and app-lock revocation in Settings", () => {
    expect(settings).toContain('title="iOS widget privacy"');
    expect(settings).toContain('label="Show workspace metrics in widget"');
    const disableBeforeLock = settings.indexOf(
      "if (!setWidgetMetricsEnabled(false))",
    );
    const persistLock = settings.indexOf("setBiometricLockEnabled(true)");
    expect(disableBeforeLock).toBeGreaterThan(0);
    expect(persistLock).toBeGreaterThan(disableBeforeLock);
  });
});

describe("native share inbox privacy contract", () => {
  const swift = source("targets/share/index.swift");
  const bridge = source("src/lib/sharedInbox.ts");
  const rootLayout = source("app/_layout.tsx");

  it("keeps the native and JS age/count/byte budgets aligned", () => {
    expect(swift).toContain(
      "private let maxSharedItemAge: TimeInterval = 15 * 60",
    );
    expect(swift).toContain("private let maxFutureClockSkew: TimeInterval = 0");
    expect(swift).toContain("private let maxSharedItemBytes = 2 * 1024");
    expect(swift).toContain("private let maxQueueBytes = 12 * 1024");
    expect(swift).toContain("private let maxQueueCount = 8");
    expect(bridge).toContain("maxAgeSeconds: 15 * 60");
    expect(bridge).toContain("maxFutureSkewSeconds: 0");
    expect(bridge).toContain("maxItemBytes: 2 * 1024");
    expect(bridge).toContain("maxQueueBytes: 12 * 1024");
    expect(bridge).toContain("maxQueueItems: 8");
  });

  it("allows exactly the route-map entities this app can actually open", () => {
    // Same rule as the Android share target: the extension queues a URL for
    // the app to open, so an entity mobile has no screen for must not be
    // accepted — it would consume the share and strand the user.
    for (const entity of Object.values(ENTITIES)) {
      if (entity.surfaces.mobile === "none") {
        expect(swift, entity.key).not.toContain(`"${entity.key}"`);
        expect(swift, entity.key).not.toContain(`"${entity.slug}"`);
        continue;
      }
      expect(swift, entity.key).toContain(`"${entity.key}"`);
      expect(swift, entity.key).toContain(`"${entity.slug}"`);
    }
  });

  it("accepts only canonical conversation UUIDs and rejects the ticket action", () => {
    expect(swift).toContain('"helpdesk-conversation"');
    expect(swift).not.toContain('"helpdesk-ticket"');
    expect(swift).toContain(
      'action != "helpdesk-conversation" || isCanonicalUUID(identifier)',
    );
    expect(swift).toContain(
      'parts[1] != "helpdesk" || isCanonicalUUID(parts[2])',
    );
  });

  it("does not persist notes, generic URLs, or legacy arbitrary text", () => {
    expect(swift).not.toMatch(/entry\s*\[\s*"note"\s*\]/);
    expect(swift).toContain("contentText is intentionally ignored");
    expect(swift).toContain("defaults.removeObject(forKey: legacySharedKey)");
    expect(bridge).toContain("Generic URLs are deliberately unsupported");
    expect(bridge).toContain("st.remove(LEGACY_SHARED_KEY)");
    expect(bridge).not.toContain('type: "openUrl"');
    expect(rootLayout).not.toContain("restoreSharedInboxItem");
  });
});

type AccessedApi = {
  NSPrivacyAccessedAPIType?: string;
  NSPrivacyAccessedAPITypeReasons?: string[];
};

type PrivacyManifest = {
  NSPrivacyTracking?: boolean;
  NSPrivacyTrackingDomains?: string[];
  NSPrivacyAccessedAPITypes?: AccessedApi[];
};

const USER_DEFAULTS_API = "NSPrivacyAccessedAPICategoryUserDefaults";
// 1C8F.1 is Apple's reason for defaults shared with the other members of an App
// Group. CA92.1 covers only defaults readable by the app ITSELF, which is not
// what a suite in group.com.moosewave.app is: the host app writes it through
// ExtensionStorage and both extensions read or write it.
const APP_GROUP_DEFAULTS_REASON = "1C8F.1";

/**
 * Executable Swift only, so a mention in a doc comment neither triggers nor
 * satisfies the rule. One left-to-right pass over string literals and both
 * comment forms means whichever opens first wins: a `/*` inside a `//` comment
 * cannot swallow the code after it, and the `//` in "moosewave://dashboard" is
 * not taken for a comment that hides the rest of its line.
 */
function executableSwift(src: string): string {
  return src.replace(/"(?:\\.|[^"\\\n])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, (m) =>
    m.startsWith('"') ? m : " ",
  );
}

function accessedApi(
  manifest: PrivacyManifest,
  type: string,
): AccessedApi | undefined {
  return manifest.NSPrivacyAccessedAPITypes?.find(
    (entry) => entry.NSPrivacyAccessedAPIType === type,
  );
}

/**
 * PO-2 — ITMS-91053 is checked per BINARY, not per app.
 *
 * App Store Connect scans every executable in the upload, including
 * PlugIns/PostwaveWidget.appex and PlugIns/PostwaveShare.appex. Each one that
 * references a required-reason API needs a PrivacyInfo.xcprivacy inside its
 * OWN bundle. The host app's manifest does not cover them: React Native's pod
 * aggregation writes only to `:application` targets, and @bacons/apple-targets
 * has no privacy-manifest handling at all. What it does have is a
 * PBXFileSystemSynchronizedRootGroup per target directory that excludes only
 * Info.plist and the config file, so a manifest placed in targets/<name>/ is
 * bundled into that .appex. That makes the file's presence the whole contract.
 *
 * Nothing local can observe the rejection — it arrives by email after upload —
 * which is why the rule lives here, and why mobile-release.yml checks the
 * compiled .appex bundles on a real Xcode build.
 */
describe("every app-extension binary that touches a required-reason API ships its own privacy manifest", () => {
  const plist = (
    createRequire(
      createRequire(require.resolve("expo/config-plugins")).resolve(
        "@expo/config-plugins",
      ),
    )("@expo/plist") as { default: { parse(xml: string): unknown } }
  ).default;

  const targetDirs = readdirSync(join(mobileRoot, "targets"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();

  const usesUserDefaults = targetDirs.filter((dir) => {
    const swift = readdirSync(join(mobileRoot, "targets", dir))
      .filter((file) => file.endsWith(".swift"))
      .sort()
      .map((file) => executableSwift(source(`targets/${dir}/${file}`)))
      .join("\n");
    return /\bUserDefaults\b/u.test(swift);
  });

  it("scans both extensions and finds UserDefaults in each (vacuity floor)", () => {
    expect(targetDirs).toEqual(expect.arrayContaining(["share", "widget"]));
    expect(usesUserDefaults).toEqual(
      expect.arrayContaining(["share", "widget"]),
    );
  });

  it.each(usesUserDefaults)(
    "targets/%s declares its UserDefaults use in its own PrivacyInfo.xcprivacy",
    (dir) => {
      const manifestPath = join(
        mobileRoot,
        "targets",
        dir,
        "PrivacyInfo.xcprivacy",
      );
      expect(
        existsSync(manifestPath),
        `targets/${dir} calls UserDefaults but has no PrivacyInfo.xcprivacy, so App Store Connect rejects its .appex with ITMS-91053`,
      ).toBe(true);

      const manifest = plist.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PrivacyManifest;
      expect(manifest.NSPrivacyTracking).toBe(false);
      // Tracking domains with NSPrivacyTracking false contradict each other.
      expect(manifest.NSPrivacyTrackingDomains ?? []).toEqual([]);
      expect(
        accessedApi(manifest, USER_DEFAULTS_API)?.NSPrivacyAccessedAPITypeReasons,
        `targets/${dir} must give the App Group reason for its shared suite`,
      ).toContain(APP_GROUP_DEFAULTS_REASON);
    },
  );

  it("declares the App Group reason for the host app, which writes the same suite", () => {
    // What prebuild writes into ios/Moosewave/PrivacyInfo.xcprivacy: Expo's own
    // merge of app.json's ios.privacyManifests. React Native's pod step later
    // unions its CA92.1 into the same entry, so declaring both here is safe.
    const { IOSConfig } = require("expo/config-plugins") as {
      IOSConfig: {
        PrivacyInfo: {
          mergePrivacyInfo(
            existing: Record<string, unknown>,
            privacyManifests: unknown,
          ): PrivacyManifest;
        };
      };
    };
    const appJson = JSON.parse(source("app.json")) as {
      expo?: { ios?: { privacyManifests?: unknown } };
    };
    const written = IOSConfig.PrivacyInfo.mergePrivacyInfo(
      {},
      appJson.expo?.ios?.privacyManifests ?? {},
    );
    expect(
      accessedApi(written, USER_DEFAULTS_API)?.NSPrivacyAccessedAPITypeReasons,
      "app.json ios.privacyManifests must declare UserDefaults with the App Group reason",
    ).toContain(APP_GROUP_DEFAULTS_REASON);
  });
});
