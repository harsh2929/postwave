/**
 * The App Intents ↔ App Group contract.
 *
 * `plugins/PostwaveAppIntents.swift` compiles into the MAIN app binary and
 * `targets/widget/index.swift` compiles into a WidgetKit extension, so the two
 * readers of the shared snapshot cannot share code. That duplication is
 * deliberate and unavoidable — this file is what stops it drifting.
 *
 * What is pinned, and why each one is a privacy or honesty regression if it
 * silently changes:
 *
 *  - The intent reads the SAME opt-in marker, schema version and ready marker
 *    the JS writer sets. Drop any one and Siri speaks numbers the user never
 *    consented to, or reads a torn write.
 *  - The intent applies the SAME twelve-hour disclosure window and zero
 *    future-clock-skew tolerance. Widen either and it recites expired figures.
 *  - The answering intent requires device authentication. Without it Siri will
 *    read a workspace's subscriber count aloud from a locked phone — there is
 *    no `.privacySensitive()` redaction for speech.
 *  - The answering intent does NOT open the app, because a status question
 *    answered by launching an app has not been answered.
 *  - Every route a navigational intent queues is one `validatePendingRoute`
 *    accepts. A rejection is silent — the app still foregrounds — so an
 *    unlisted route is indistinguishable from "the shortcut did nothing".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { validatePendingRoute } from "./pendingRoute";

// `pendingRoute` reaches for the App Group bridge at call time, not import
// time, but its module graph still pulls in react-native. Only the pure
// validator is under test here, so both natives are stubbed away.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@bacons/apple-targets", () => ({
  ExtensionStorage: class {
    get() {
      return null;
    }
    remove() {}
    static reloadWidget() {}
  },
}));

const mobileRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(mobileRoot, relativePath), "utf8");
}

/**
 * Swift line + block comments, removed so that PROSE naming a route cannot
 * stand in for a route the binary actually queues (and, worse, cannot make
 * this contract pass by describing a destination nobody ships).
 */
function stripSwiftComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

/** Every `/(tabs)/…` literal in executable Swift. */
function queuedRoutes(src: string): string[] {
  return [
    ...new Set(
      stripSwiftComments(src).match(/"(\/\(tabs\)\/[A-Za-z0-9\-_/]+)"/gu) ?? [],
    ),
  ].map((quoted) => quoted.slice(1, -1));
}

describe("Siri App Intents privacy contract", () => {
  const intents = source("plugins/PostwaveAppIntents.swift");
  const widget = source("targets/widget/index.swift");
  const bridge = source("src/lib/widgetData.ts");

  it("answers with a dialog rather than only navigating", () => {
    expect(intents).toContain("struct WorkspaceStatusIntent: AppIntent");
    expect(intents).toContain(
      "func perform() async throws -> some IntentResult & ProvidesDialog",
    );
    expect(intents).toContain(
      ".result(dialog: IntentDialog(stringLiteral: sentence))",
    );
  });

  it("keeps the answering intent out of the launch path", () => {
    const start = intents.indexOf("struct WorkspaceStatusIntent");
    const end = intents.indexOf("struct PostwaveShortcuts");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = intents.slice(start, end);
    expect(body).toContain("static var openAppWhenRun = false");
    expect(body).not.toContain("queueRoute(");
  });

  it("refuses to speak from a locked device", () => {
    expect(intents).toContain(
      "static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication",
    );
  });

  it("reads the same opt-in, schema and transaction markers as the widget", () => {
    for (const pin of [
      'private let widgetOptInKey = "pw_widget_metrics_opt_in_v1"',
      "private let widgetSchemaVersion = 1",
      'defaults.integer(forKey: "pw_widget_ready") == 1',
      'defaults.integer(forKey: "pw_widget_schema") == widgetSchemaVersion',
    ]) {
      expect(intents).toContain(pin);
      expect(widget).toContain(pin);
    }
    expect(bridge).toContain(
      'const WIDGET_OPT_IN_KEY = "pw_widget_metrics_opt_in_v1"',
    );
    expect(bridge).toContain("const WIDGET_SCHEMA_VERSION = 1");
  });

  it("applies the same freshness and disclosure windows as the widget", () => {
    for (const pin of [
      "private let freshSnapshotAge: TimeInterval = 15 * 60",
      "private let maxSnapshotAge: TimeInterval = 12 * 60 * 60",
      // NATIVE#46 — 0 purged a valid snapshot on any backwards clock step.
      // The two readers must carry the SAME allowance or Siri and the widget
      // disagree about whether the device's numbers still exist.
      "private let maxFutureClockSkew: TimeInterval = 120",
    ]) {
      expect(intents).toContain(pin);
      expect(widget).toContain(pin);
    }
    expect(bridge).toContain(
      "export const WIDGET_SNAPSHOT_FRESH_MS = 15 * 60 * 1000",
    );
    expect(bridge).toContain(
      "export const WIDGET_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000",
    );
  });

  it("distinguishes 'turned off' from 'expired' instead of one silence", () => {
    // Same rule the widget applies visually: "Metrics hidden" and "Data
    // expired" are different facts and only one of them is the user's choice.
    expect(intents).toContain("case disabled");
    expect(intents).toContain("case expired");
    expect(intents).toContain("Moosewave metrics are turned off");
    expect(intents).toContain("doesn't have recent numbers on this device");
  });

  it("states a stale measurement's age rather than speaking it as current", () => {
    expect(intents).toContain("func spokenAge(_ ageSeconds: TimeInterval)");
    expect(intents).toContain("guard ageSeconds >= freshSnapshotAge else { return nil }");
    expect(intents).toContain('sentence += " Measured \\(age)."');
  });

  it("registers a spoken phrase for the answering intent", () => {
    expect(intents).toContain("intent: WorkspaceStatusIntent()");
    expect(intents).toContain('"How is \\(.applicationName) doing"');
  });

  /**
   * NATIVE#6's second half. A dialog-only intent talks to Siri; an intent that
   * RETURNS a value is a building block other shortcuts can compose. The pins
   * below are the three ways that upgrade can silently become a liability.
   */
  describe("the value-returning metric intent", () => {
    const start = intents.indexOf("struct WorkspaceMetricIntent");
    const body = intents.slice(
      start,
      intents.indexOf("struct PostwaveShortcuts"),
    );

    it("hands the number to Shortcuts, not just to Siri's voice", () => {
      expect(start).toBeGreaterThan(0);
      expect(body).toContain(
        "func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog",
      );
      expect(body).toContain("return .result(value: value, dialog:");
    });

    it("is parameterized by a metric rather than being four near-identical intents", () => {
      expect(intents).toContain("enum PostwaveMetric: String, AppEnum");
      expect(body).toContain("@Parameter(title: \"Metric\")");
      expect(body).toContain("var metric: PostwaveMetric");
    });

    it("THROWS for the unavailable states instead of returning a fabricated 0", () => {
      // The whole risk of a typed return: `Int` cannot say "metrics are off"
      // or "these lapsed", and a 0 would flow into whatever automation
      // consumes the value as though it were a measurement.
      expect(body).toContain("throw PostwaveMetricUnavailable.disabled");
      expect(body).toContain("throw PostwaveMetricUnavailable.expired");
      expect(body).not.toContain("value: 0");
      expect(intents).toContain(
        "struct PostwaveMetricUnavailable: Error, CustomLocalizedStringResourceConvertible",
      );
    });

    it("inherits the dialog intents' privacy posture exactly", () => {
      expect(body).toContain("static var openAppWhenRun = false");
      expect(body).toContain(
        "static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication",
      );
      // Reads the SAME validated snapshot — it must not introduce a second
      // source of workspace data outside the app's auth gate.
      expect(body).toContain("StatusSnapshot.load()");
      expect(body).not.toContain("UserDefaults(");
    });

    it("registers the pending-approvals question as its own phrase", () => {
      expect(intents).toContain("intent: PendingApprovalsIntent()");
      expect(intents).toContain(
        '"How many \\(.applicationName) approvals are pending"',
      );
      // The metric is still pre-bound — Siri cannot prompt for an enum inside a
      // voice shortcut — but the binding now happens INSIDE a dedicated intent
      // type instead of in a factory function passed to AppShortcut. See the
      // "AppShortcut initializers" contract below for why that is not a style
      // preference: the factory form did not build.
      expect(intents).toContain("struct PendingApprovalsIntent: AppIntent");
      expect(intents).toContain("postwaveMetricResult(.pendingApprovals)");
    });

    it("gives the pre-bound intent the same posture as the parameterised one", () => {
      // A second intent type means a second copy of the privacy statics; the
      // shared perform() below means only ONE copy of the absence rules.
      const start = intents.indexOf("struct PendingApprovalsIntent");
      const pending = intents.slice(start);
      expect(start).toBeGreaterThan(0);
      expect(pending).toContain("static var openAppWhenRun = false");
      expect(pending).toContain(
        "static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication",
      );
      // Not a second reader of the snapshot, and not a second copy of the
      // "absence is not zero" rules.
      expect(pending).not.toContain("StatusSnapshot.load()");
      expect(pending).not.toContain("UserDefaults(");
      expect(intents).toContain(
        "private func postwaveMetricResult(\n    _ metric: PostwaveMetric\n) async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {",
      );
    });

    it("states a stale value's age, like every other spoken number", () => {
      expect(intents).toContain('sentence += " Measured \\(age)."');
      expect(intents).toContain("if let age = spokenAge(figures.ageSeconds) {");
    });

    /**
     * DASHBOARD#72 in its most dangerous form. A drawn em-dash is at least
     * visibly not-a-number; a typed `Int` handed to a Home Automation is
     * indistinguishable from a measurement, and speech has no em-dash at all.
     */
    it("throws rather than returning an unmeasured figure as a number", () => {
      expect(intents).toContain("static let notMeasured = PostwaveMetricUnavailable(");
      for (const flag of ["subsKnown", "openRateKnown", "sent30dKnown"]) {
        expect(
          body,
          `${flag} is not checked before the value is returned`,
        ).toContain(`guard figures.${flag} else {`);
      }
      expect(
        body.match(/throw PostwaveMetricUnavailable\.notMeasured/g)?.length,
      ).toBe(3);
    });
  });

  /**
   * The App Group markers this reader shares with the widget. Siri speaking
   * "a 0 percent open rate" about a workspace whose stats payload simply
   * omitted the field is the most convincing form the lie can take.
   */
  it("reads the same absence markers the widget and the writer use", () => {
    for (const key of [
      "pw_widget_subs_known",
      "pw_widget_open_rate_known",
      "pw_widget_sent30d_known",
    ]) {
      expect(intents, `${key} is not read by the intents`).toContain(key);
      expect(widget, `${key} is not read by the widget`).toContain(key);
      expect(bridge, `${key} is not written by the bridge`).toContain(
        `st.set("${key}"`,
      );
    }
    // Both readers fall back the same way for a snapshot written before the
    // markers existed; disagreeing here means Siri and the widget describe the
    // same container differently.
    for (const swift of [intents, widget]) {
      expect(swift).toContain("func measuredFlag(");
      expect(swift).toContain("legacyMeaning: openRate > 0");
    }
  });

  it("drops an unmeasured figure from the spoken sentence", () => {
    expect(intents).toContain("if figures.subsKnown {");
    expect(intents).toContain("if figures.openRateKnown {");
    expect(intents).toContain("if figures.sent30dKnown {");
    // The all-absent case is its own sentence, and it is not "expired".
    expect(intents).toContain("Moosewave hasn't measured");
    expect(intents).toContain("func spokenList(");
  });
});

/**
 * The routing half of the same contract.
 *
 * A navigational intent stashes a route in the App Group and lets iOS
 * foreground the app; `validatePendingRoute` then decides whether to honour it.
 * A rejection produces NO error and NO screen — the app comes forward on
 * whatever tab it was last on — so an intent whose route is missing from the
 * allow-list is indistinguishable from "Siri ignored me". Two shipped that way
 * ("Show Moosewave stores" → /(tabs)/commerce, "Show Moosewave deliverability" →
 * /(tabs)/deliverability): the Swift was added, the allow-list was not, and
 * nothing anywhere said so.
 *
 * Reading the literals out of the Swift is what makes this non-optional: adding
 * an intent without extending the allow-list now fails here.
 *
 * IT USED TO BE A ONE-WAY GUARD, and the reason given was wrong. The note here
 * read: "App Intents are only one writer of a pending route. Deep links and
 * notification taps queue routes too, so `/(tabs)/subscribers` is legitimately
 * allowed while no Swift file mentions it." They do not. `pw_pending_route` has
 * exactly TWO writers in the repository — `queueRoute` in this file and the
 * `UserDefaults(suiteName:)` write in targets/widget/ScanControl.swift — and
 * both are Swift. Deep links and notification taps navigate through
 * `routeForEntityLink` / `routeForNotification` and `router.push`; they never
 * touch the App Group. `takePendingRoute` (src/hooks/useSharedInboxRouting.ts)
 * is the only reader.
 *
 * So an allow-listed route no intent queues is not "reserved for another
 * writer" — it is unreachable, in exactly the way the two dead intents were
 * unreachable, only inverted. `/(tabs)/subscribers`, `/(tabs)/search` and
 * `/(tabs)/notifications` sat there for three releases. The guard now runs BOTH
 * ways: an intent may not queue what the allow-list rejects, and the allow-list
 * may not list what nothing produces.
 */
/**
 * The allow-list literals, read out of `pendingRoute.ts` rather than imported.
 *
 * Same reason the Swift is read as text: `ALLOWED_ROUTES` is a module-private
 * Set, and exporting it purely to be asserted would widen the module's public
 * surface (scripts/check-export-budgets.mjs) for a test's convenience. Only the
 * `new Set<string>([...])` initialiser is scanned, so prose above it naming a
 * route cannot stand in for a route the validator actually accepts.
 */
function allowedPendingRoutes(): string[] {
  const src = source("src/lib/pendingRoute.ts");
  const block = /const ALLOWED_ROUTES = new Set<string>\(\[([\s\S]*?)\]\)/u.exec(
    src,
  );
  if (!block) return [];
  return (block[1]?.match(/"(\/\(tabs\)\/[A-Za-z0-9\-_/]+)"/gu) ?? []).map(
    (quoted) => quoted.slice(1, -1),
  );
}

describe("App Intents route allow-list", () => {
  const writers = {
    "plugins/PostwaveAppIntents.swift": source(
      "plugins/PostwaveAppIntents.swift",
    ),
    "targets/widget/ScanControl.swift": source(
      "targets/widget/ScanControl.swift",
    ),
  };

  it("finds the queued routes at all", () => {
    // Vacuity floor. If queueRoute is renamed, the route literals move into a
    // constant table, or the file is relocated, the scan below would pass
    // while inspecting nothing.
    const intentRoutes = queuedRoutes(writers["plugins/PostwaveAppIntents.swift"]);
    expect(intentRoutes).toContain("/(tabs)/dashboard");
    expect(intentRoutes.length).toBeGreaterThanOrEqual(5);
    expect(queuedRoutes(writers["targets/widget/ScanControl.swift"])).toEqual([
      "/(tabs)/scan",
    ]);
  });

  it("can fail — an unlisted route is not silently accepted", () => {
    // The guard's own falsifiability check: the extractor must see a route the
    // validator rejects, or every assertion above is unfalsifiable.
    const synthetic = 'queueRoute("/(tabs)/settings")';
    expect(queuedRoutes(synthetic)).toEqual(["/(tabs)/settings"]);
    expect(validatePendingRoute("/(tabs)/settings")).toBeNull();
  });

  it("honours every route the native side queues", () => {
    for (const [file, src] of Object.entries(writers)) {
      for (const route of queuedRoutes(src)) {
        expect(
          validatePendingRoute(route),
          `${file} queues ${route}, which validatePendingRoute rejects — the shortcut foregrounds the app and lands nowhere. Add it to ALLOWED_ROUTES in src/lib/pendingRoute.ts, or stop queueing it.`,
        ).toBe(route);
      }
    }
  });

  it("allows no route that nothing produces", () => {
    // The other direction. `pw_pending_route` has exactly two writers, both
    // listed above, so an allow-listed route with no producer can never
    // arrive — it is a destination the app promises itself and never reaches.
    const produced = new Set(
      Object.values(writers).flatMap((src) => queuedRoutes(src)),
    );
    // Vacuity floor: an extractor that found nothing would make the loop below
    // pass by iterating zero times.
    expect(produced.size).toBeGreaterThanOrEqual(6);
    const allowed = allowedPendingRoutes();
    // Second vacuity floor: a renamed constant would make the loop empty.
    expect(allowed.length).toBeGreaterThanOrEqual(9);
    for (const route of allowed) {
      expect(
        produced.has(route),
        `${route} is in ALLOWED_ROUTES (src/lib/pendingRoute.ts) but no Swift writer ever queues it, so nothing can ever navigate there. Add an App Intent that queues it, or drop it from the allow-list.`,
      ).toBe(true);
    }
  });

  it("keeps the two intents that shipped dead wired up", () => {
    // Named explicitly so removing them from the allow-list cannot be mistaken
    // for tidying: each one is a Siri phrase a user can already invoke.
    expect(validatePendingRoute("/(tabs)/commerce")).toBe("/(tabs)/commerce");
    expect(validatePendingRoute("/(tabs)/deliverability")).toBe(
      "/(tabs)/deliverability",
    );
    expect(writers["plugins/PostwaveAppIntents.swift"]).toContain(
      "struct OpenCommerceIntent: AppIntent",
    );
    expect(writers["plugins/PostwaveAppIntents.swift"]).toContain(
      "struct OpenDeliverabilityIntent: AppIntent",
    );
  });
});

/**
 * F02 — the half of this contract that is not about what the app SAYS but
 * about whether the app can be built at all.
 *
 * `npx expo prebuild -p ios --clean` (what EAS runs) regenerates ios/ from
 * scratch, and the regenerated project failed to compile for two independent
 * reasons, neither of which any test in this file could see:
 *
 *   1. The app target came back at Expo's template default,
 *      IPHONEOS_DEPLOYMENT_TARGET = 15.1, while every declaration in
 *      PostwaveAppIntents.swift is `@available(iOS 16.0, *)`:
 *        error: 'LocalizedStringResource' is only available in iOS 16 or newer
 *   2. Apple's `appintentsmetadataprocessor` parses `AppShortcut(intent:)`
 *      STATICALLY. The pending-approvals shortcut passed a function call, so:
 *        error: Expected an initialization of an 'AppIntent' class, but got
 *               unrecognized syntax instead
 *        appintentsmetadataprocessor: At least one halting error produced
 *
 * Both are properties of source that no compiler this repo runs will check —
 * ios/ is generated and gitignored, so a green tsc, a green vitest run and a
 * green jest run all said nothing about either. That is exactly the shape of
 * defect this file exists to catch, so both are pinned here.
 */

/**
 * The expression each `AppShortcut(intent:)` is handed, read out of executable
 * Swift. Comments are stripped first for the same reason as everywhere else in
 * this file: prose describing a shortcut must not be able to stand in for one.
 */
function shortcutIntentExpressions(src: string): string[] {
  return [
    ...stripSwiftComments(src).matchAll(/AppShortcut\(\s*intent:\s*([^,\n]+),/gu),
  ].map((match) => (match[1] ?? "").trim());
}

/** Every `struct X: AppIntent` the file actually declares. */
function declaredIntentTypes(src: string): Set<string> {
  return new Set(
    [
      ...stripSwiftComments(src).matchAll(/struct ([A-Za-z0-9_]+): AppIntent/gu),
    ].map((match) => match[1] ?? ""),
  );
}

describe("AppShortcut initializers the metadata processor can parse", () => {
  const intents = source("plugins/PostwaveAppIntents.swift");

  it("finds the shortcut initializers at all", () => {
    // Vacuity floor. A renamed provider, a shortcut list moved into a helper,
    // or a reformatted `AppShortcut(` would make the loop below iterate over
    // nothing and pass while inspecting nothing.
    const used = shortcutIntentExpressions(intents);
    expect(used).toContain("WorkspaceStatusIntent()");
    // AppShortcutsProvider registers at most ten per app and this file ships
    // exactly ten — see the note on the last one.
    expect(used).toHaveLength(10);
    expect(declaredIntentTypes(intents).size).toBeGreaterThanOrEqual(10);
  });

  it("passes a literal initializer of a declared intent type, never a call", () => {
    // THE BUILD-BREAKING ONE. `AppShortcut(intent: pendingApprovalsIntent())`
    // — a factory returning a pre-bound WorkspaceMetricIntent — is valid Swift
    // and runs correctly; appintentsmetadataprocessor rejects it anyway,
    // because it reads this expression as syntax rather than evaluating it,
    // and a halting error there fails the whole build.
    const declared = declaredIntentTypes(intents);
    for (const expression of shortcutIntentExpressions(intents)) {
      const type = /^([A-Za-z0-9_]+)\(\)$/u.exec(expression)?.[1];
      expect(
        type,
        `AppShortcut(intent: ${expression}) is not a literal \`SomeIntent()\` initializer. appintentsmetadataprocessor parses this position statically and halts the build with "Expected an initialization of an 'AppIntent' class, but got unrecognized syntax instead". Pre-bind inside a dedicated AppIntent type instead.`,
      ).toBeDefined();
      expect(
        declared.has(type ?? ""),
        `AppShortcut(intent: ${expression}) names ${type}, which is not declared as \`struct ${type}: AppIntent\` in this file — so it is a function call dressed as an initializer, and the metadata processor will halt the build on it.`,
      ).toBe(true);
    }
  });

  it("can fail — a factory call is not silently accepted", () => {
    // The guard's own falsifiability check, in the exact shape that shipped.
    const synthetic = `
      AppShortcut(
          intent: pendingApprovalsIntent(),
          phrases: ["x"],
          shortTitle: "y",
          systemImageName: "z"
      )`;
    expect(shortcutIntentExpressions(synthetic)).toEqual([
      "pendingApprovalsIntent()",
    ]);
    expect(declaredIntentTypes(intents).has("pendingApprovalsIntent")).toBe(
      false,
    );
  });
});

/**
 * The iOS floor, enforced by the plugin that creates the need for it.
 *
 * Driven through `raiseDeploymentTarget` against a pbxproj-shaped object
 * rather than asserted as text, because what matters is the mutation the mod
 * performs on a REGENERATED project — including the three ways it could be
 * wrong in the other direction: lowering a target that is already higher,
 * touching an extension target, or not being idempotent across prebuilds.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const appIntentsPlugin = require("../../plugins/withAppIntents.js") as {
  (config: unknown): {
    mods?: { ios?: Record<string, (cfg: unknown) => unknown> };
  };
  raiseDeploymentTarget: (
    project: unknown,
    targetName: string,
    minimum?: string,
  ) => string[] | null;
  MIN_APP_DEPLOYMENT_TARGET: string;
};

type BuildConfig = {
  name: string;
  buildSettings: Record<string, string>;
};

/**
 * The shape `xcode`'s pbxproj sections really have: plain objects keyed by
 * UUID, with a `<UUID>_comment` sibling for every entry.
 */
function fakeProject(versions: Record<string, string>) {
  const targets: Record<string, unknown> = {};
  const lists: Record<string, unknown> = {};
  const configs: Record<string, BuildConfig> = {};
  for (const [target, version] of Object.entries(versions)) {
    for (const variant of ["Debug", "Release"]) {
      configs[`CFG_${target}_${variant}`] = {
        name: variant,
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: version },
      };
    }
    targets[`TGT_${target}`] = {
      name: target,
      buildConfigurationList: `LIST_${target}`,
    };
    targets[`TGT_${target}_comment`] = target;
    lists[`LIST_${target}`] = {
      buildConfigurations: [
        { value: `CFG_${target}_Debug` },
        { value: `CFG_${target}_Release` },
      ],
    };
    lists[`LIST_${target}_comment`] = target;
  }
  const added: string[] = [];
  return {
    pbxNativeTargetSection: () => targets,
    pbxXCConfigurationList: () => lists,
    pbxXCBuildConfigurationSection: () => configs,
    // The rest of the `xcode` surface the mod touches, so the whole mod can be
    // driven and not just the helper.
    hasFile: () => false,
    findTargetKey: (name: string) =>
      targets[`TGT_${name}`] ? `TGT_${name}` : null,
    findPBXGroupKey: () => undefined,
    addSourceFile: (relPath: string) => added.push(relPath),
    added,
    deploymentTarget: (target: string, variant: string) =>
      configs[`CFG_${target}_${variant}`]?.buildSettings
        .IPHONEOS_DEPLOYMENT_TARGET,
  };
}

describe("the app target's iOS deployment floor", () => {
  const intents = source("plugins/PostwaveAppIntents.swift");

  it("raises the floor through the mod prebuild actually runs", async () => {
    // Not the helper in isolation: the `ios.xcodeproj` mod itself, because a
    // correct helper that nothing calls raises nothing. It also has to run
    // BEFORE the "file already referenced" early return — a non-clean prebuild
    // keeps the file reference and still hands back a 15.1 target.
    const project = fakeProject({ Moosewave: "15.1" });
    const configured = appIntentsPlugin({ name: "Moosewave", slug: "postwave" });
    const mod = configured.mods?.ios?.xcodeproj;
    expect(mod).toBeTypeOf("function");
    await mod?.({
      modResults: project,
      modRequest: {
        projectName: "Moosewave",
        platformProjectRoot: "/nonexistent/ios",
        projectRoot: "/nonexistent",
      },
    });
    expect(project.deploymentTarget("Moosewave", "Debug")).toBe("16.0");
    expect(project.deploymentTarget("Moosewave", "Release")).toBe("16.0");
    expect(project.added).toEqual(["Moosewave/PostwaveAppIntents.swift"]);
  });

  it("raises Expo's 15.1 template default to the App Intents floor", () => {
    // THE OTHER BUILD-BREAKING ONE. Every prebuild --clean regenerates the app
    // target at 15.1; the Swift this plugin injects into it is iOS 16 only.
    const project = fakeProject({ Moosewave: "15.1", PostwaveWidget: "17.0" });
    const changed = appIntentsPlugin.raiseDeploymentTarget(project, "Moosewave");

    expect(changed).toEqual(["Debug", "Release"]);
    expect(project.deploymentTarget("Moosewave", "Debug")).toBe("16.0");
    expect(project.deploymentTarget("Moosewave", "Release")).toBe("16.0");
  });

  it("leaves the widget's deliberate 17.0 alone", () => {
    // targets/widget/expo-target.config.js picks 17.0 because its
    // AppIntentConfiguration widget needs it, and WidgetBundleBuilder accepts
    // no `if #available`. Lowering it would break the widget's own intent.
    const project = fakeProject({ Moosewave: "15.1", PostwaveWidget: "17.0" });
    appIntentsPlugin.raiseDeploymentTarget(project, "Moosewave");
    expect(project.deploymentTarget("PostwaveWidget", "Debug")).toBe("17.0");
    expect(project.deploymentTarget("PostwaveWidget", "Release")).toBe("17.0");
  });

  it("never lowers a target that already asks for more", () => {
    const project = fakeProject({ Moosewave: "17.0" });
    expect(appIntentsPlugin.raiseDeploymentTarget(project, "Moosewave")).toEqual(
      [],
    );
    expect(project.deploymentTarget("Moosewave", "Debug")).toBe("17.0");
  });

  it("is idempotent across prebuilds", () => {
    // `expo prebuild` re-runs mods; a mod that is not idempotent is a
    // build-breaking property, not a nicety.
    const project = fakeProject({ Moosewave: "15.1" });
    expect(
      appIntentsPlugin.raiseDeploymentTarget(project, "Moosewave"),
    ).toHaveLength(2);
    expect(appIntentsPlugin.raiseDeploymentTarget(project, "Moosewave")).toEqual(
      [],
    );
    expect(project.deploymentTarget("Moosewave", "Debug")).toBe("16.0");
  });

  it("reports rather than silently skipping a missing target", () => {
    // A silently unraised floor surfaces minutes later as a compiler error in
    // a build log, attributed to the Swift rather than to the mod that failed.
    const project = fakeProject({ Moosewave: "15.1" });
    expect(
      appIntentsPlugin.raiseDeploymentTarget(project, "SomeOtherApp"),
    ).toBeNull();
  });

  it("keeps the floor at or above every availability the Swift declares", () => {
    // The bidirectional half: adding an iOS 17 API to PostwaveAppIntents.swift
    // without moving the floor would reintroduce the same build failure with a
    // different symbol name.
    const floor = Number.parseFloat(appIntentsPlugin.MIN_APP_DEPLOYMENT_TARGET);
    expect(floor).toBeGreaterThanOrEqual(16);

    const declared = [
      ...stripSwiftComments(intents).matchAll(/@available\(iOS ([0-9.]+), \*\)/gu),
    ].map((match) => Number.parseFloat(match[1] ?? "0"));
    // Vacuity floor: the file is entirely @available-annotated.
    expect(declared.length).toBeGreaterThanOrEqual(10);
    for (const version of declared) {
      expect(version).toBeLessThanOrEqual(floor);
    }
  });
});
