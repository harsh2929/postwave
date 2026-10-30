import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * DASHBOARD#47 — the widget's configuration contract.
 *
 * The metrics widget was a `StaticConfiguration`: everyone who placed it got
 * the same four numbers in the same order, and the Lock Screen circle was
 * hardwired to the approvals count. It is now an `AppIntentConfiguration`, so
 * the metric is chosen per placed instance from long-press → Edit Widget.
 *
 * Three things about that change are only true by CONVENTION — no compiler
 * checks any of them — so they are pinned here:
 *
 *  1. THE FLOOR. `AppIntentConfiguration` is iOS 17+, and `WidgetBundleBuilder`
 *     accepts no control flow, so the extension cannot carry an iOS-16 static
 *     widget beside it. Someone lowering `deploymentTarget` back to "16.0" in
 *     expo-target.config.js would not see a JS failure — they would see a
 *     native build break, days later, on a machine that is not theirs.
 *  2. THE METRIC SET. The Swift enum's cases are the four integers the JS
 *     writer publishes into the App Group. Adding a fifth case without adding
 *     the key is a widget that renders a number nobody ever wrote.
 *  3. THE KIND. The `kind` string is what WidgetKit uses to migrate an
 *     already-placed tile onto the new configuration. Change it and every
 *     home screen that has this widget goes blank.
 *
 * This suite reads source text on purpose: Swift and TypeScript have no shared
 * compiler, and the alternative is discovering the drift in a native build.
 */
function source(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8");
}

const swift = source("targets/widget/index.swift");
const targetConfig = source("targets/widget/expo-target.config.js");
const writer = source("src/lib/widgetData.ts");

/** The App Group keys the widget's metric cases must correspond to. */
const PUBLISHED_METRIC_KEYS = [
  "pw_widget_subs",
  "pw_widget_open_rate",
  "pw_widget_sent30d",
  "pw_widget_pending",
] as const;

/** Case names declared on the Swift `WidgetMetric` AppEnum. */
function metricCases(): string[] {
  const block = swift.slice(
    swift.indexOf("enum WidgetMetric: String, AppEnum"),
    swift.indexOf("static var typeDisplayRepresentation"),
  );
  return [...block.matchAll(/^\s*case\s+([A-Za-z0-9]+)\s*$/gm)].map(
    (m) => m[1] ?? "",
  );
}

describe("widget configuration contract", () => {
  it("configures the metrics widget with an app intent, not statically", () => {
    expect(swift).toContain("AppIntentConfiguration(");
    expect(swift).toContain("intent: PostwaveMetricsIntent.self");
    // The assertion is about THE METRICS WIDGET, named by its own provider.
    // It used to be "the bundle contains exactly one StaticConfiguration",
    // which coupled this contract to how many OTHER widgets the bundle
    // happens to ship: adding a third, deliberately-unconfigurable widget
    // (the commerce tile, the deliverability tile) failed a test about the
    // metrics tile, which is a false alarm and trains people to loosen the
    // guard. What must never come back is `Provider()` — the metrics
    // timeline provider — behind a static configuration.
    expect(swift).not.toMatch(/StaticConfiguration\(kind:[^)]*provider: Provider\(\)/);
    expect(swift).toContain(
      "AppIntentConfiguration(\n            kind: kind,\n            intent: PostwaveMetricsIntent.self,\n            provider: Provider()\n        )",
    );
    // Widgets that are deliberately NOT configurable stay static: each shows
    // one fixed set of totals with nothing to choose between.
    expect(swift).toContain("StaticConfiguration(kind: kind, provider: CommerceProvider())");
  });

  it("drives the timeline from the chosen configuration", () => {
    // An AppIntentConfiguration whose provider ignored the configuration would
    // compile, ship, and quietly render the same tile for everybody.
    expect(swift).toContain("struct Provider: AppIntentTimelineProvider");
    expect(swift).toContain("func timeline(\n        for configuration: PostwaveMetricsIntent,");
    expect(swift).toContain("let configuration: PostwaveMetricsIntent");
  });

  it("keeps the widget kind, so a placed tile migrates instead of blanking", () => {
    expect(swift).toContain('let kind = "PostwaveWidget"');
    expect(swift).toContain('let kind = "PostwaveCommerceWidget"');
  });

  it("declares an iOS 17 floor, which is what the intent API costs", () => {
    const declared = /deploymentTarget:\s*"(\d+)\.(\d+)"/.exec(targetConfig);
    expect(declared, "no deploymentTarget in expo-target.config.js").not.toBeNull();
    const major = Number(declared?.[1]);
    expect(
      major,
      "AppIntentConfiguration is iOS 17+ and WidgetBundleBuilder cannot branch on availability — lowering this floor breaks the native build, not this test",
    ).toBeGreaterThanOrEqual(17);
  });

  it("links AppIntents from both the target config and the source", () => {
    expect(targetConfig).toContain("AppIntents");
    expect(swift).toContain("import AppIntents");
  });

  it("offers exactly the metrics the JS writer publishes", () => {
    const cases = metricCases();
    expect(cases).toEqual(["subscribers", "openRate", "sent30d", "pending"]);
    // Same count, and every key is really written by the bridge.
    expect(cases).toHaveLength(PUBLISHED_METRIC_KEYS.length);
    for (const key of PUBLISHED_METRIC_KEYS) {
      expect(writer, `${key} is not written by widgetData.ts`).toContain(
        `st.set("${key}"`,
      );
      expect(swift, `${key} is not read by the widget`).toContain(key);
    }
  });

  it("gives every metric a picker entry, a caption, a tag and a noun", () => {
    for (const name of metricCases()) {
      // The edit sheet renders caseDisplayRepresentations; a case missing from
      // that dictionary is a blank row in the picker.
      expect(
        swift,
        `${name} has no caseDisplayRepresentations entry`,
      ).toContain(`.${name}: DisplayRepresentation(`);
    }
    // Four-character Lock Screen tags: the circle has room for nothing more,
    // and a bare digit there stopped being self-explanatory the moment the
    // metric became a choice.
    const abbreviations = [
      ...swift
        .slice(
          swift.indexOf("var abbreviation: String"),
          swift.indexOf("var noun: String"),
        )
        .matchAll(/return "([A-Z]+)"/g),
    ].map((m) => m[1] ?? "");
    expect(abbreviations).toHaveLength(metricCases().length);
    for (const tag of abbreviations) expect(tag).toHaveLength(4);
  });

  it("speaks the exact figure beside every compacted one", () => {
    // `compact()` renders 12_400 as "12.4k". VoiceOver must hear the number,
    // and an unmeasured open rate must not be spoken as zero.
    expect(swift).toContain("func spoken(for metric: WidgetMetric) -> String");
    expect(swift).toContain('"open rate not measured"');
    expect(swift).toContain("var spoken: String? = nil");
    expect(swift).toContain(".accessibilityLabel(Text(spoken ??");
  });

  it("adds no App Group key, so the disclosure being purged still purges everything", () => {
    // The selection lives in WidgetKit's own per-instance intent storage. If a
    // metric choice ever started being written into the shared container it
    // would outlive logout / app-lock / account teardown, all of which purge by
    // the key lists below and nothing else.
    const declared = swift.slice(
      swift.indexOf("private let widgetSnapshotKeys"),
      swift.indexOf("private func purgeSnapshotPreservingOptIn"),
    );
    for (const key of PUBLISHED_METRIC_KEYS) expect(declared).toContain(key);
    expect(declared).not.toMatch(/pw_widget_(headline|companion|chosen|selected)/);
    expect(writer).not.toMatch(/pw_widget_(headline|companion|chosen|selected)/);
  });
});
