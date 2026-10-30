/**
 * The sender-health record's JS ↔ Swift contract (DELIVERABILITY#64).
 *
 * Two readers, two binaries, no shared code:
 *   src/lib/widgetDeliverability.ts   writes it (app, JS)
 *   targets/widget/index.swift        renders it (WidgetKit extension)
 *
 * (Unlike the commerce record there is no App Intent copy — a Siri answer to
 * "how is my sender health" would need `plugins/PostwaveAppIntents.swift` to
 * grow a third reader, and this record has one writer and one renderer today.
 * If that changes, this file is where the third copy gets pinned.)
 *
 * The duplication is unavoidable — an extension and an app cannot share a Swift
 * file, and the writer is JavaScript — so this file is what stops the two
 * drifting. Every assertion below is a privacy or honesty regression if it
 * silently changes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WIDGET_DELIVERABILITY_KEYS } from "./widgetDeliverabilitySnapshot";

const mobileRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(mobileRoot, relativePath), "utf8");
}

const widget = source("targets/widget/index.swift");
const rules = source("src/lib/widgetDeliverabilitySnapshot.ts");
const bridge = source("src/lib/widgetDeliverability.ts");
const dashboardBridge = source("src/lib/widgetData.ts");
const background = source("src/hooks/useWidgetBackgroundRefresh.ts");

describe("sender-health widget record — key and marker contract", () => {
  it("spells every key identically in both readers", () => {
    for (const key of WIDGET_DELIVERABILITY_KEYS) {
      expect(bridge.includes(key) || rules.includes(key)).toBe(true);
      expect(widget).toContain(key);
    }
  });

  it("gates the record behind the SAME consent marker as the other two", () => {
    // A separate opt-in would be a second thing to revoke. There is one.
    expect(bridge).toContain("getWidgetMetricsEnabled()");
    expect(widget).toContain("defaults.integer(forKey: widgetOptInKey) == 1");
  });

  it("folds the keys into the one purge list", () => {
    // lib/widgetData.ts's WIDGET_DATA_KEYS is what app lock, sign-out, account
    // deletion and the Settings toggle all clear through.
    expect(dashboardBridge).toContain(
      'import { WIDGET_DELIVERABILITY_KEYS } from "./widgetDeliverabilitySnapshot"',
    );
    expect(dashboardBridge).toContain("...WIDGET_DELIVERABILITY_KEYS,");
  });

  it("requires the same ready + schema transaction markers on both sides", () => {
    expect(widget).toContain(
      'defaults.integer(forKey: "pw_widget_deliv_ready") == 1',
    );
    expect(widget).toContain(
      'defaults.integer(forKey: "pw_widget_deliv_schema") == deliverabilitySchemaVersion',
    );
    expect(widget).toContain("private let deliverabilitySchemaVersion = 1");
    expect(rules).toContain(
      "export const WIDGET_DELIVERABILITY_SCHEMA_VERSION = 1",
    );
    expect(bridge).toContain("st.set(WIDGET_DELIVERABILITY_READY_KEY, 0)");
    expect(bridge).toContain("st.set(WIDGET_DELIVERABILITY_READY_KEY, 1)");
  });

  it("applies the one twelve-hour disclosure window on both sides", () => {
    expect(rules).toContain(
      "export const WIDGET_DELIVERABILITY_TTL_MS = 12 * 60 * 60 * 1000",
    );
    expect(widget).toContain(
      "private let maxSnapshotAge: TimeInterval = 12 * 60 * 60",
    );
    // NATIVE#46 — bounded rather than zero, so a backwards clock step does not
    // purge a valid record. Shared with the dashboard and commerce records.
    expect(widget).toContain(
      "private let maxFutureClockSkew: TimeInterval = 120",
    );
    // Both ends of the window, on the deliverability record specifically.
    const start = widget.indexOf("struct DeliverabilitySnapshot");
    expect(start).toBeGreaterThan(0);
    const section = widget.slice(start);
    expect(section).toContain("age <= maxSnapshotAge");
    expect(section).toContain("declaredLifetime <= maxSnapshotAge + 1");
  });
});

describe("sender-health widget record — honesty contract", () => {
  it("refuses a grade the scorer cannot emit, on BOTH sides", () => {
    // parseDeliverabilityHub coerces a missing score to 0, so the grade is the
    // only thing standing between a schema drift and a home screen reading
    // "0 · Critical". Native re-checks it rather than trusting the writer.
    expect(rules).toContain(
      'export const DELIVERABILITY_GRADES = ["A", "B", "C", "D", "F"] as const',
    );
    expect(widget).toContain(
      'private let deliverabilityGrades: Set<String> = ["A", "B", "C", "D", "F"]',
    );
    expect(widget).toContain("deliverabilityGrades.contains(grade)");
  });

  it("always states the measurement time, and it is the SERVER's", () => {
    // computed_at, not Date.now() and not the arrival time: the hub query is
    // snapshot-backed, so an offline device replays an older score.
    const start = widget.indexOf("struct DeliverabilitySnapshot");
    const bundleStart = widget.indexOf("// MARK: - Bundle");
    const section = widget.slice(start, bundleStart);
    expect(section).toContain("func measuredAgo(at now: Date) -> String {");
    // No optional variant: unlike the dashboard snapshot, this record never
    // gets a freshness grace period in which it may omit its age.
    expect(section).not.toContain("-> String?");
    expect(section).toContain("Measured \\(snapshot.measuredAgo(at: now)).");
    expect(rules).toContain("export function computedAtMs");
    expect(background).toContain("measuredAtMs: computedAtMs(hub.computedAt)");
  });

  it("distinguishes 'never measured' from 'expired' from 'turned off'", () => {
    const start = widget.indexOf("struct DeliverabilitySnapshot");
    const section = widget.slice(start);
    for (const pin of ["case optedOut", "case neverMeasured", "case expired"]) {
      expect(section).toContain(pin);
    }
    expect(widget).toContain(
      '"Open Deliverability in Moosewave to publish your sender score."',
    );
  });

  it("says what the score was computed over, because it starts at 100", () => {
    // scoreHub subtracts from 100 (hub.go:420), so a workspace that has never
    // sent keeps every point it never risked. A bare "A" would read as proof.
    expect(widget).toContain('sends7d == 0 ? "no sends in 7 days"');
    expect(widget).toContain('"No sends in the last 7 days"');
  });

  it("states the auto-throttle in WORDS, never by tint alone", () => {
    expect(widget).toContain('"Sending throttled"');
    expect(widget).toContain(
      '"Moosewave has throttled sending for this workspace. "',
    );
    // The accessory families are monochrome; the circle carries a word.
    expect(widget).toContain('snapshot.throttled ? "THRTL" : snapshot.grade');
  });

  it("treats a zero breach count as a measurement, not a blank", () => {
    expect(widget).toContain('if snapshot.breaches == 0 { return "No thresholds tripped" }');
  });

  it("puts the grade word beside the score in every drawn family", () => {
    for (const pin of [
      // small + medium share DeliverabilityScore, which draws both.
      "struct DeliverabilityScore: View",
      // accessory rectangular / inline spell it inline.
      '"\\(snapshot.score) · \\(snapshot.grade) \\(snapshot.status)"',
    ]) {
      expect(widget).toContain(pin);
    }
  });

  it("redacts the values in protected previews", () => {
    const start = widget.indexOf("struct DeliverabilitySmallView");
    expect(start).toBeGreaterThan(0);
    const bundleStart = widget.indexOf("// MARK: - Bundle");
    const views = widget.slice(start, bundleStart);
    expect(views.match(/\.privacySensitive\(\)/g)?.length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it("speaks the exact send count, never the compacted one", () => {
    expect(widget).toContain(
      '"\\(snapshot.sends7d) sends in the last 7 days"',
    );
    expect(widget).toContain(
      'spoken: "Sends in the last 7 days: \\(snapshot.sends7d)"',
    );
  });
});

describe("sender-health widget record — reachability", () => {
  it("ships as its own widget and is registered in the bundle", () => {
    expect(widget).toContain("struct PostwaveDeliverabilityWidget: Widget");
    expect(widget).toContain("PostwaveDeliverabilityWidget()");
    // Exactly one entry point, on the bundle.
    expect(widget.match(/@main/g)?.length).toBe(1);
  });

  it("points every state at the screen that publishes the score", () => {
    expect(widget).toContain(
      'private let deliverabilityWidgetURL = "moosewave://deliverability"',
    );
    expect(widget).toContain(
      ".widgetURL(widgetDestination(deliverabilityWidgetURL))",
    );
    // Never force-unwrapped: a widget extension that traps is a blank tile the
    // user cannot recover from. (lib/widgetLinkContract.test.ts separately
    // proves the URL resolves to a real mobile route.)
    expect(widget).not.toMatch(/URL\(string:[^)]*\)!/);
  });

  it("keeps the background re-read gated on an already-published record", () => {
    // A wake refreshes what somebody asked to see; it does not speculatively
    // pull a workspace-health report onto a device that never opened the tab.
    expect(background).toContain("if (!hasPublishedDeliverabilityWidget()) return false;");
    // ...and a 403 purges rather than leaving a score somebody may no longer
    // read sitting on the home screen for another twelve hours.
    expect(background).toContain("clearDeliverabilityWidgetSnapshot();");
  });
});
