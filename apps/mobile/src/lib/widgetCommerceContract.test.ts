/**
 * The commerce record's JS ↔ Swift ↔ Swift contract (COMMERCE#70).
 *
 * Three readers, three binaries, no shared code:
 *   src/lib/widgetCommerce.ts        writes it (app, JS)
 *   targets/widget/index.swift       renders it (WidgetKit extension)
 *   plugins/PostwaveAppIntents.swift speaks it (app binary, Swift)
 *
 * The duplication is unavoidable — an extension and an app cannot share a Swift
 * file, and the writer is JavaScript — so this file is what stops the three
 * drifting. Every assertion below is a privacy or honesty regression if it
 * silently changes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WIDGET_COMMERCE_KEYS } from "./widgetCommerceSnapshot";

const mobileRoot = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(mobileRoot, relativePath), "utf8");
}

const widget = source("targets/widget/index.swift");
const intents = source("plugins/PostwaveAppIntents.swift");
const rules = source("src/lib/widgetCommerceSnapshot.ts");
const bridge = source("src/lib/widgetCommerce.ts");
const dashboardBridge = source("src/lib/widgetData.ts");

describe("commerce widget record — key and marker contract", () => {
  it("spells every key identically in all three readers", () => {
    for (const key of WIDGET_COMMERCE_KEYS) {
      expect(bridge.includes(key) || rules.includes(key)).toBe(true);
      // The store id is never rendered or spoken, so only the widget's purge
      // list mentions it on the native side.
      if (key === "pw_widget_commerce_store_id") {
        expect(widget).toContain(key);
        continue;
      }
      expect(widget).toContain(key);
      expect(intents).toContain(key);
    }
  });

  it("gates the record behind the SAME consent marker as the dashboard one", () => {
    // A separate opt-in would be a second thing to revoke. There is one.
    expect(bridge).toContain("getWidgetMetricsEnabled()");
    expect(widget).toContain("defaults.integer(forKey: widgetOptInKey) == 1");
    expect(intents).toContain("defaults.integer(forKey: widgetOptInKey) == 1");
  });

  it("folds the commerce keys into the one purge list", () => {
    // lib/widgetData.ts's WIDGET_DATA_KEYS is what app lock, sign-out, account
    // deletion and the Settings toggle all clear through.
    expect(dashboardBridge).toContain(
      'import { WIDGET_COMMERCE_KEYS } from "./widgetCommerceSnapshot"',
    );
    expect(dashboardBridge).toContain("...WIDGET_COMMERCE_KEYS,");
  });

  it("requires the same ready + schema transaction markers on both native sides", () => {
    for (const pin of [
      'defaults.integer(forKey: "pw_widget_commerce_ready") == 1',
      'defaults.integer(forKey: "pw_widget_commerce_schema") == commerceSchemaVersion',
      "private let commerceSchemaVersion = 1",
    ]) {
      expect(widget).toContain(pin);
      expect(intents).toContain(pin);
    }
    expect(rules).toContain("export const WIDGET_COMMERCE_SCHEMA_VERSION = 1");
    expect(bridge).toContain("st.set(WIDGET_COMMERCE_READY_KEY, 0)");
    expect(bridge).toContain("st.set(WIDGET_COMMERCE_READY_KEY, 1)");
  });

  it("applies one twelve-hour disclosure window in all four files", () => {
    expect(rules).toContain(
      "export const WIDGET_COMMERCE_TTL_MS = 12 * 60 * 60 * 1000",
    );
    expect(dashboardBridge).toContain(
      "export const WIDGET_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000",
    );
    // Both native readers re-validate against the SAME constants the dashboard
    // record uses, including the bounded tolerance for a clock that stepped
    // backwards (NATIVE#46 — it was 0, which purged a valid record on any NTP
    // correction). The commerce record shares the constant, so it must share
    // the number.
    for (const swift of [widget, intents]) {
      expect(swift).toContain(
        "private let maxSnapshotAge: TimeInterval = 12 * 60 * 60",
      );
      expect(swift).toContain(
        "private let maxFutureClockSkew: TimeInterval = 120",
      );
      expect(swift).toContain("age <= maxSnapshotAge");
      expect(swift).toContain("declaredLifetime <= maxSnapshotAge + 1");
    }
  });
});

describe("commerce widget record — honesty contract", () => {
  it("always states the measurement time; there is no fresh window", () => {
    // The dashboard snapshot may hide its age while a live poll is writing it.
    // Nothing polls a store, so this record never gets that grace.
    expect(widget).toContain("func measuredAgo(at now: Date) -> String");
    expect(widget).not.toContain("func measuredAgo(at now: Date) -> String?");
    expect(widget).toContain("Measured \\(snapshot.measuredAgo(at: now))");
    expect(intents).toContain(
      "private func spokenMeasurementAge(_ ageSeconds: TimeInterval) -> String",
    );
    expect(intents).toContain('+ "Measured \\(spokenMeasurementAge(ageSeconds))."');
  });

  it("distinguishes 'never measured' from 'expired' from 'turned off'", () => {
    // Three different facts, and only one of them is the user's choice. The
    // "never measured" case is the one the phone can actually act on, and it
    // says so: these numbers come from the Stores tab.
    for (const pin of ["case optedOut", "case neverMeasured", "case expired"]) {
      expect(widget).toContain(pin);
    }
    expect(widget).toContain(
      '"Open Stores in Moosewave to publish a store\'s totals."',
    );
    expect(intents).toContain("case neverMeasured");
    expect(intents).toContain("hasn't saved any store numbers on this device yet");
    expect(intents).toContain("have expired");
  });

  it("labels the figure all-time, because the query has no date predicate", () => {
    // Repo.Analytics sums every ingested order (repo.go:2576-2584). A bare
    // "Revenue" on a home screen reads as today's.
    expect(widget).toContain('label: "All-time revenue"');
    expect(widget).toContain("orders, all time");
    expect(intents).toContain("all time.");
  });

  it("never hard-codes a currency symbol on either native side", () => {
    for (const swift of [widget, intents]) {
      expect(swift).toContain("formatter.numberStyle = .currency");
      expect(swift).toContain("formatter.currencyCode = code");
    }
    // The JS side publishes the code the integration reported and nothing else.
    expect(rules).toContain("export function normalizeWidgetCurrency");
  });

  it("redacts the values in protected previews and refuses to speak when locked", () => {
    const commerceStart = widget.indexOf("struct CommerceSmallView");
    expect(commerceStart).toBeGreaterThan(0);
    const commerceViews = widget.slice(commerceStart);
    expect(
      commerceViews.match(/\.privacySensitive\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    const storeIntentStart = intents.indexOf("struct StoreStatusIntent");
    const shortcutsStart = intents.indexOf("struct PostwaveShortcuts");
    expect(storeIntentStart).toBeGreaterThan(0);
    expect(shortcutsStart).toBeGreaterThan(storeIntentStart);
    const storeIntent = intents.slice(storeIntentStart, shortcutsStart);
    expect(storeIntent).toContain(
      "static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication",
    );
    // A status question answered by launching an app has not been answered.
    expect(storeIntent).toContain("static var openAppWhenRun = false");
    expect(storeIntent).not.toContain("queueRoute(");
  });

  it("speaks the exact order count, never the compacted one", () => {
    // "3.1k orders" is a shape, not a quantity anyone can act on.
    expect(widget).toContain('+ "and \\(snapshot.orders) orders, all time. "');
    expect(widget).toContain("accessibilityLabel(Text(commerceSpokenLabel(snapshot, at: now)))");
  });
});

describe("commerce widget record — reachability", () => {
  it("ships as its own widget, and both are registered in the bundle", () => {
    expect(widget).toContain("struct PostwaveCommerceWidget: Widget");
    expect(widget).toContain("struct PostwaveWidgets: WidgetBundle");
    expect(widget).toContain("PostwaveWidget()");
    expect(widget).toContain("PostwaveCommerceWidget()");
    // Exactly one entry point, on the bundle.
    expect(widget.match(/@main/g)?.length).toBe(1);
  });

  it("points every commerce surface at the screen that publishes it", () => {
    expect(widget).toContain('private let commerceWidgetURL = "moosewave://commerce"');
    expect(widget).toContain(".widgetURL(widgetDestination(commerceWidgetURL))");
    // Never force-unwrapped: a widget extension that traps is a blank tile the
    // user cannot recover from.
    expect(widget).not.toMatch(/URL\(string:[^)]*\)!/);
    expect(intents).toContain('queueRoute("/(tabs)/commerce")');
  });

  it("registers spoken phrases for both new intents", () => {
    expect(intents).toContain("intent: StoreStatusIntent()");
    expect(intents).toContain('"How is my \\(.applicationName) store doing"');
    expect(intents).toContain("intent: OpenCommerceIntent()");
  });
});
