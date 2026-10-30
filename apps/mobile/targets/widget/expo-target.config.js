/**
 * Moosewave home-screen widget target.
 *
 * Consumed by @bacons/apple-targets at `expo prebuild --clean`, which
 * generates a WidgetKit extension Xcode target from the Swift in this
 * directory.
 *
 * After explicit user opt-in, the widget reads a short-lived workspace
 * snapshot from the shared App Group container (group.com.moosewave.app); the
 * app writes it via ExtensionStorage (see src/lib/widgetData.ts). The App
 * Group entitlement is mirrored from the main app so both sides address the
 * same suite.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = (config) => ({
  type: "widget",
  name: "PostwaveWidget",
  // iOS 17.0 — and this number is load-bearing, so it has a reason (DASHBOARD#47).
  //
  // The metrics widget is an `AppIntentConfiguration`, which is what makes
  // long-press → Edit Widget → "which number do I want on my home screen"
  // possible at all. That API is iOS 17+, and `WidgetBundleBuilder` accepts NO
  // control flow — `if #available(iOS 17.0, *)` inside a widget bundle is a
  // compile error ("closure containing control flow statement cannot be used
  // with result builder 'WidgetBundleBuilder'"), and a `Widget.body` returning
  // two different configuration types has no eraser to return through. So a
  // bundle cannot carry an iOS-16 static widget and an iOS-17 configurable one
  // side by side: the floor is a binary choice.
  //
  // Raising it costs only the WIDGET on iOS 16 devices. This EXTENSION declares
  // 17.0 and the app target sits lower, so those devices still install and run
  // Moosewave in full — the widget simply does not appear in their gallery.
  // iOS 17 shipped in September 2023.
  //
  // (The app target's own floor used to be React Native's 15.1. It is now 16.0,
  // raised by plugins/withAppIntents.js because the App Intents it compiles
  // into the app binary are iOS 16 only — see F02 there. That number and this
  // one are independent: 17.0 here is about AppIntentConfiguration widgets, and
  // lowering it to match the app would break this target's own intent.)
  deploymentTarget: "17.0",
  // AppIntents carries the widget-configuration intent. Swift auto-links what
  // it imports; naming it here keeps the target's declared dependencies honest.
  frameworks: ["WidgetKit", "SwiftUI", "AppIntents"],
  entitlements: {
    // Same App Group as the main app so UserDefaults(suiteName:) resolves
    // to the shared container the JS side writes into.
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
  },
});
