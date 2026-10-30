// Moosewave "Scan a code" control — Control Center, Lock Screen, and the
// Action Button (NATIVE#59).
//
// WHY THIS EXISTS AND WHY IT IS NOT A WIDGET
//
// The scanner is the one screen in this app that is used while STANDING IN
// FRONT OF SOMETHING — a printed sign-up QR on a poster at an event, a code
// taped to a shelf, a CLI device-approval code on somebody else's monitor. In
// that posture the slow part is not the scan, it is getting to the scanner:
// wake → unlock → find Moosewave → wait for hydration → the biometric gate →
// More → Scan. A home-screen widget does not help, because it still costs a
// swipe to the right home page and a tap. iOS 18 exposes exactly this shape as
// a `ControlWidget`, which the user can put in Control Center, on the Lock
// Screen, OR bind to the Action Button on iPhone 15 Pro and later. One
// declaration, all three placements — which is why this single file closes
// both halves of the finding ("Control Center control OR Action Button
// target").
//
// WHY IT LIVES HERE AND NOT IN plugins/PostwaveAppIntents.swift
//
// A `ControlWidget` must be vended by a `WidgetBundle`, which only exists in a
// widget extension; `plugins/PostwaveAppIntents.swift` compiles into the MAIN
// app binary (App Intents + AppShortcutsProvider have to, to register their
// spoken phrases). So the control belongs to this target. `targets/widget` is
// a `PBXFileSystemSynchronizedRootGroup` (see @bacons/apple-targets'
// with-xcode-changes.js), so every .swift file in this directory is a member
// of the extension automatically — this needed no project edit, only the entry
// in the bundle at the bottom of index.swift.
//
// THE PRIVACY CONTRACT AT THE TOP OF index.swift DOES NOT APPLY HERE, AND THAT
// IS THE POINT
//
// Every other thing in this extension READS the shared workspace snapshot, so
// each one is gated on the explicit metrics opt-in, a schema + ready marker, a
// twelve-hour disclosure window, and `.privacySensitive()` redaction. This
// control publishes and reads NOTHING about the workspace: it is a button
// labelled "Scan a code". There is no number to leak from a locked device, no
// consent to check, and nothing to expire — so gating it on the metrics opt-in
// would only mean the scanner is unreachable for users who declined to put
// figures on their home screen, which is a different decision entirely.
//
// It is also why there is no `authenticationPolicy = .requiresAuthentication`
// here, unlike the SPEAKING intents next door. Those hand a subscriber count
// to a locked device out loud; this one opens an app, and iOS already requires
// the device to be unlocked before a control may foreground an app. Adding the
// policy would buy nothing and cost a second unlock in front of the poster.
//
// HOW IT ROUTES
//
// Through the same `pw_pending_route` App Group key the navigational App
// Intents use, for the same reason: the destination table stays in ONE place
// (the JS route map), the value survives a cold start, and it is validated
// against a fixed allow-list on the way out
// (`validatePendingRoute` in src/lib/pendingRoute.ts, where "/(tabs)/scan" is
// already an accepted route). `useSharedInboxRouting` reads and clears it on
// every foreground once the session is confirmed. Nothing new was added to the
// bridge to make this work — src/lib/scanControlContract.test.ts pins the key,
// the suite name and the route string across all three files so they cannot
// drift.
//
// A CONSEQUENCE WORTH STATING: if the control is used while signed OUT, the
// route stays queued in the container until sign-in completes and then lands
// on the scanner. That is the existing behaviour of every App Intent
// destination and it is the right one here — somebody who pressed "Scan a
// code" wants the scanner, not the dashboard, once they are through the gate.

import AppIntents
import SwiftUI
import WidgetKit

private let appGroup = "group.com.moosewave.app"
private let routeKey = "pw_pending_route"
private let scanRoute = "/(tabs)/scan"

/// Queue the scanner and foreground the app.
///
/// `openAppWhenRun = true` is the whole mechanism: the intent performs inside
/// the widget extension (writing the App Group value), and iOS then brings the
/// app forward, where the pending route is read on the `active` transition.
@available(iOS 18.0, *)
struct OpenScannerControlIntent: AppIntent {
    static var title: LocalizedStringResource = "Scan a code"
    static var description = IntentDescription(
        "Opens Moosewave's scanner for a sign-up QR code or a device-approval code."
    )
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        UserDefaults(suiteName: appGroup)?.set(scanRoute, forKey: routeKey)
        return .result()
    }
}

/// A BUTTON, not a toggle: scanning is a one-shot act with no on/off state to
/// reflect, and a control that renders a state it cannot actually observe is
/// the same lie as a number without its timestamp.
///
/// Copy is deliberately identical to the home-screen long-press shortcut in
/// src/lib/quickActionPolicy.ts ("Scan a code" / "Sign-up QR or device
/// approval"), because they are the same destination reached two ways and a
/// user should not have to work out that they are.
@available(iOS 18.0, *)
struct PostwaveScanControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "PostwaveScanControl") {
            ControlWidgetButton(action: OpenScannerControlIntent()) {
                // `qrcode.viewfinder` has existed since iOS 13, so it can never
                // render as the blank tile an unavailable SF Symbol produces.
                Label("Scan a code", systemImage: "qrcode.viewfinder")
            }
        }
        .displayName("Scan a code")
        .description("Sign-up QR or device approval — opens Moosewave's scanner.")
    }
}
