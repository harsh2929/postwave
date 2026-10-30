// Moosewave App Intents — Siri Shortcuts.
//
// Two kinds of intent live here.
//
// NAVIGATIONAL ("Open Moosewave dashboard", "Show Moosewave approvals", "Show
// Moosewave campaigns"). Each stashes the destination route in the shared App
// Group and brings the app to the foreground (openAppWhenRun); the app reads
// the pending route on foreground (src/lib/pendingRoute.ts) and navigates.
// Going through the App Group — rather than a custom URL — keeps the routing
// table in one place (the JS route map) and works from a cold start.
//
// ANSWERING ("How is Moosewave doing?"). WorkspaceStatusIntent returns
// `IntentResult & ProvidesDialog`: Siri speaks the numbers without launching
// anything, which is a capability no desktop equivalent can have. It reads the
// SAME validated App Group snapshot the widget renders, so it needs no
// network, no token, and no new authorisation surface — and it inherits every
// privacy control that snapshot already carries:
//
//   - metrics are absent until the user explicitly opts in (Settings);
//   - enabling the app lock, signing out, or deleting the account purges the
//     container, so the intent answers "metrics are turned off";
//   - the schema + ready markers mean a torn write is never spoken;
//   - the disclosure expires, after which the values are purged and the intent
//     refuses rather than reciting yesterday's figures as if they were now; and
//   - `authenticationPolicy = .requiresAuthentication`, because a spoken
//     answer has no `.privacySensitive()` equivalent — Siri would otherwise
//     read a workspace's subscriber count aloud off a locked device.
//
// The validation below is a deliberate DUPLICATE of targets/widget/index.swift.
// The widget lives in an extension binary and this file is compiled into the
// app binary, so the code cannot be shared; src/lib/appIntentsContract.test.ts
// pins the two against each other and against the JS writer so they cannot
// drift.
//
// Injected into the main app target by plugins/withAppIntents.js at prebuild.

import AppIntents
import Foundation

private let appGroup = "group.com.moosewave.app"
private let routeKey = "pw_pending_route"

// Mirrors src/lib/widgetData.ts and targets/widget/index.swift exactly.
private let widgetOptInKey = "pw_widget_metrics_opt_in_v1"
private let widgetSchemaVersion = 1
private let freshSnapshotAge: TimeInterval = 15 * 60
private let maxSnapshotAge: TimeInterval = 12 * 60 * 60
// NATIVE#46 — see the long note beside the same constant in
// targets/widget/index.swift. Zero meant a backwards NTP correction between the
// JS write and this read looked like forgery; the worst case this buys is a
// disclosure window of `maxSnapshotAge + maxFutureClockSkew`, which is twelve
// hours and two minutes. The two readers must agree, and
// src/lib/appIntentsContract.test.ts is what makes them.
private let maxFutureClockSkew: TimeInterval = 120
private let maxWidgetInteger = 2_147_483_647

private func queueRoute(_ path: String) {
    UserDefaults(suiteName: appGroup)?.set(path, forKey: routeKey)
}

/// Whether a published figure was MEASURED (DASHBOARD#72).
///
/// The duplicate of `measuredFlag` in targets/widget/index.swift, for the same
/// reason every other check in this file is duplicated: this compiles into the
/// app binary and that compiles into an extension. An ABSENT marker means the
/// snapshot predates the contract, so it falls back to what that build meant by
/// the value it wrote.
private func measuredFlag(
    _ defaults: UserDefaults,
    _ key: String,
    legacyMeaning: @autoclosure () -> Bool
) -> Bool {
    guard defaults.object(forKey: key) != nil else { return legacyMeaning() }
    return defaults.integer(forKey: key) == 1
}

/// The figures a populated snapshot carries, each with whether it was actually
/// MEASURED (DASHBOARD#72).
///
/// A struct rather than a six-part associated value because the flags doubled
/// its width, and because "which of these is real" is the question every reader
/// below has to ask. `pending` needs no flag: neither JS writer publishes a
/// pending count it did not measure, so a published one is measured.
private struct WorkspaceFigures {
    let subs: Int
    let subsKnown: Bool
    let openRate: Int
    let openRateKnown: Bool
    let sent30d: Int
    let sent30dKnown: Bool
    let pending: Int
    let workspace: String
    let ageSeconds: TimeInterval
}

/// What the App Group snapshot can say. Three outcomes, never conflated: the
/// user has not opted in, the disclosure has lapsed, or there are numbers.
private enum StatusSnapshot {
    case disabled
    case expired
    case ready(WorkspaceFigures)

    static func load(at now: Date = Date()) -> StatusSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .disabled
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            return .disabled
        }
        // A stale or partial transaction is never spoken.
        guard defaults.integer(forKey: "pw_widget_schema") == widgetSchemaVersion,
              defaults.integer(forKey: "pw_widget_ready") == 1,
              defaults.object(forKey: "pw_widget_subs") != nil,
              defaults.object(forKey: "pw_widget_open_rate") != nil,
              defaults.object(forKey: "pw_widget_sent30d") != nil,
              defaults.object(forKey: "pw_widget_pending") != nil,
              defaults.object(forKey: "pw_widget_workspace") != nil,
              defaults.object(forKey: "pw_widget_updated_at") != nil,
              defaults.object(forKey: "pw_widget_expires_at") != nil else {
            return .expired
        }

        let updatedAt = defaults.double(forKey: "pw_widget_updated_at")
        let expiresAt = defaults.double(forKey: "pw_widget_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - updatedAt
        let declaredLifetime = expiresAt - updatedAt
        guard updatedAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            return .expired
        }

        let subs = defaults.integer(forKey: "pw_widget_subs")
        let openRate = defaults.integer(forKey: "pw_widget_open_rate")
        let sent30d = defaults.integer(forKey: "pw_widget_sent30d")
        let pending = defaults.integer(forKey: "pw_widget_pending")
        let workspace = (defaults.string(forKey: "pw_widget_workspace") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard (0...maxWidgetInteger).contains(subs),
              (0...100).contains(openRate),
              (0...maxWidgetInteger).contains(sent30d),
              (0...maxWidgetInteger).contains(pending),
              !workspace.isEmpty else {
            return .expired
        }
        return .ready(WorkspaceFigures(
            subs: subs,
            // The legacy readings preserved exactly: before the markers
            // existed, a count of 0 was spoken as "0" and an open rate of 0 was
            // the only way an unmeasured rate could be represented.
            subsKnown: measuredFlag(
                defaults, "pw_widget_subs_known", legacyMeaning: true
            ),
            openRate: openRate,
            openRateKnown: measuredFlag(
                defaults, "pw_widget_open_rate_known", legacyMeaning: openRate > 0
            ),
            sent30d: sent30d,
            sent30dKnown: measuredFlag(
                defaults, "pw_widget_sent30d_known", legacyMeaning: true
            ),
            pending: pending,
            workspace: workspace,
            ageSeconds: age
        ))
    }
}

/// How old the measurement is, in words, or nil while it is still fresh. Same
/// rule the widget applies: a number spoken without its age is the lie this
/// avoids, and a spoken answer has no room for a timestamp label.
private func spokenAge(_ ageSeconds: TimeInterval) -> String? {
    guard ageSeconds >= freshSnapshotAge else { return nil }
    let minutes = Int(ageSeconds / 60)
    if minutes < 60 { return "\(minutes) minutes ago" }
    return "\(Int(ageSeconds / 3600)) hours ago"
}

/// "a", "a and b", "a, b, and c" — the clauses of the status sentence, joined
/// the way somebody would say them. Needed because how many clauses there are
/// stopped being fixed once an unmeasured figure could drop out (DASHBOARD#72).
private func spokenList(_ parts: [String]) -> String {
    switch parts.count {
    case 0: return ""
    case 1: return parts[0]
    case 2: return "\(parts[0]) and \(parts[1])"
    default:
        return parts.dropLast().joined(separator: ", ") + ", and \(parts[parts.count - 1])"
    }
}

/// The sentence Siri says. Built here rather than inline so it is one readable
/// unit and so the approvals clause can be omitted entirely when there is
/// nothing waiting — "and 0 approvals waiting" is noise on most days.
///
/// DASHBOARD#72: an unmeasured figure is DROPPED from the list rather than
/// spoken as a zero. Speech has no em-dash, and "a 0 percent open rate" said
/// out loud about a workspace whose stats payload simply omitted the field is
/// the most convincing form this lie can take.
private func statusSentence(_ snapshot: StatusSnapshot) -> String {
    switch snapshot {
    case .disabled:
        return "Moosewave metrics are turned off. You can turn on widget and Siri metrics in Moosewave's settings."
    case .expired:
        return "Moosewave doesn't have recent numbers on this device. Open Moosewave to refresh them."
    case let .ready(figures):
        var clauses: [String] = []
        if figures.subsKnown { clauses.append("\(figures.subs) subscribers") }
        if figures.openRateKnown {
            clauses.append("a \(figures.openRate) percent open rate")
        }
        if figures.sent30dKnown {
            clauses.append(
                figures.sent30d == 1
                    ? "1 campaign sent in the last 30 days"
                    : "\(figures.sent30d) campaigns sent in the last 30 days"
            )
        }
        var sentence = clauses.isEmpty
            // Every figure absent is a real state — a stats payload that
            // returned none of the three — and it is not the same as "expired".
            ? "Moosewave hasn't measured \(figures.workspace)'s subscriber, open rate or send figures on this device."
            : "\(figures.workspace) has \(spokenList(clauses))."
        if figures.pending > 0 {
            sentence += figures.pending == 1
                ? " 1 approval is waiting."
                : " \(figures.pending) approvals are waiting."
        }
        if let age = spokenAge(figures.ageSeconds) {
            sentence += " Measured \(age)."
        }
        return sentence
    }
}

@available(iOS 16.0, *)
struct OpenDashboardIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Moosewave dashboard"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/dashboard")
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenApprovalsIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave approvals"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/approvals")
        return .result()
    }
}

@available(iOS 16.0, *)
struct ShowCampaignsIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave campaigns"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/campaigns")
        return .result()
    }
}

/// Opens the Stores tab — which is also the screen that publishes the commerce
/// record `StoreStatusIntent` reads, so this is the follow-up action for every
/// answer that turns out to be "nothing measured yet".
@available(iOS 16.0, *)
struct OpenCommerceIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave stores"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/commerce")
        return .result()
    }
}

/// Opens Deliverability. Lives HERE, with the other launch intents, because
/// `appIntentsContract.test.ts` asserts that everything below WorkspaceStatusIntent
/// is answer-only — no queueRoute on the speaking path.
struct OpenDeliverabilityIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave deliverability"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/deliverability")
        return .result()
    }
}

/// The three destinations `validatePendingRoute` allow-listed with no producer.
///
/// `ALLOWED_ROUTES` in src/lib/pendingRoute.ts is a CONTRACT with this file,
/// and it carried `/(tabs)/subscribers`, `/(tabs)/search` and
/// `/(tabs)/notifications` while nothing in any Swift file ever wrote them —
/// the same shape as the two intents that shipped dead ("Show Moosewave stores",
/// "Show Moosewave deliverability"), only inverted: there the Swift existed and
/// the allow-list did not. `pw_pending_route` has exactly two writers, both
/// Swift (this file and targets/widget/ScanControl.swift), so an allow-listed
/// route no intent queues is simply unreachable.
///
/// Only ONE of the three gets a spoken phrase below: `AppShortcutsProvider`
/// registers a maximum of ten App Shortcuts per app and nine are already
/// claimed. The other two are still real intents — reachable from the
/// Shortcuts app, Spotlight, the Action button and Back Tap — which is what
/// closes the contract; the Siri phrase is the part the ceiling rations.
@available(iOS 16.0, *)
struct OpenSubscribersIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave subscribers"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/subscribers")
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenSearchIntent: AppIntent {
    static var title: LocalizedStringResource = "Search Moosewave"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/search")
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenNotificationsIntent: AppIntent {
    static var title: LocalizedStringResource = "Show Moosewave notifications"
    static var openAppWhenRun = true
    func perform() async throws -> some IntentResult {
        queueRoute("/(tabs)/notifications")
        return .result()
    }
}

/// Answers a question instead of opening a screen.
///
/// `openAppWhenRun = false` is the whole point: the value of this intent is
/// getting the number WITHOUT stopping to look at a phone. Everything it can
/// say comes from the already-validated App Group snapshot, so it performs no
/// network request and holds no credential.
@available(iOS 16.0, *)
struct WorkspaceStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Moosewave workspace status"
    static var description = IntentDescription(
        "Reads the workspace numbers Moosewave last saved to this device. Requires the widget and Siri metrics setting to be turned on."
    )
    static var openAppWhenRun = false
    // A spoken answer has no `.privacySensitive()` equivalent — without this,
    // Siri would recite a workspace's subscriber count off a locked device.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = statusSentence(StatusSnapshot.load())
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

// MARK: - Store status (COMMERCE#70)
//
// The SECOND record in the same App Group container — one store's lifetime
// totals, written by the Stores tab and re-read in the background for that same
// store (src/lib/widgetCommerceSnapshot.ts). It inherits the identical consent,
// transaction and expiry machinery as the workspace snapshot above, and it is
// validated here a second time because this file compiles into the app binary
// while targets/widget/index.swift compiles into an extension.
//
// Three things this answer must not do, and each of them is a sentence:
//   - speak a total without saying when it was measured. Nothing polls a store
//     in the background of the app, so an undated figure implies a live feed;
//   - conflate "you have never opened Stores" with "the numbers lapsed"; or
//   - call it "revenue" as though it were a period. `Repo.Analytics` sums every
//     ingested order with no date predicate (repo.go:2576-2584), so the word is
//     "all time".

private let commerceSchemaVersion = 1

private enum StoreSnapshot {
    case disabled
    case neverMeasured
    case expired
    case ready(store: String, orders: Int, revenueMajor: Int, currency: String,
               ageSeconds: TimeInterval)

    static func load(at now: Date = Date()) -> StoreSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .disabled
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            return .disabled
        }
        guard defaults.integer(forKey: "pw_widget_commerce_ready") == 1,
              defaults.integer(forKey: "pw_widget_commerce_schema") == commerceSchemaVersion,
              defaults.object(forKey: "pw_widget_commerce_store") != nil,
              defaults.object(forKey: "pw_widget_commerce_orders") != nil,
              defaults.object(forKey: "pw_widget_commerce_revenue") != nil,
              defaults.object(forKey: "pw_widget_commerce_currency") != nil,
              defaults.object(forKey: "pw_widget_commerce_measured_at") != nil,
              defaults.object(forKey: "pw_widget_commerce_expires_at") != nil else {
            return .neverMeasured
        }

        let measuredAt = defaults.double(forKey: "pw_widget_commerce_measured_at")
        let expiresAt = defaults.double(forKey: "pw_widget_commerce_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - measuredAt
        let declaredLifetime = expiresAt - measuredAt
        guard measuredAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            return .expired
        }

        let store = (defaults.string(forKey: "pw_widget_commerce_store") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let currency = (defaults.string(forKey: "pw_widget_commerce_currency") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let orders = defaults.integer(forKey: "pw_widget_commerce_orders")
        let revenue = defaults.integer(forKey: "pw_widget_commerce_revenue")
        guard !store.isEmpty,
              currency.count == 3,
              (0...maxWidgetInteger).contains(orders),
              (0...maxWidgetInteger).contains(revenue) else {
            return .expired
        }
        return .ready(store: store, orders: orders, revenueMajor: revenue,
                      currency: currency, ageSeconds: age)
    }
}

/// The store's own currency. Siri reads "€45,123" as euros; the raw integer
/// with a code appended is the fallback when the code cannot be resolved,
/// because a wrong currency symbol is a wrong number.
private func spokenMoney(_ amount: Int, _ code: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = code
    formatter.maximumFractionDigits = 0
    formatter.minimumFractionDigits = 0
    return formatter.string(from: NSNumber(value: amount)) ?? "\(amount) \(code)"
}

/// Always present for a populated answer, unlike `spokenAge` above: these
/// numbers are never live, so the sentence always carries their age.
private func spokenMeasurementAge(_ ageSeconds: TimeInterval) -> String {
    if ageSeconds < 60 { return "just now" }
    let minutes = Int(ageSeconds / 60)
    if minutes < 60 { return "\(minutes) minutes ago" }
    let hours = Int(ageSeconds / 3600)
    return hours == 1 ? "1 hour ago" : "\(hours) hours ago"
}

private func storeSentence(_ snapshot: StoreSnapshot) -> String {
    switch snapshot {
    case .disabled:
        return "Moosewave metrics are turned off. You can turn on widget and Siri metrics in Moosewave's settings."
    case .neverMeasured:
        return "Moosewave hasn't saved any store numbers on this device yet. Open Stores in Moosewave once and they'll be here."
    case .expired:
        return "Moosewave's store numbers on this device have expired. Open Stores in Moosewave to refresh them."
    case let .ready(store, orders, revenueMajor, currency, ageSeconds):
        let money = spokenMoney(revenueMajor, currency)
        let orderWord = orders == 1 ? "order" : "orders"
        return "\(store) has taken \(money) across \(orders) \(orderWord), all time. "
            + "Measured \(spokenMeasurementAge(ageSeconds))."
    }
}

/// The commerce counterpart to `WorkspaceStatusIntent`, and it earns its place
/// for the same reason: the value is getting the number without stopping to
/// look at a phone. Same privacy posture, for the same reasons — no network, no
/// credential, and no speaking off a locked device.
@available(iOS 16.0, *)
struct StoreStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Moosewave store status"
    static var description = IntentDescription(
        "Reads the store totals Moosewave last saved to this device, and says when they were measured. Requires the widget and Siri metrics setting to be turned on."
    )
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = storeSentence(StoreSnapshot.load())
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

// MARK: - Deliverability (NATIVE#5)
//
// Deliverability had a widget family and a validated App Group record and no
// intent, unlike the metrics and commerce snapshots either side of it — so the one
// number an operator most wants without unlocking a phone ("are we still landing?")
// was the one Siri could not answer.
//
// Identical privacy posture to its siblings, for identical reasons: no network, no
// credential, nothing but the already-validated snapshot, and
// `.requiresAuthentication` so a grade is never recited off a locked device.

private let deliverabilitySchemaVersion = 1

private enum DeliverabilitySnapshot {
    case disabled
    case neverMeasured
    case expired
    case ready(grade: String, score: Int, status: String, throttled: Bool,
               ageSeconds: TimeInterval)

    static func load(at now: Date = Date()) -> DeliverabilitySnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .disabled
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            return .disabled
        }
        guard defaults.integer(forKey: "pw_widget_deliv_ready") == 1,
              defaults.integer(forKey: "pw_widget_deliv_schema") == deliverabilitySchemaVersion,
              defaults.object(forKey: "pw_widget_deliv_grade") != nil,
              defaults.object(forKey: "pw_widget_deliv_score") != nil,
              defaults.object(forKey: "pw_widget_deliv_status") != nil,
              defaults.object(forKey: "pw_widget_deliv_measured_at") != nil,
              defaults.object(forKey: "pw_widget_deliv_expires_at") != nil else {
            return .neverMeasured
        }

        let measuredAt = defaults.double(forKey: "pw_widget_deliv_measured_at")
        let expiresAt = defaults.double(forKey: "pw_widget_deliv_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - measuredAt
        let declaredLifetime = expiresAt - measuredAt
        guard measuredAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            return .expired
        }

        let grade = (defaults.string(forKey: "pw_widget_deliv_grade") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let status = (defaults.string(forKey: "pw_widget_deliv_status") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let score = defaults.integer(forKey: "pw_widget_deliv_score")
        // The grade vocabulary is fixed at A-F by the writer
        // (lib/widgetDeliverabilitySnapshot.ts DELIVERABILITY_GRADES). Anything
        // else means the container was written by a version this build does not
        // understand, which is an expiry rather than something to recite.
        guard ["A", "B", "C", "D", "F"].contains(grade),
              (0...100).contains(score) else {
            return .expired
        }
        return .ready(
            grade: grade,
            score: score,
            status: status,
            throttled: defaults.integer(forKey: "pw_widget_deliv_throttled") == 1,
            ageSeconds: age
        )
    }
}

private func deliverabilitySentence(_ snapshot: DeliverabilitySnapshot) -> String {
    switch snapshot {
    case .disabled:
        return "Moosewave metrics are turned off. You can turn on widget and Siri metrics in Moosewave's settings."
    case .neverMeasured:
        return "Moosewave hasn't saved a deliverability measurement on this device yet. Open Deliverability in Moosewave once and it'll be here."
    case .expired:
        return "Moosewave's deliverability measurement on this device has expired. Open Deliverability in Moosewave to refresh it."
    case let .ready(grade, score, status, throttled, ageSeconds):
        // Throttling is said FIRST when it applies: a healthy grade while sending
        // is being held back is the combination most likely to be misread as
        // "nothing to do here".
        let throttleClause = throttled
            ? "Sending is being throttled. "
            : ""
        let statusClause = status.isEmpty ? "" : " Status: \(status)."
        return "\(throttleClause)Deliverability is grade \(grade), scoring \(score) out of 100.\(statusClause) "
            + "Measured \(spokenMeasurementAge(ageSeconds))."
    }
}

/// Answers "are we still landing?" without opening the app.
@available(iOS 16.0, *)
struct DeliverabilityStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Moosewave deliverability status"
    static var description = IntentDescription(
        "Reads the deliverability grade Moosewave last saved to this device, and says when it was measured. Requires the widget and Siri metrics setting to be turned on."
    )
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let sentence = deliverabilitySentence(DeliverabilitySnapshot.load())
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

// MARK: - One metric, as a VALUE (NATIVE#6)
//
// `WorkspaceStatusIntent` and `StoreStatusIntent` above answer with a DIALOG:
// Siri says a sentence and the result ends there. That is the right shape for
// "how is Moosewave doing", and it is where this surface stopped.
//
// What it could not do is hand a NUMBER to the rest of Shortcuts. An intent
// that returns `ReturnsValue<Int>` can be piped into an If, a notification, a
// Home Automation, or a variable in somebody's morning routine — which is the
// difference between an app that talks to Siri and an app that is a building
// block on the device. It costs no new data: every value comes from the SAME
// validated App Group snapshot the dialog intents read, under the same opt-in
// marker, the same twelve-hour disclosure window and the same authentication
// policy. Nothing new leaves the app's gate.
//
// ABSENCE IS NOT ZERO, and in a typed return that rule has teeth. `Int` has no
// way to say "the user never turned metrics on" or "these numbers lapsed", and
// answering 0 would put a fabricated figure into whatever automation the value
// feeds. Both states THROW instead, carrying the reason as the error the
// Shortcuts editor shows, so a broken automation says why it is broken.

@available(iOS 16.0, *)
enum PostwaveMetric: String, AppEnum {
    case subscribers
    case openRate
    case campaignsSent
    case pendingApprovals

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Moosewave metric"

    static var caseDisplayRepresentations: [PostwaveMetric: DisplayRepresentation] = [
        .subscribers: "Subscribers",
        .openRate: "Open rate",
        .campaignsSent: "Campaigns sent in the last 30 days",
        .pendingApprovals: "Approvals waiting",
    ]
}

/// Why a metric could not be produced. Conforms to
/// `CustomLocalizedStringResourceConvertible` so the Shortcuts editor shows
/// the reason rather than a generic failure — and so the two reasons stay
/// distinguishable, exactly as they are in the spoken sentences above.
@available(iOS 16.0, *)
struct PostwaveMetricUnavailable: Error, CustomLocalizedStringResourceConvertible {
    let localizedStringResource: LocalizedStringResource

    static let disabled = PostwaveMetricUnavailable(
        localizedStringResource: "Moosewave metrics are turned off. Turn on widget and Siri metrics in Moosewave's settings."
    )
    static let expired = PostwaveMetricUnavailable(
        localizedStringResource: "Moosewave doesn't have recent numbers on this device. Open Moosewave to refresh them."
    )
    /// DASHBOARD#72. The snapshot is present and current, but THIS figure was
    /// not in it — the stats payload omitted the field. A typed `Int` return has
    /// no room for that, and the 0 it would otherwise hand back flows into
    /// whatever automation consumes it as though somebody had measured it.
    static let notMeasured = PostwaveMetricUnavailable(
        localizedStringResource: "Moosewave hasn't measured that number on this device yet. Open Moosewave to refresh it."
    )
}

/// The spoken form of one metric. Built from the same parts as
/// `statusSentence` so a value and the sentence can never disagree about what
/// a number means or how old it is.
@available(iOS 16.0, *)
private func metricSentence(
    _ metric: PostwaveMetric, value: Int, workspace: String, ageSeconds: TimeInterval
) -> String {
    var sentence: String
    switch metric {
    case .subscribers:
        sentence = "\(workspace) has \(value) subscribers."
    case .openRate:
        sentence = "\(workspace) has a \(value) percent open rate."
    case .campaignsSent:
        sentence = value == 1
            ? "\(workspace) sent 1 campaign in the last 30 days."
            : "\(workspace) sent \(value) campaigns in the last 30 days."
    case .pendingApprovals:
        // The one metric whose zero is genuinely worth saying out loud: "no
        // approvals are waiting" is the answer somebody asked for.
        sentence = value == 0
            ? "No \(workspace) approvals are waiting."
            : (value == 1
                ? "1 \(workspace) approval is waiting."
                : "\(value) \(workspace) approvals are waiting.")
    }
    if let age = spokenAge(ageSeconds) {
        sentence += " Measured \(age)."
    }
    return sentence
}

@available(iOS 16.0, *)
struct WorkspaceMetricIntent: AppIntent {
    static var title: LocalizedStringResource = "Get a Moosewave number"
    static var description = IntentDescription(
        "Returns one number from the workspace figures Moosewave last saved to this device, so it can be used in a shortcut. Requires the widget and Siri metrics setting to be turned on."
    )
    static var openAppWhenRun = false
    // Same reason as the dialog intents: a returned value is read aloud and
    // handed to other actions, neither of which has a redaction story.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Metric")
    var metric: PostwaveMetric

    static var parameterSummary: some ParameterSummary {
        Summary("Get Moosewave \(\.$metric)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        try await postwaveMetricResult(metric)
    }
}

/// The one implementation behind every value-returning metric intent.
///
/// Extracted so `PendingApprovalsIntent` below can be a real intent TYPE
/// rather than a pre-bound instance of the parameterised one, without a second
/// copy of the absence rules. Everything that made the typed return safe — the
/// single validated snapshot, the two unavailable states, the three
/// "not measured" guards — lives here exactly once, so a correction to any of
/// them cannot reach one intent and miss the other.
@available(iOS 16.0, *)
private func postwaveMetricResult(
    _ metric: PostwaveMetric
) async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
    switch StatusSnapshot.load() {
    case .disabled:
        throw PostwaveMetricUnavailable.disabled
    case .expired:
        throw PostwaveMetricUnavailable.expired
    case let .ready(figures):
        let value: Int
        switch metric {
        case .subscribers:
            guard figures.subsKnown else {
                throw PostwaveMetricUnavailable.notMeasured
            }
            value = figures.subs
        case .openRate:
            guard figures.openRateKnown else {
                throw PostwaveMetricUnavailable.notMeasured
            }
            value = figures.openRate
        case .campaignsSent:
            guard figures.sent30dKnown else {
                throw PostwaveMetricUnavailable.notMeasured
            }
            value = figures.sent30d
        // Always measured — see the note on `WorkspaceFigures`.
        case .pendingApprovals: value = figures.pending
        }
        let sentence = metricSentence(
            metric,
            value: value,
            workspace: figures.workspace,
            ageSeconds: figures.ageSeconds
        )
        return .result(value: value, dialog: IntentDialog(stringLiteral: sentence))
    }
}

/// The pending-approvals question as its own intent type, so it has its own
/// spoken phrase.
///
/// WHY IT IS PRE-BOUND AT ALL. Siri cannot prompt for an enum parameter inside
/// a voice shortcut without a round trip, and "how many approvals are pending"
/// is the question this surface exists to answer, so it gets a shortcut of its
/// own with the metric already chosen.
///
/// WHY IT IS A TYPE AND NOT A FACTORY (F02). This used to be a file-private
/// factory function returning a `WorkspaceMetricIntent` with `.metric` pre-set,
/// handed straight to `AppShortcut(intent:)`. That reads fine and would run
/// fine; it does not BUILD. Apple's `appintentsmetadataprocessor` parses
/// `AppShortcut(intent:)` STATICALLY and requires a literal initializer
/// expression in that position. Given a function call it stops the entire build
/// with "Expected an initialization of an 'AppIntent' class, but got
/// unrecognized syntax instead" — a halting error, not a warning. So every
/// entry in `PostwaveShortcuts` must read `SomeIntent()`, and any pre-binding
/// has to happen inside the type. Nothing about the pre-binding is optional;
/// only where it lives.
@available(iOS 16.0, *)
struct PendingApprovalsIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Moosewave approvals waiting"
    static var description = IntentDescription(
        "Returns how many Moosewave approvals are waiting, from the workspace figures Moosewave last saved to this device, so the number can be used in a shortcut. Requires the widget and Siri metrics setting to be turned on."
    )
    static var openAppWhenRun = false
    // Identical posture to `WorkspaceMetricIntent`: this returns and speaks the
    // same number, and neither speech nor a Shortcuts variable has a redaction
    // story for a locked device.
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
        try await postwaveMetricResult(.pendingApprovals)
    }
}

@available(iOS 16.0, *)
struct PostwaveShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: WorkspaceStatusIntent(),
            phrases: [
                "How is \(.applicationName) doing",
                "What's my \(.applicationName) status",
                "\(.applicationName) numbers",
            ],
            shortTitle: "Workspace status",
            // Deliberately an SF Symbol from the iOS 13 set: an unavailable
            // symbol name renders as a blank tile in the Shortcuts app, and
            // this target's floor is iOS 16.
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: PendingApprovalsIntent(),
            phrases: [
                "How many \(.applicationName) approvals are pending",
                "\(.applicationName) approvals waiting",
            ],
            shortTitle: "Approvals waiting",
            // iOS 13 SF Symbol, like the others: an unavailable symbol name
            // renders as a blank tile in the Shortcuts app.
            systemImageName: "tray.full.fill"
        )
        AppShortcut(
            intent: OpenDashboardIntent(),
            phrases: [
                "Open \(.applicationName) dashboard",
                "Show my \(.applicationName) dashboard",
            ],
            shortTitle: "Dashboard",
            systemImageName: "chart.bar.fill"
        )
        AppShortcut(
            intent: OpenApprovalsIntent(),
            phrases: [
                "Show \(.applicationName) approvals",
                "Check \(.applicationName) approvals",
            ],
            shortTitle: "Approvals",
            systemImageName: "checkmark.seal.fill"
        )
        AppShortcut(
            intent: ShowCampaignsIntent(),
            phrases: [
                "Show \(.applicationName) campaigns",
                "Open \(.applicationName) campaigns",
            ],
            shortTitle: "Campaigns",
            systemImageName: "paperplane.fill"
        )
        AppShortcut(
            intent: DeliverabilityStatusIntent(),
            phrases: [
                "Is \(.applicationName) still landing",
                "\(.applicationName) deliverability",
                "\(.applicationName) deliverability status",
            ],
            shortTitle: "Deliverability",
            systemImageName: "checkmark.seal.fill"
        )
        AppShortcut(
            intent: OpenDeliverabilityIntent(),
            phrases: [
                "Open \(.applicationName) deliverability",
                "Show \(.applicationName) deliverability",
            ],
            shortTitle: "Open deliverability",
            // iOS 13 SF Symbols only, per the note on the commerce shortcut: an
            // unavailable symbol renders as a blank tile in the Shortcuts app.
            systemImageName: "envelope.fill"
        )
        AppShortcut(
            intent: StoreStatusIntent(),
            phrases: [
                "How is my \(.applicationName) store doing",
                "\(.applicationName) store status",
                "\(.applicationName) store numbers",
            ],
            shortTitle: "Store status",
            // iOS 13 SF Symbol, like the others: an unavailable symbol name
            // renders as a blank tile in the Shortcuts app.
            systemImageName: "cart.fill"
        )
        AppShortcut(
            intent: OpenCommerceIntent(),
            phrases: [
                "Show \(.applicationName) stores",
                "Open \(.applicationName) stores",
            ],
            shortTitle: "Stores",
            systemImageName: "bag.fill"
        )
        // THE TENTH AND LAST. AppShortcutsProvider registers at most ten per
        // app; past that iOS drops the overflow silently, which is the same
        // "the shortcut did nothing" failure this file's contract exists to
        // prevent. So `OpenSubscribersIntent` and `OpenSearchIntent` ship as
        // intents WITHOUT a spoken phrase (Shortcuts app, Spotlight, Action
        // button, Back Tap), and the one destination that is genuinely a
        // "check this from across the room" question takes the slot.
        AppShortcut(
            intent: OpenNotificationsIntent(),
            phrases: [
                "Show \(.applicationName) notifications",
                "Open \(.applicationName) notifications",
            ],
            shortTitle: "Notifications",
            // iOS 13 SF Symbol, like every other tile here.
            systemImageName: "bell.fill"
        )
    }
}
