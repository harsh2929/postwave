// Moosewave home-screen widget (WidgetKit).
//
// Privacy contract:
//   - workspace metrics are disabled until the user explicitly opts in;
//   - app lock, logout, and credential replacement remove that opt-in;
//   - native rendering requires schema + ready transaction markers;
//   - a snapshot reads as CURRENT for fifteen minutes and states its own age
//     after that, and the disclosure itself expires after twelve hours, at
//     which point the values are purged and refuse to render; and
//   - metric views are privacy-sensitive so iOS may redact them in protected
//     previews (including locked-device/StandBy contexts).
//
// Data contract (App Group: group.com.moosewave.app):
//   pw_widget_metrics_opt_in_v1  Int     — exact 1 only after user consent
//   pw_widget_schema             Int     — exact schema version
//   pw_widget_ready              Int     — exact 1 only after atomic JS write
//   pw_widget_subs               Int     — total subscribers
//   pw_widget_open_rate          Int     — 0...100 whole-percent open rate
//   pw_widget_sent30d            Int     — campaigns sent in last 30 days
//   pw_widget_pending            Int     — approvals awaiting decision
//   pw_widget_workspace          String  — bounded workspace display name
//   pw_widget_updated_at         Int     — unix seconds written
//   pw_widget_expires_at         Int     — unix seconds disclosure expires
//
// Absence markers (DASHBOARD#72) — OPTIONAL, exact 1 means the paired figure is
// a MEASUREMENT and not a placeholder. An absent marker means the snapshot was
// written by a build older than this contract; see `measuredFlag`. `pending`
// has none because both JS writers refuse to publish a pending count they did
// not measure, so a published one is measured by construction.
//   pw_widget_subs_known         Int     — 1 when pw_widget_subs was measured
//   pw_widget_open_rate_known    Int     — 1 when pw_widget_open_rate was
//   pw_widget_sent30d_known      Int     — 1 when pw_widget_sent30d was
//
// Commerce record (COMMERCE#70) — a SECOND, independently-timestamped
// transaction in the same container, behind the SAME consent marker:
//   pw_widget_commerce_schema      Int    — exact schema version
//   pw_widget_commerce_ready       Int    — exact 1 only after atomic JS write
//   pw_widget_commerce_store       String — bounded store display name
//   pw_widget_commerce_store_id    String — integration id (never rendered)
//   pw_widget_commerce_orders      Int    — lifetime order count
//   pw_widget_commerce_revenue     Int    — lifetime revenue, WHOLE MAJOR units
//   pw_widget_commerce_currency    String — ISO-4217 alpha-3 for that store
//   pw_widget_commerce_measured_at Int    — unix seconds the analytics were read
//   pw_widget_commerce_expires_at  Int    — unix seconds disclosure expires
//
// Sender-health record (DELIVERABILITY#64) — a THIRD one, same container, same
// consent marker:
//   pw_widget_deliv_schema      Int    — exact schema version
//   pw_widget_deliv_ready       Int    — exact 1 only after atomic JS write
//   pw_widget_deliv_score       Int    — 0...100 deliverability score
//   pw_widget_deliv_grade       String — exactly one of A B C D F
//   pw_widget_deliv_status      String — bounded human label ("Needs attention")
//   pw_widget_deliv_throttled   Int    — 1 when Moosewave already throttled sends
//   pw_widget_deliv_breaches    Int    — how many thresholds tripped
//   pw_widget_deliv_sends7d     Int    — sends the score was computed over
//   pw_widget_deliv_measured_at Int    — unix seconds the SERVER computed it
//   pw_widget_deliv_expires_at  Int    — unix seconds disclosure expires
//
// Each is a separate record because it is measured at a different moment, from a
// different endpoint — see the long notes in src/lib/widgetCommerceSnapshot.ts
// and src/lib/widgetDeliverabilitySnapshot.ts. Any record may be present without
// the others, and both of the later two ALWAYS state their measurement time,
// because neither is written by a live poll.

import WidgetKit
import SwiftUI
import AppIntents

private let appGroup = "group.com.moosewave.app"
private let widgetOptInKey = "pw_widget_metrics_opt_in_v1"
private let widgetSchemaVersion = 1
// FRESH vs MAX AGE — see the long note on WIDGET_SNAPSHOT_FRESH_MS in
// src/lib/widgetData.ts. Past `freshSnapshotAge` the numbers are still shown,
// with the time they were measured; past `maxSnapshotAge` they are purged and
// refuse to render. Mirrored exactly on the JS side and pinned by
// src/lib/nativePrivacyContracts.test.ts.
private let freshSnapshotAge: TimeInterval = 15 * 60
private let maxSnapshotAge: TimeInterval = 12 * 60 * 60
// BACKWARDS CLOCK SKEW (NATIVE#46). The age check below is `age >= -skew`, so
// this number is how far in the FUTURE a snapshot's `updatedAt` may sit
// relative to this reader's clock before the record is treated as forged and
// PURGED.
//
// It was 0, which is not the conservative choice it looks like. The writer
// (src/lib/widgetData.ts) stamps `Date.now()` and this reader compares against
// `Date()`; any correction that moves the clock backwards between those two
// moments — an NTP step after a phone has been off the network, or somebody
// turning "Set Automatically" off — makes a perfectly valid snapshot look
// future-dated, and the widget destroys it and shows "Data expired · Open
// Moosewave to refresh" until the app is next opened. That is a privacy control
// firing for a reason that has nothing to do with privacy.
//
// What the constant actually defends is a snapshot outliving its disclosure
// window by winding the clock back, and the exposure that buys is bounded by
// this number and nothing else: the window can never exceed
// `maxSnapshotAge + maxFutureClockSkew`, because `declaredLifetime` is still
// capped at `maxSnapshotAge + 1` and `expiresAt > now` is still required. Two
// minutes against twelve hours is 0.3% — and it is worth stating that winding
// the clock back requires an unlocked device, which is a threshold past which
// simply opening Moosewave is easier.
//
// Pinned on both readers by src/lib/nativePrivacyContracts.test.ts and
// src/lib/appIntentsContract.test.ts, which also assert it stays a rounding
// error beside the disclosure window. The SHARE extension keeps 0 on purpose:
// its budget is a fifteen-minute hand-off, not a twelve-hour disclosure, and
// two minutes is a material fraction of fifteen.
private let maxFutureClockSkew: TimeInterval = 120
private let maxWorkspaceBytes = 128
private let maxWidgetInteger = 2_147_483_647
private let widgetSnapshotKeys = [
    "pw_widget_schema", "pw_widget_ready", "pw_widget_subs",
    "pw_widget_open_rate", "pw_widget_sent30d", "pw_widget_pending",
    "pw_widget_workspace", "pw_widget_updated_at", "pw_widget_expires_at",
    // The absence markers are purged with the disclosure they describe.
    "pw_widget_subs_known", "pw_widget_open_rate_known",
    "pw_widget_sent30d_known"
]

/// Whether a published figure was MEASURED (DASHBOARD#72).
///
/// `UserDefaults` hands back 0 for a missing Int, which is precisely the value
/// this has to distinguish from — so presence is tested with `object(forKey:)`
/// before the integer is read.
///
/// An ABSENT marker is not "false". It means the snapshot was written by a JS
/// bundle older than this contract, where an unmeasured figure had no
/// representation other than 0. `legacyMeaning` is what that build intended by
/// the value it wrote, so an older snapshot keeps rendering exactly as it did
/// rather than blanking out the moment the extension is updated.
private func measuredFlag(
    _ defaults: UserDefaults,
    _ key: String,
    legacyMeaning: @autoclosure () -> Bool
) -> Bool {
    guard defaults.object(forKey: key) != nil else { return legacyMeaning() }
    return defaults.integer(forKey: key) == 1
}

private func purgeSnapshotPreservingOptIn(_ defaults: UserDefaults) {
    for key in widgetSnapshotKeys { defaults.removeObject(forKey: key) }
}

// MARK: - Tap targets (DASHBOARD#49)
//
// Without a `.widgetURL`, tapping the widget launches the app to whatever
// route was last active — so a widget showing "3 to approve" could land you on
// a half-finished campaign editor.
//
// These are DESTINATION links in the grammar src/lib/navDeepLinks.ts resolves
// (`moosewave://<slug>` against the mobile route manifest), so they can only
// ever name a screen the app actually has, and planDeepLinkNavigation defers
// them until the user is signed in. They carry no identifiers, so nothing
// leaves the App Group in the URL.
private let dashboardWidgetURL = "moosewave://dashboard"
private let approvalsWidgetURL = "moosewave://approvals"
// `commerce` is the route KEY in src/lib/mobileRoutesAdmin.ts, which is what
// navDeepLinks.ts resolves slugs against — so this link can only ever name the
// Stores screen the app really ships.
private let commerceWidgetURL = "moosewave://commerce"
// `deliverability` is the route KEY in src/lib/mobileRoutesCore.ts, resolved by
// the same `routeForNavLink` grammar and pinned by lib/widgetLinkContract.test.ts.
private let deliverabilityWidgetURL = "moosewave://deliverability"

/// Both constants above are literals that parse, but a widget extension that
/// traps is a blank tile the user cannot recover from — so no force unwraps
/// here. A nil destination simply means that region is not tappable.
private func widgetDestination(_ raw: String) -> URL? {
    URL(string: raw)
}

// MARK: - Brand

private enum Brand {
    // The accent is the one value that is identical in both schemes — it is the
    // brand mark, and it clears contrast against both papers below.
    static let accent = Color(red: 0.898, green: 0.322, blue: 0.384)
    static let muted = Color.secondary

    // NATIVE#21: ink and paper used to be hardcoded light values, so a widget on
    // a dark home screen rendered a bright cream card with near-black text —
    // the one element on the screen ignoring the system appearance. These mirror
    // the light/dark pair src/lib/theme.ts derives from @postwave/design-tokens.
    static func ink(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.96, green: 0.96, blue: 0.96)
            : Color(red: 0.10, green: 0.10, blue: 0.10)
    }

    static func paper(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.09, green: 0.09, blue: 0.10)
            : Color(red: 0.98, green: 0.97, blue: 0.96)
    }
}

// MARK: - Snapshot

struct Snapshot {
    var subs: Int
    var openRate: Double
    var sent30d: Int
    var pending: Int
    var workspace: String
    var updatedAt: TimeInterval
    var expiresAt: TimeInterval
    var hasData: Bool
    var isEnabled: Bool
    // DASHBOARD#72. Whether each figure above is a measurement. `pending` has
    // no flag: neither JS writer publishes a pending count it did not measure.
    var subsKnown: Bool = true
    var openRateKnown: Bool = true
    var sent30dKnown: Bool = true

    /// Whether one configurable metric is a measurement.
    func isMeasured(_ metric: WidgetMetric) -> Bool {
        switch metric {
        case .subscribers: return subsKnown
        case .openRate: return openRateKnown
        case .sent30d: return sent30dKnown
        case .pending: return true
        }
    }

    static let hidden = Snapshot(
        subs: 0, openRate: 0, sent30d: 0, pending: 0,
        workspace: "Moosewave", updatedAt: 0, expiresAt: 0, hasData: false,
        isEnabled: false
    )

    static let expired = Snapshot(
        subs: 0, openRate: 0, sent30d: 0, pending: 0,
        workspace: "Moosewave", updatedAt: 0, expiresAt: 0, hasData: false,
        isEnabled: true
    )

    /// Words for how old the measurement is, or nil while it is still fresh.
    /// A number without its measurement time is the lie this replaces: the
    /// widget used to either show a value as if it were live, or hide it
    /// entirely.
    func staleness(at now: Date) -> String? {
        guard hasData, updatedAt > 0 else { return nil }
        let age = now.timeIntervalSince1970 - updatedAt
        guard age >= freshSnapshotAge else { return nil }
        let minutes = Int(age / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = Int(age / 3600)
        return "\(hours)h ago"
    }

    static func load(at now: Date = Date()) -> Snapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .hidden
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            // Upgrade cleanup for older releases that wrote metrics without
            // an explicit disclosure marker.
            purgeSnapshotPreservingOptIn(defaults)
            return .hidden
        }

        // A stale/partial transaction is never treated as a valid snapshot.
        guard defaults.integer(forKey: "pw_widget_schema") == widgetSchemaVersion,
              defaults.integer(forKey: "pw_widget_ready") == 1,
              defaults.object(forKey: "pw_widget_subs") != nil,
              defaults.object(forKey: "pw_widget_open_rate") != nil,
              defaults.object(forKey: "pw_widget_sent30d") != nil,
              defaults.object(forKey: "pw_widget_pending") != nil,
              defaults.object(forKey: "pw_widget_workspace") != nil,
              defaults.object(forKey: "pw_widget_updated_at") != nil,
              defaults.object(forKey: "pw_widget_expires_at") != nil else {
            purgeSnapshotPreservingOptIn(defaults)
            return .expired
        }

        let updatedAt = defaults.double(forKey: "pw_widget_updated_at")
        let expiresAt = defaults.double(forKey: "pw_widget_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - updatedAt
        let declaredLifetime = expiresAt - updatedAt

        // Validate both ends of the declared TTL. This rejects missing,
        // future-skewed, expired, and artificially extended snapshots.
        guard updatedAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            purgeSnapshotPreservingOptIn(defaults)
            return .expired
        }

        let subs = defaults.integer(forKey: "pw_widget_subs")
        let openRate = defaults.double(forKey: "pw_widget_open_rate")
        let sent30d = defaults.integer(forKey: "pw_widget_sent30d")
        let pending = defaults.integer(forKey: "pw_widget_pending")
        let workspace = (defaults.string(forKey: "pw_widget_workspace") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let workspaceBytes = workspace.data(using: .utf8)?.count ?? 0

        guard (0...maxWidgetInteger).contains(subs),
              (0...100).contains(openRate),
              (0...maxWidgetInteger).contains(sent30d),
              (0...maxWidgetInteger).contains(pending),
              workspaceBytes > 0,
              workspaceBytes <= maxWorkspaceBytes,
              workspace.rangeOfCharacter(from: .controlCharacters) == nil else {
            purgeSnapshotPreservingOptIn(defaults)
            return .expired
        }

        return Snapshot(
            subs: subs,
            openRate: openRate,
            sent30d: sent30d,
            pending: pending,
            workspace: workspace,
            updatedAt: updatedAt,
            expiresAt: expiresAt,
            hasData: true,
            isEnabled: true,
            // The legacy readings this falls back to are the two DIFFERENT
            // guesses the pre-marker builds made, preserved exactly: a count of
            // 0 was drawn as "0", and an open rate of 0 was drawn as an
            // em-dash. Neither guess is repeated for a snapshot that carries
            // the markers.
            subsKnown: measuredFlag(
                defaults, "pw_widget_subs_known", legacyMeaning: true
            ),
            openRateKnown: measuredFlag(
                defaults, "pw_widget_open_rate_known", legacyMeaning: openRate > 0
            ),
            sent30dKnown: measuredFlag(
                defaults, "pw_widget_sent30d_known", legacyMeaning: true
            )
        )
    }
}

// MARK: - Configuration (DASHBOARD#47)
//
// This widget used to be a `StaticConfiguration`, which meant every person who
// placed it got the same four numbers in the same order and the Lock Screen
// circle was hardwired to the approvals count. There is no one right answer to
// "which number belongs on my home screen": a sender watches Sent 30d, an
// approver watches the queue, a growth owner watches Subscribers. So the choice
// is the user's, made where iOS has taught people to look for it — long-press →
// Edit Widget — and made PER PLACED INSTANCE, so two small tiles can show two
// different things.
//
// NO NEW APP GROUP KEY, AND SO NO CHANGE TO THE PRIVACY CONTRACT at the top of
// this file. All four integers were already published under the existing
// disclosure (`pw_widget_subs` / `pw_widget_open_rate` / `pw_widget_sent30d` /
// `pw_widget_pending`); the configuration only decides which of them is drawn
// where. WidgetKit stores the selection itself, in the widget's own per-instance
// intent storage — nothing about it is written to the shared container, so
// logout / app-lock / account teardown purge exactly what they purged before.
//
// The iOS 17 floor this forced onto the extension is argued in
// expo-target.config.js, next to the number it changed.
//
// The `kind` is deliberately UNCHANGED ("PostwaveWidget"): an already-placed
// tile migrates onto the intent and picks up its defaults, which are the same
// headline + companion pair the static layout drew. Nobody's home screen moves.

/// One number the widget can be asked to show. The cases ARE the four
/// published App Group metrics — `src/lib/widgetConfigurationContract.test.ts`
/// fails if this list and the writer in `src/lib/widgetData.ts` drift apart.
enum WidgetMetric: String, AppEnum, CaseIterable {
    case subscribers
    case openRate
    case sent30d
    case pending

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Metric"

    static var caseDisplayRepresentations: [WidgetMetric: DisplayRepresentation] = [
        .subscribers: DisplayRepresentation(
            title: "Subscribers",
            subtitle: "Everyone on your lists"
        ),
        .openRate: DisplayRepresentation(
            title: "Open rate",
            subtitle: "Share of delivered mail opened"
        ),
        .sent30d: DisplayRepresentation(
            title: "Sent 30d",
            subtitle: "Campaigns sent in the last 30 days"
        ),
        .pending: DisplayRepresentation(
            title: "To approve",
            subtitle: "Requests waiting on a decision"
        ),
    ]

    /// The caption drawn above the number on the home-screen families.
    var label: String {
        switch self {
        case .subscribers: return "Subscribers"
        case .openRate: return "Open rate"
        case .sent30d: return "Sent 30d"
        case .pending: return "To approve"
        }
    }

    /// Four characters, because that is what fits under a number inside the
    /// Lock Screen circle. Never used anywhere a full label would fit.
    var abbreviation: String {
        switch self {
        case .subscribers: return "SUBS"
        case .openRate: return "OPEN"
        case .sent30d: return "SENT"
        case .pending: return "APPR"
        }
    }

    /// The noun phrase that follows the value in a sentence — accessory inline
    /// is one line of plain text next to the clock, so the words carry it all.
    var noun: String {
        switch self {
        case .subscribers: return "subscribers"
        case .openRate: return "open"
        case .sent30d: return "sent 30d"
        case .pending: return "to approve"
        }
    }
}

/// The widget's edit sheet. Two choices rather than four: the headline is the
/// big accent number (and the ONLY number the Lock Screen families have room
/// for), the companion sits beside it. The medium family still shows all four —
/// it has the width — but orders them headline-first.
struct PostwaveMetricsIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Moosewave Metrics"
    static var description = IntentDescription(
        "Choose which workspace numbers this widget shows."
    )

    @Parameter(title: "Headline", default: .subscribers)
    var headline: WidgetMetric

    @Parameter(title: "Beside it", default: .openRate)
    var companion: WidgetMetric

    init() {}

    init(headline: WidgetMetric, companion: WidgetMetric) {
        self.headline = headline
        self.companion = companion
    }

    /// Headline, companion, then whatever is left — each metric exactly once.
    /// Picking the same metric twice in the edit sheet is legal and must not
    /// render it twice or drop one, so this de-duplicates rather than assuming.
    var orderedMetrics: [WidgetMetric] {
        var out: [WidgetMetric] = []
        for metric in [headline, companion] where !out.contains(metric) {
            out.append(metric)
        }
        for metric in WidgetMetric.allCases where !out.contains(metric) {
            out.append(metric)
        }
        return out
    }
}

extension Snapshot {
    /// The compacted, drawn form of one metric.
    ///
    /// DASHBOARD#72: the em-dash means NOT MEASURED and nothing else. It is
    /// chosen by the marker that travelled with the figure, never inferred from
    /// the figure — which is what let a real 0% open rate hide behind the same
    /// dash as a missing field, and let a missing subscriber count render as a
    /// confident "0".
    func value(for metric: WidgetMetric) -> String {
        guard isMeasured(metric) else { return unmeasuredMark }
        switch metric {
        case .subscribers: return compact(subs)
        case .openRate: return pct(openRate)
        case .sent30d: return compact(sent30d)
        case .pending: return "\(pending)"
        }
    }

    /// The value followed by its noun, for the one-line accessory families.
    /// They have no room for a legend, so an unmeasured figure spends its line
    /// saying that rather than showing a dash nothing explains.
    func phrase(for metric: WidgetMetric) -> String {
        isMeasured(metric)
            ? "\(value(for: metric)) \(metric.noun)"
            : "\(metric.label.lowercased()) not measured"
    }

    /// The spoken form, which is NOT the drawn one: "12.4k" is a rounding and
    /// VoiceOver should hear the figure. An em-dash is not a sound, so every
    /// unmeasured metric says so in words.
    func spoken(for metric: WidgetMetric) -> String {
        guard isMeasured(metric) else {
            switch metric {
            case .subscribers: return "subscriber count not measured"
            case .openRate: return "open rate not measured"
            case .sent30d: return "campaigns sent not measured"
            case .pending: return "approvals waiting not measured"
            }
        }
        switch metric {
        case .subscribers: return "\(subs) subscribers"
        case .openRate:
            // Said as a measurement even at zero — "0 percent open rate" is the
            // sentence the operator of a send that nobody opened needs to hear.
            return "\(Int(openRate.rounded())) percent open rate"
        case .sent30d: return "\(sent30d) campaigns sent in the last 30 days"
        case .pending: return "\(pending) waiting for approval"
        }
    }
}

// MARK: - Timeline

struct PostwaveEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot
    let configuration: PostwaveMetricsIntent
}

struct Provider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> PostwaveEntry {
        PostwaveEntry(
            date: Date(),
            snapshot: Snapshot(
                subs: 12400, openRate: 42, sent30d: 18, pending: 2,
                workspace: "Moosewave", updatedAt: Date().timeIntervalSince1970,
                expiresAt: 0, hasData: true,
                isEnabled: true),
            configuration: PostwaveMetricsIntent())
    }

    func snapshot(
        for configuration: PostwaveMetricsIntent,
        in context: Context
    ) async -> PostwaveEntry {
        PostwaveEntry(
            date: Date(),
            snapshot: Snapshot.load(),
            configuration: configuration)
    }

    func timeline(
        for configuration: PostwaveMetricsIntent,
        in context: Context
    ) async -> Timeline<PostwaveEntry> {
        let now = Date()
        let snapshot = Snapshot.load(at: now)
        var entries = [
            PostwaveEntry(date: now, snapshot: snapshot, configuration: configuration)
        ]
        var refreshAt = Calendar.current.date(byAdding: .hour, value: 1, to: now) ?? now

        if snapshot.hasData {
            // Re-render at the freshness boundary and hourly after it, so the
            // "as of" line ages with the data instead of freezing at whatever
            // it said when the timeline was built. Each entry carries the SAME
            // snapshot — only the entry date moves, and `staleness(at:)` is
            // computed against it.
            let updatedAt = Date(timeIntervalSince1970: snapshot.updatedAt)
            let expiresAt = Date(timeIntervalSince1970: snapshot.expiresAt)
            var mark = updatedAt.addingTimeInterval(freshSnapshotAge)
            while mark < expiresAt && entries.count < 12 {
                if mark > now {
                    entries.append(PostwaveEntry(
                        date: mark,
                        snapshot: snapshot,
                        configuration: configuration))
                }
                mark = mark.addingTimeInterval(3600)
            }
            if expiresAt > now {
                // Explicit empty entry prevents the previously rendered
                // metrics from surviving in an existing timeline past TTL.
                entries.append(PostwaveEntry(
                    date: expiresAt,
                    snapshot: .expired,
                    configuration: configuration))
                refreshAt = expiresAt
            }
        }

        return Timeline(entries: entries, policy: .after(refreshAt))
    }
}

// MARK: - Views

private struct Metric: View {
    @Environment(\.colorScheme) private var colorScheme
    let label: String
    let value: String
    var accent: Bool = false
    /// The exact figure, when `value` is a compaction of it ("12.4k"). Read
    /// instead of the drawn text, so VoiceOver hears the number rather than
    /// the rounding. nil means the drawn value already IS exact.
    var spoken: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Brand.muted)
                .tracking(0.4)
            Text(value)
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(accent ? Brand.accent : Brand.ink(colorScheme))
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spoken ?? "\(label): \(value)"))
    }
}

private struct Header: View {
    @Environment(\.colorScheme) private var colorScheme
    let workspace: String
    /// "2h ago" once the snapshot is past its freshness window; nil while
    /// current. Replaces the fixed "Overview" caption, which said nothing.
    let staleness: String?

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Brand.accent).frame(width: 7, height: 7)
            Text(workspace)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(staleness ?? "Overview")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
    }
}

private struct EmptyState: View {
    @Environment(\.colorScheme) private var colorScheme
    let isEnabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Circle().fill(Brand.accent).frame(width: 7, height: 7)
                Text("Moosewave").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Brand.ink(colorScheme))
            }
            Spacer(minLength: 0)
            Text(isEnabled ? "Data expired" : "Metrics hidden")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
            Text(isEnabled
                 ? "Open Moosewave to refresh the private snapshot."
                 : "Opt in from Moosewave Settings to show workspace metrics.")
                .font(.system(size: 11))
                .foregroundStyle(Brand.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// What is drawn in place of a figure that was never measured. One glyph, one
/// meaning — `pct()` below no longer produces it, so it cannot also mean zero.
private let unmeasuredMark = "—"

/// DASHBOARD#72: no `<= 0` branch. A measured 0% is rendered as "0%"; whether
/// the figure was measured at all is the caller's question, not this one's.
private func pct(_ value: Double) -> String {
    String(format: "%.0f%%", max(0, value))
}

private func compact(_ number: Int) -> String {
    let value = Double(number)
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1_000 { return String(format: "%.1fk", value / 1_000) }
    return "\(number)"
}

struct SmallView: View {
    let snapshot: Snapshot
    let now: Date
    let configuration: PostwaveMetricsIntent

    var body: some View {
        if !snapshot.hasData {
            EmptyState(isEnabled: snapshot.isEnabled)
        } else {
            let ordered = configuration.orderedMetrics
            let headline = ordered.first ?? .subscribers
            let companion = ordered.dropFirst().first ?? .openRate
            VStack(alignment: .leading, spacing: 0) {
                Header(
                    workspace: snapshot.workspace,
                    staleness: snapshot.staleness(at: now)
                )
                Spacer(minLength: 0)
                Metric(
                    label: headline.label,
                    value: snapshot.value(for: headline),
                    accent: true,
                    spoken: snapshot.spoken(for: headline)
                )
                Spacer(minLength: 6)
                HStack(spacing: 12) {
                    Metric(
                        label: companion.label,
                        value: snapshot.value(for: companion),
                        spoken: snapshot.spoken(for: companion)
                    )
                    // The approvals queue keeps its standing invitation onto
                    // the small tile: it is the only number here that is asking
                    // for an action rather than reporting one. It appears only
                    // when something is actually waiting, and only when the
                    // user's own two choices have not already claimed the row.
                    if snapshot.pending > 0,
                       headline != .pending,
                       companion != .pending {
                        Metric(
                            label: WidgetMetric.pending.label,
                            value: snapshot.value(for: .pending),
                            spoken: snapshot.spoken(for: .pending)
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
        }
    }
}

struct MediumView: View {
    let snapshot: Snapshot
    let now: Date
    let configuration: PostwaveMetricsIntent

    var body: some View {
        if !snapshot.hasData {
            EmptyState(isEnabled: snapshot.isEnabled)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Header(
                    workspace: snapshot.workspace,
                    staleness: snapshot.staleness(at: now)
                )
                Spacer(minLength: 0)
                // Medium is wide enough for all four, so configuration ORDERS
                // them here rather than choosing between them — the headline
                // still reads first and takes the accent.
                HStack(alignment: .bottom, spacing: 18) {
                    ForEach(configuration.orderedMetrics, id: \.self) { metric in
                        // DASHBOARD#49: the medium widget is wide enough for each
                        // metric to be its own tap target, so "To approve" opens
                        // the approvals queue instead of wherever the app was last
                        // left. `Link` inside a widget is the only per-region tap
                        // affordance WidgetKit offers.
                        if metric == .pending,
                           let approvals = widgetDestination(approvalsWidgetURL) {
                            Link(destination: approvals) {
                                metricView(metric)
                            }
                        } else {
                            metricView(metric)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
        }
    }

    private func metricView(_ metric: WidgetMetric) -> some View {
        Metric(
            label: metric.label,
            value: snapshot.value(for: metric),
            accent: metric == configuration.orderedMetrics.first,
            spoken: snapshot.spoken(for: metric)
        )
    }
}

// MARK: - Accessory (Lock Screen / StandBy) views
//
// NATIVE#17. The widget shipped systemSmall/systemMedium only, so the surface
// where a pending approval is most likely to be SEEN — the Lock Screen, and
// StandBy on a charging phone — showed nothing at all.
//
// Accessory families render in a monochrome vibrant mode: colour carries no
// information here, so every state is stated in words or digits. The metric
// content stays `.privacySensitive()` because the Lock Screen is precisely
// where iOS is expected to redact it on a locked device.

private struct AccessoryCircularView: View {
    let snapshot: Snapshot
    let configuration: PostwaveMetricsIntent

    private var headline: WidgetMetric {
        configuration.orderedMetrics.first ?? .subscribers
    }

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if snapshot.hasData {
                VStack(spacing: 0) {
                    Text(snapshot.value(for: headline))
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    // Four characters is all this circle has, so the tag says
                    // WHICH number it is — a bare digit on the Lock Screen was
                    // ambiguous the moment the metric became the user's choice.
                    Text(headline.abbreviation)
                        .font(.system(size: 8, weight: .semibold))
                }
                .privacySensitive()
            } else {
                Image(systemName: "envelope")
                    .font(.system(size: 16, weight: .semibold))
            }
        }
        .widgetAccessibilityLabel(
            snapshot.hasData
                ? snapshot.spoken(for: headline)
                : accessoryEmptyLabel(isEnabled: snapshot.isEnabled)
        )
    }
}

private struct AccessoryRectangularView: View {
    let snapshot: Snapshot
    let now: Date
    let configuration: PostwaveMetricsIntent

    var body: some View {
        let ordered = configuration.orderedMetrics
        let headline = ordered.first ?? .subscribers
        let rest = Array(ordered.dropFirst().prefix(2))
        return Group {
            if snapshot.hasData {
                VStack(alignment: .leading, spacing: 1) {
                    Text(
                        snapshot.staleness(at: now).map {
                            "\(snapshot.workspace) · \($0)"
                        } ?? snapshot.workspace
                    )
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text(snapshot.phrase(for: headline))
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text(
                        rest
                            .map { snapshot.phrase(for: $0) }
                            .joined(separator: " · ")
                    )
                        .font(.system(size: 11))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .privacySensitive()
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Moosewave").font(.system(size: 12, weight: .semibold))
                    Text(snapshot.isEnabled ? "Data expired" : "Metrics hidden")
                        .font(.system(size: 13, weight: .semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetAccessibilityLabel(
            snapshot.hasData
                ? ([headline] + rest)
                    .map { snapshot.spoken(for: $0) }
                    .joined(separator: ", ")
                : accessoryEmptyLabel(isEnabled: snapshot.isEnabled)
        )
    }
}

private struct AccessoryInlineView: View {
    let snapshot: Snapshot
    let configuration: PostwaveMetricsIntent

    var body: some View {
        let headline = configuration.orderedMetrics.first ?? .subscribers
        // Inline is a single line next to the clock; iOS strips styling, so the
        // whole meaning has to fit in the words.
        return Text(
            snapshot.hasData
                ? snapshot.phrase(for: headline)
                : (snapshot.isEnabled ? "Moosewave · refresh" : "Moosewave · hidden")
        )
    }
}

private func accessoryEmptyLabel(isEnabled: Bool) -> String {
    isEnabled
        ? "Moosewave metrics expired. Open Moosewave to refresh."
        : "Moosewave metrics hidden. Opt in from Moosewave Settings."
}

struct PostwaveWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) private var colorScheme
    var entry: Provider.Entry

    var body: some View {
        // Every family gets a destination. The accessory families and the
        // small widget are single tap targets, so the whole view carries the
        // URL; the medium widget additionally wraps its approvals metric in a
        // `Link`, which takes precedence over the container's widgetURL for
        // that region.
        //
        // Approvals is the default destination whenever something is waiting:
        // a pending decision is the only thing on this widget that is asking
        // the person for an action rather than reporting a number.
        let destination = entry.snapshot.hasData && entry.snapshot.pending > 0
            ? approvalsWidgetURL
            : dashboardWidgetURL

        return Group {
            switch family {
            case .accessoryCircular:
                AccessoryCircularView(
                    snapshot: entry.snapshot,
                    configuration: entry.configuration
                ).pwAccessoryContainer()
            case .accessoryRectangular:
                AccessoryRectangularView(
                    snapshot: entry.snapshot,
                    now: entry.date,
                    configuration: entry.configuration
                ).pwAccessoryContainer()
            case .accessoryInline:
                AccessoryInlineView(
                    snapshot: entry.snapshot,
                    configuration: entry.configuration
                ).pwAccessoryContainer()
            case .systemMedium:
                MediumView(
                    snapshot: entry.snapshot,
                    now: entry.date,
                    configuration: entry.configuration
                ).pwWidgetBackground(Brand.paper(colorScheme))
            default:
                SmallView(
                    snapshot: entry.snapshot,
                    now: entry.date,
                    configuration: entry.configuration
                ).pwWidgetBackground(Brand.paper(colorScheme))
            }
        }
        .widgetURL(widgetDestination(destination))
    }
}

private extension View {
    @ViewBuilder
    func pwWidgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(color, for: .widget)
        } else {
            self.background(color)
        }
    }

    /// iOS 17 requires every widget to declare a container background, but an
    /// accessory widget must not paint one — the Lock Screen supplies its own
    /// vibrant material. Clear satisfies the requirement without overpainting.
    @ViewBuilder
    func pwAccessoryContainer() -> some View {
        if #available(iOS 17.0, *) {
            self.containerBackground(Color.clear, for: .widget)
        } else {
            self
        }
    }

    /// One spoken sentence for a glanceable, heavily compacted view — "3" in a
    /// circle is meaningless to VoiceOver without it.
    func widgetAccessibilityLabel(_ label: String) -> some View {
        self.accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(label))
    }
}

// MARK: - Commerce record (COMMERCE#70)
//
// Everything below reads the SECOND record described at the top of this file.
// Three rules it does not share with the dashboard snapshot:
//
//  1. IT ALWAYS STATES ITS AGE. The dashboard snapshot hides its "as of" line
//     while it is inside the fifteen-minute freshness window because a live
//     poll is what wrote it. Nothing polls a store's totals in the background
//     of the app — the writer is the Stores tab, plus a background re-read of
//     the same store — so a commerce figure with no timestamp beside it would
//     imply a currency that is not being watched. There is no fresh window
//     here; there is a measurement and the time it was taken.
//  2. "NEVER MEASURED" IS NOT "EXPIRED". A device whose owner has never opened
//     Stores has no record at all, and the honest thing to say is what to do
//     about it, not that something lapsed.
//  3. REVENUE IS ALL-TIME AND IS LABELLED THAT WAY. `Repo.Analytics` sums
//     every ingested order with no date predicate (repo.go:2576-2584); a bare
//     "Revenue" on a home screen would read as today's.

private let commerceSchemaVersion = 1
private let maxStoreBytes = 64
private let commerceSnapshotKeys = [
    "pw_widget_commerce_schema", "pw_widget_commerce_ready",
    "pw_widget_commerce_store", "pw_widget_commerce_store_id",
    "pw_widget_commerce_orders", "pw_widget_commerce_revenue",
    "pw_widget_commerce_currency", "pw_widget_commerce_measured_at",
    "pw_widget_commerce_expires_at"
]

private func purgeCommercePreservingOptIn(_ defaults: UserDefaults) {
    for key in commerceSnapshotKeys { defaults.removeObject(forKey: key) }
}

struct CommerceSnapshot {
    /// Three absences that are three different sentences.
    enum Absence {
        /// The user has not opted into widget metrics at all.
        case optedOut
        /// Opted in, but no store has ever been published from the Stores tab.
        case neverMeasured
        /// A record existed and its twelve-hour disclosure window has closed.
        case expired
    }

    var store: String
    var orders: Int
    /// Whole MAJOR currency units — see src/lib/widgetCommerceSnapshot.ts.
    var revenueMajor: Int
    var currency: String
    var measuredAt: TimeInterval
    var expiresAt: TimeInterval
    var absence: Absence?

    var hasData: Bool { absence == nil }

    static func empty(_ absence: Absence) -> CommerceSnapshot {
        CommerceSnapshot(
            store: "", orders: 0, revenueMajor: 0, currency: "",
            measuredAt: 0, expiresAt: 0, absence: absence
        )
    }

    /// How old the measurement is, in words. Never nil for a populated record:
    /// this figure is never live, so it always says when it was taken.
    func measuredAgo(at now: Date) -> String {
        let age = now.timeIntervalSince1970 - measuredAt
        if age < 60 { return "just now" }
        let minutes = Int(age / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(Int(age / 3600))h ago"
    }

    static func load(at now: Date = Date()) -> CommerceSnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .empty(.optedOut)
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            purgeCommercePreservingOptIn(defaults)
            return .empty(.optedOut)
        }
        // A missing ready marker means either "nothing was ever written" or "a
        // write is in flight". Both are `neverMeasured`: in each case the app
        // is the thing that has to run, and neither is a lapsed disclosure.
        guard defaults.integer(forKey: "pw_widget_commerce_ready") == 1,
              defaults.integer(forKey: "pw_widget_commerce_schema") == commerceSchemaVersion,
              defaults.object(forKey: "pw_widget_commerce_store") != nil,
              defaults.object(forKey: "pw_widget_commerce_orders") != nil,
              defaults.object(forKey: "pw_widget_commerce_revenue") != nil,
              defaults.object(forKey: "pw_widget_commerce_currency") != nil,
              defaults.object(forKey: "pw_widget_commerce_measured_at") != nil,
              defaults.object(forKey: "pw_widget_commerce_expires_at") != nil else {
            return .empty(.neverMeasured)
        }

        let measuredAt = defaults.double(forKey: "pw_widget_commerce_measured_at")
        let expiresAt = defaults.double(forKey: "pw_widget_commerce_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - measuredAt
        let declaredLifetime = expiresAt - measuredAt

        // Same both-ends TTL validation the dashboard record gets: rejects
        // missing, future-skewed, expired and artificially extended windows.
        guard measuredAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            purgeCommercePreservingOptIn(defaults)
            return .empty(.expired)
        }

        let store = (defaults.string(forKey: "pw_widget_commerce_store") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let currency = (defaults.string(forKey: "pw_widget_commerce_currency") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let orders = defaults.integer(forKey: "pw_widget_commerce_orders")
        let revenue = defaults.integer(forKey: "pw_widget_commerce_revenue")
        let storeBytes = store.data(using: .utf8)?.count ?? 0

        guard storeBytes > 0,
              storeBytes <= maxStoreBytes,
              store.rangeOfCharacter(from: .controlCharacters) == nil,
              currency.count == 3,
              currency.allSatisfy({ $0.isUppercase && $0.isLetter }),
              (0...maxWidgetInteger).contains(orders),
              (0...maxWidgetInteger).contains(revenue) else {
            purgeCommercePreservingOptIn(defaults)
            return .empty(.expired)
        }

        return CommerceSnapshot(
            store: store, orders: orders, revenueMajor: revenue,
            currency: currency, measuredAt: measuredAt, expiresAt: expiresAt,
            absence: nil
        )
    }
}

/// The store's OWN currency, never a hard-coded dollar sign — the same rule
/// StoreAnalyticsCard follows on screen. Fraction digits are dropped because
/// the figure is a lifetime total on a home-screen tile, not a receipt; the
/// spoken label carries the same rounded figure so the two never disagree.
private func storeMoney(_ amount: Int, _ code: String) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = code
    formatter.maximumFractionDigits = 0
    formatter.minimumFractionDigits = 0
    if let text = formatter.string(from: NSNumber(value: amount)) {
        return text
    }
    // A formatter that cannot resolve the code must not silently become "$".
    return "\(amount) \(code)"
}

private func commerceAbsenceTitle(_ absence: CommerceSnapshot.Absence) -> String {
    switch absence {
    case .optedOut: return "Metrics hidden"
    case .neverMeasured: return "No store yet"
    case .expired: return "Store numbers expired"
    }
}

private func commerceAbsenceDetail(_ absence: CommerceSnapshot.Absence) -> String {
    switch absence {
    case .optedOut:
        return "Opt in from Moosewave Settings to show store totals."
    case .neverMeasured:
        // Says the actual requirement rather than "no data": these numbers are
        // published by the Stores tab, so nothing here can fill it in.
        return "Open Stores in Moosewave to publish a store's totals."
    case .expired:
        return "Open Stores in Moosewave to refresh them."
    }
}

private struct CommerceEmptyState: View {
    @Environment(\.colorScheme) private var colorScheme
    let absence: CommerceSnapshot.Absence

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Circle().fill(Brand.accent).frame(width: 7, height: 7)
                Text("Moosewave Stores")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Brand.ink(colorScheme))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(commerceAbsenceTitle(absence))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
            Text(commerceAbsenceDetail(absence))
                .font(.system(size: 11))
                .foregroundStyle(Brand.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct CommerceHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    let store: String
    let measuredAgo: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Brand.accent).frame(width: 7, height: 7)
            Text(store)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(measuredAgo)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
    }
}

struct CommerceSmallView: View {
    let snapshot: CommerceSnapshot
    let now: Date

    var body: some View {
        if let absence = snapshot.absence {
            CommerceEmptyState(absence: absence)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                CommerceHeader(
                    store: snapshot.store,
                    measuredAgo: snapshot.measuredAgo(at: now)
                )
                Spacer(minLength: 0)
                Metric(
                    label: "All-time revenue",
                    value: storeMoney(snapshot.revenueMajor, snapshot.currency),
                    accent: true
                )
                Spacer(minLength: 6)
                Metric(label: "Orders", value: compact(snapshot.orders))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(commerceSpokenLabel(snapshot, at: now)))
        }
    }
}

struct CommerceMediumView: View {
    let snapshot: CommerceSnapshot
    let now: Date

    var body: some View {
        if let absence = snapshot.absence {
            CommerceEmptyState(absence: absence)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                CommerceHeader(
                    store: snapshot.store,
                    measuredAgo: snapshot.measuredAgo(at: now)
                )
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 18) {
                    Metric(
                        label: "All-time revenue",
                        value: storeMoney(snapshot.revenueMajor, snapshot.currency),
                        accent: true
                    )
                    Metric(label: "Orders", value: compact(snapshot.orders))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 6)
                // The provenance line. It is not decoration: these totals are
                // written when somebody opens Stores (and re-read in the
                // background for that same store), so the widget says where its
                // numbers came from rather than implying a live feed.
                Text("Measured \(snapshot.measuredAgo(at: now)) · every order ingested")
                    .font(.system(size: 10))
                    .foregroundStyle(Brand.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(commerceSpokenLabel(snapshot, at: now)))
        }
    }
}

private struct CommerceAccessoryRectangularView: View {
    let snapshot: CommerceSnapshot
    let now: Date

    var body: some View {
        Group {
            if snapshot.hasData {
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(snapshot.store) · \(snapshot.measuredAgo(at: now))")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text(storeMoney(snapshot.revenueMajor, snapshot.currency))
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text("\(compact(snapshot.orders)) orders, all time")
                        .font(.system(size: 11))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .privacySensitive()
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Moosewave Stores").font(.system(size: 12, weight: .semibold))
                    Text(commerceAbsenceTitle(snapshot.absence ?? .optedOut))
                        .font(.system(size: 13, weight: .semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetAccessibilityLabel(commerceSpokenLabel(snapshot, at: now))
    }
}

private struct CommerceAccessoryInlineView: View {
    let snapshot: CommerceSnapshot
    let now: Date

    var body: some View {
        // One line beside the clock, styling stripped by iOS — so the age has
        // to be inside the sentence or it is not there at all.
        Text(
            snapshot.hasData
                ? "\(storeMoney(snapshot.revenueMajor, snapshot.currency)) · \(snapshot.measuredAgo(at: now))"
                : "Moosewave Stores · \(commerceAbsenceTitle(snapshot.absence ?? .optedOut).lowercased())"
        )
    }
}

/// One spoken sentence. Compacted digits ("3.1k") are never what VoiceOver
/// hears — the exact count is spelled out, and the measurement time is part of
/// the same sentence so it cannot be skipped past.
private func commerceSpokenLabel(_ snapshot: CommerceSnapshot, at now: Date) -> String {
    guard snapshot.hasData else {
        let absence = snapshot.absence ?? .optedOut
        return "\(commerceAbsenceTitle(absence)). \(commerceAbsenceDetail(absence))"
    }
    return "\(snapshot.store): "
        + "\(storeMoney(snapshot.revenueMajor, snapshot.currency)) revenue "
        + "and \(snapshot.orders) orders, all time. "
        + "Measured \(snapshot.measuredAgo(at: now))."
}

struct CommerceEntry: TimelineEntry {
    let date: Date
    let snapshot: CommerceSnapshot
}

struct CommerceProvider: TimelineProvider {
    func placeholder(in context: Context) -> CommerceEntry {
        CommerceEntry(date: Date(), snapshot: CommerceSnapshot(
            store: "acme.myshopify.com", orders: 3120, revenueMajor: 45123,
            currency: "USD", measuredAt: Date().timeIntervalSince1970,
            expiresAt: 0, absence: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (CommerceEntry) -> Void) {
        completion(CommerceEntry(date: Date(), snapshot: CommerceSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CommerceEntry>) -> Void) {
        let now = Date()
        let snapshot = CommerceSnapshot.load(at: now)
        var entries = [CommerceEntry(date: now, snapshot: snapshot)]
        var refreshAt = Calendar.current.date(byAdding: .hour, value: 1, to: now) ?? now

        if snapshot.hasData {
            // Hourly re-renders exist ONLY to age the "as of" line. Every entry
            // carries the same snapshot; the date moves and `measuredAgo(at:)`
            // is computed against it, so the widget cannot freeze on the words
            // it happened to have when the timeline was built.
            let expiresAt = Date(timeIntervalSince1970: snapshot.expiresAt)
            var mark = Date(timeIntervalSince1970: snapshot.measuredAt)
                .addingTimeInterval(3600)
            while mark < expiresAt && entries.count < 12 {
                if mark > now {
                    entries.append(CommerceEntry(date: mark, snapshot: snapshot))
                }
                mark = mark.addingTimeInterval(3600)
            }
            if expiresAt > now {
                entries.append(CommerceEntry(date: expiresAt, snapshot: .empty(.expired)))
                refreshAt = expiresAt
            }
        }

        completion(Timeline(entries: entries, policy: .after(refreshAt)))
    }
}

struct PostwaveCommerceEntryView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) private var colorScheme
    var entry: CommerceProvider.Entry

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular:
                CommerceAccessoryRectangularView(snapshot: entry.snapshot, now: entry.date)
                    .pwAccessoryContainer()
            case .accessoryInline:
                CommerceAccessoryInlineView(snapshot: entry.snapshot, now: entry.date)
                    .pwAccessoryContainer()
            case .systemMedium:
                CommerceMediumView(snapshot: entry.snapshot, now: entry.date)
                    .pwWidgetBackground(Brand.paper(colorScheme))
            default:
                CommerceSmallView(snapshot: entry.snapshot, now: entry.date)
                    .pwWidgetBackground(Brand.paper(colorScheme))
            }
        }
        // One destination in every state: the screen that publishes these
        // numbers is also the screen that explains them, and it is the only
        // action any of the empty states can ask for.
        .widgetURL(widgetDestination(commerceWidgetURL))
    }
}

struct PostwaveCommerceWidget: Widget {
    let kind = "PostwaveCommerceWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CommerceProvider()) { entry in
            PostwaveCommerceEntryView(entry: entry)
        }
        .configurationDisplayName("Moosewave Store (Opt-in)")
        .description("Shows one connected store's all-time totals, with the time they were measured. Requires the same widget metrics opt-in.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

// MARK: - Sender-health record (DELIVERABILITY#64)
//
// Everything below reads the THIRD record described at the top of this file.
// Four rules it does not share with the dashboard snapshot:
//
//  1. IT ALWAYS STATES ITS AGE, and the age is the SERVER'S. `measuredAt` is
//     the hub payload's own `computed_at` (deliverability_hub/hub.go:201), not
//     the moment this device received it — the app's hub query is
//     snapshot-backed, so an offline phone replays a score that may be hours
//     old and must age accordingly instead of re-stamping itself.
//  2. "NEVER MEASURED" IS NOT "EXPIRED". A device whose owner has never opened
//     Deliverability has no record at all, and the honest thing to say is what
//     to do about it.
//  3. THE SCORE STARTS AT 100 AND SUBTRACTS (`scoreHub`, hub.go:420), so a
//     workspace that has sent nothing can score A. `sends7d` therefore travels
//     with the score and is rendered beside it: "A · no sends in 7 days" is a
//     different sentence from "A · 12,400 sends in 7 days", and only one of
//     them is evidence.
//  4. AUTO-THROTTLE IS STATED IN WORDS. It is the one bit here somebody would
//     act on at 2am, and colour is not information in the accessory families.

private let deliverabilitySchemaVersion = 1
private let maxDeliverabilityStatusBytes = 32
private let deliverabilityGrades: Set<String> = ["A", "B", "C", "D", "F"]
private let deliverabilitySnapshotKeys = [
    "pw_widget_deliv_schema", "pw_widget_deliv_ready",
    "pw_widget_deliv_score", "pw_widget_deliv_grade",
    "pw_widget_deliv_status", "pw_widget_deliv_throttled",
    "pw_widget_deliv_breaches", "pw_widget_deliv_sends7d",
    "pw_widget_deliv_measured_at", "pw_widget_deliv_expires_at"
]

private func purgeDeliverabilityPreservingOptIn(_ defaults: UserDefaults) {
    for key in deliverabilitySnapshotKeys { defaults.removeObject(forKey: key) }
}

struct DeliverabilitySnapshot {
    /// Three absences that are three different sentences.
    enum Absence {
        /// The user has not opted into widget metrics at all.
        case optedOut
        /// Opted in, but the Deliverability tab has never published a score.
        case neverMeasured
        /// A record existed and its twelve-hour disclosure window has closed.
        case expired
    }

    var score: Int
    /// Exactly one of A B C D F — the guard that the payload came from the
    /// scorer at all. See src/lib/widgetDeliverabilitySnapshot.ts.
    var grade: String
    var status: String
    var throttled: Bool
    var breaches: Int
    var sends7d: Int
    var measuredAt: TimeInterval
    var expiresAt: TimeInterval
    var absence: Absence?

    var hasData: Bool { absence == nil }

    /// How old the measurement is, in words. Never nil for a populated record:
    /// this figure is never live, so it always says when it was taken.
    func measuredAgo(at now: Date) -> String {
        let age = now.timeIntervalSince1970 - measuredAt
        if age < 60 { return "just now" }
        let minutes = Int(age / 60)
        if minutes < 60 { return "\(minutes)m ago" }
        return "\(Int(age / 3600))h ago"
    }

    /// What the score was computed over, in words.
    ///
    /// This is the line that stops an unearned "A" reading as proof of health:
    /// the scorer subtracts from 100, so a workspace that has sent nothing
    /// keeps every point it never risked.
    var evidence: String {
        sends7d == 0 ? "no sends in 7 days" : "\(compact(sends7d)) sends in 7 days"
    }

    static func empty(_ absence: Absence) -> DeliverabilitySnapshot {
        DeliverabilitySnapshot(
            score: 0, grade: "", status: "", throttled: false, breaches: 0,
            sends7d: 0, measuredAt: 0, expiresAt: 0, absence: absence
        )
    }

    static func load(at now: Date = Date()) -> DeliverabilitySnapshot {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            return .empty(.optedOut)
        }
        guard defaults.integer(forKey: widgetOptInKey) == 1 else {
            purgeDeliverabilityPreservingOptIn(defaults)
            return .empty(.optedOut)
        }
        // A missing ready marker means either "nothing was ever written" or "a
        // write is in flight". Both are `neverMeasured`: in each case the app
        // is the thing that has to run, and neither is a lapsed disclosure.
        guard defaults.integer(forKey: "pw_widget_deliv_ready") == 1,
              defaults.integer(forKey: "pw_widget_deliv_schema") == deliverabilitySchemaVersion,
              defaults.object(forKey: "pw_widget_deliv_score") != nil,
              defaults.object(forKey: "pw_widget_deliv_grade") != nil,
              defaults.object(forKey: "pw_widget_deliv_status") != nil,
              defaults.object(forKey: "pw_widget_deliv_throttled") != nil,
              defaults.object(forKey: "pw_widget_deliv_breaches") != nil,
              defaults.object(forKey: "pw_widget_deliv_sends7d") != nil,
              defaults.object(forKey: "pw_widget_deliv_measured_at") != nil,
              defaults.object(forKey: "pw_widget_deliv_expires_at") != nil else {
            return .empty(.neverMeasured)
        }

        let measuredAt = defaults.double(forKey: "pw_widget_deliv_measured_at")
        let expiresAt = defaults.double(forKey: "pw_widget_deliv_expires_at")
        let nowSeconds = now.timeIntervalSince1970
        let age = nowSeconds - measuredAt
        let declaredLifetime = expiresAt - measuredAt

        // Same both-ends TTL validation the other two records get: rejects
        // missing, future-skewed, expired and artificially extended windows.
        guard measuredAt > 0,
              age >= -maxFutureClockSkew,
              age <= maxSnapshotAge,
              declaredLifetime > 0,
              declaredLifetime <= maxSnapshotAge + 1,
              expiresAt > nowSeconds else {
            purgeDeliverabilityPreservingOptIn(defaults)
            return .empty(.expired)
        }

        let grade = (defaults.string(forKey: "pw_widget_deliv_grade") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        let status = (defaults.string(forKey: "pw_widget_deliv_status") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let score = defaults.integer(forKey: "pw_widget_deliv_score")
        let breaches = defaults.integer(forKey: "pw_widget_deliv_breaches")
        let sends7d = defaults.integer(forKey: "pw_widget_deliv_sends7d")
        let throttled = defaults.integer(forKey: "pw_widget_deliv_throttled") == 1
        let statusBytes = status.data(using: .utf8)?.count ?? 0

        // A score with no recognised grade beside it is exactly the drifted
        // payload the JS builder refuses to publish; refusing it again here is
        // what stops "0 · " being rendered as the worst possible verdict.
        guard deliverabilityGrades.contains(grade),
              statusBytes > 0,
              statusBytes <= maxDeliverabilityStatusBytes,
              status.rangeOfCharacter(from: .controlCharacters) == nil,
              (0...100).contains(score),
              (0...maxWidgetInteger).contains(breaches),
              (0...maxWidgetInteger).contains(sends7d) else {
            purgeDeliverabilityPreservingOptIn(defaults)
            return .empty(.expired)
        }

        return DeliverabilitySnapshot(
            score: score, grade: grade, status: status, throttled: throttled,
            breaches: breaches, sends7d: sends7d, measuredAt: measuredAt,
            expiresAt: expiresAt, absence: nil
        )
    }
}

private func deliverabilityAbsenceTitle(_ absence: DeliverabilitySnapshot.Absence) -> String {
    switch absence {
    case .optedOut: return "Metrics hidden"
    case .neverMeasured: return "No score yet"
    case .expired: return "Score expired"
    }
}

private func deliverabilityAbsenceDetail(_ absence: DeliverabilitySnapshot.Absence) -> String {
    switch absence {
    case .optedOut:
        return "Opt in from Moosewave Settings to show sender health."
    case .neverMeasured:
        // Says the actual requirement rather than "no data": the score is
        // published by the Deliverability tab, so nothing here can fill it in.
        return "Open Deliverability in Moosewave to publish your sender score."
    case .expired:
        return "Open Deliverability in Moosewave to refresh it."
    }
}

/// The breach count, in words. Zero is a MEASUREMENT here — the hub computed
/// the thresholds and none tripped — so it gets a sentence rather than a blank.
private func deliverabilityBreachLine(_ snapshot: DeliverabilitySnapshot) -> String {
    if snapshot.breaches == 0 { return "No thresholds tripped" }
    if snapshot.breaches == 1 { return "1 threshold tripped" }
    return "\(snapshot.breaches) thresholds tripped"
}

private struct DeliverabilityEmptyState: View {
    @Environment(\.colorScheme) private var colorScheme
    let absence: DeliverabilitySnapshot.Absence

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Circle().fill(Brand.accent).frame(width: 7, height: 7)
                Text("Moosewave Sender health")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Brand.ink(colorScheme))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Text(deliverabilityAbsenceTitle(absence))
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
            Text(deliverabilityAbsenceDetail(absence))
                .font(.system(size: 11))
                .foregroundStyle(Brand.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct DeliverabilityHeader: View {
    @Environment(\.colorScheme) private var colorScheme
    let measuredAgo: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(Brand.accent).frame(width: 7, height: 7)
            Text("Sender health")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Brand.ink(colorScheme))
                .lineLimit(1)
            Spacer(minLength: 0)
            Text(measuredAgo)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
    }
}

/// The score with its grade beside it, never the score alone.
///
/// The grade WORD is what carries the verdict; the tint is redundant
/// reinforcement. This is the same rule HubScoreCard follows on screen, and it
/// is the only reason the tile is readable in the monochrome accessory
/// families and to anyone who does not see the colour.
private struct DeliverabilityScore: View {
    @Environment(\.colorScheme) private var colorScheme
    let snapshot: DeliverabilitySnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("SCORE")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Brand.muted)
                .tracking(0.4)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(snapshot.score)")
                    .font(.system(size: 26, weight: .bold, design: .rounded))
                    .foregroundStyle(Brand.ink(colorScheme))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(snapshot.grade)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(Brand.accent)
                    .lineLimit(1)
            }
            Text(snapshot.status)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
    }
}

struct DeliverabilitySmallView: View {
    @Environment(\.colorScheme) private var colorScheme
    let snapshot: DeliverabilitySnapshot
    let now: Date

    var body: some View {
        if let absence = snapshot.absence {
            DeliverabilityEmptyState(absence: absence)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                DeliverabilityHeader(measuredAgo: snapshot.measuredAgo(at: now))
                Spacer(minLength: 0)
                DeliverabilityScore(snapshot: snapshot)
                Spacer(minLength: 4)
                // Throttling outranks the breach count: it is the one line here
                // that describes something already happening to this workspace's
                // mail rather than something that might.
                Text(snapshot.throttled
                     ? "Sending throttled"
                     : snapshot.evidence)
                    .font(.system(size: 10, weight: snapshot.throttled ? .semibold : .regular))
                    .foregroundStyle(snapshot.throttled ? Brand.accent : Brand.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(deliverabilitySpokenLabel(snapshot, at: now)))
        }
    }
}

struct DeliverabilityMediumView: View {
    @Environment(\.colorScheme) private var colorScheme
    let snapshot: DeliverabilitySnapshot
    let now: Date

    var body: some View {
        if let absence = snapshot.absence {
            DeliverabilityEmptyState(absence: absence)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                DeliverabilityHeader(measuredAgo: snapshot.measuredAgo(at: now))
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 18) {
                    DeliverabilityScore(snapshot: snapshot)
                    Metric(
                        label: "Sends, 7d",
                        value: compact(snapshot.sends7d),
                        spoken: "Sends in the last 7 days: \(snapshot.sends7d)"
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 6)
                Text(snapshot.throttled
                     ? "Sending throttled by Moosewave · \(deliverabilityBreachLine(snapshot))"
                     : "\(deliverabilityBreachLine(snapshot)) · measured \(snapshot.measuredAgo(at: now))")
                    .font(.system(size: 10, weight: snapshot.throttled ? .semibold : .regular))
                    .foregroundStyle(snapshot.throttled ? Brand.accent : Brand.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .privacySensitive()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(deliverabilitySpokenLabel(snapshot, at: now)))
        }
    }
}

private struct DeliverabilityAccessoryCircularView: View {
    let snapshot: DeliverabilitySnapshot
    let now: Date

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if snapshot.hasData {
                VStack(spacing: 0) {
                    Text("\(snapshot.score)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    // Four characters is all this circle has. The grade is what
                    // goes in them: a bare "82" on the Lock Screen could be any
                    // of the numbers this app publishes, and the letter is the
                    // verdict the colour cannot carry here.
                    Text(snapshot.throttled ? "THRTL" : snapshot.grade)
                        .font(.system(size: 8, weight: .semibold))
                        .lineLimit(1)
                }
                .privacySensitive()
            } else {
                Image(systemName: "shield")
                    .font(.system(size: 16, weight: .semibold))
            }
        }
        .widgetAccessibilityLabel(deliverabilitySpokenLabel(snapshot, at: now))
    }
}

private struct DeliverabilityAccessoryRectangularView: View {
    let snapshot: DeliverabilitySnapshot
    let now: Date

    var body: some View {
        Group {
            if snapshot.hasData {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Sender health · \(snapshot.measuredAgo(at: now))")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text("\(snapshot.score) · \(snapshot.grade) \(snapshot.status)")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .lineLimit(1)
                    Text(snapshot.throttled
                         ? "Sending throttled · \(snapshot.evidence)"
                         : "\(deliverabilityBreachLine(snapshot)) · \(snapshot.evidence)")
                        .font(.system(size: 11))
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .privacySensitive()
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Moosewave Sender health")
                        .font(.system(size: 12, weight: .semibold))
                    Text(deliverabilityAbsenceTitle(snapshot.absence ?? .optedOut))
                        .font(.system(size: 13, weight: .semibold))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .widgetAccessibilityLabel(deliverabilitySpokenLabel(snapshot, at: now))
    }
}

private struct DeliverabilityAccessoryInlineView: View {
    let snapshot: DeliverabilitySnapshot
    let now: Date

    var body: some View {
        // One line beside the clock, styling stripped by iOS — so the verdict
        // and the age both have to be inside the sentence or they are not
        // there at all.
        Text(
            snapshot.hasData
                ? (snapshot.throttled
                    ? "Sending throttled · \(snapshot.score) \(snapshot.grade)"
                    : "Sender \(snapshot.score) \(snapshot.grade) · \(snapshot.measuredAgo(at: now))")
                : "Moosewave sender health · \(deliverabilityAbsenceTitle(snapshot.absence ?? .optedOut).lowercased())"
        )
    }
}

/// One spoken sentence.
///
/// Three things it refuses to leave out, because each is a way the drawn tile
/// could be misread: the grade WORD (the tint is not information), what the
/// score was computed over (an unearned A is not health), and when the server
/// computed it.
private func deliverabilitySpokenLabel(_ snapshot: DeliverabilitySnapshot, at now: Date) -> String {
    guard snapshot.hasData else {
        let absence = snapshot.absence ?? .optedOut
        return "\(deliverabilityAbsenceTitle(absence)). \(deliverabilityAbsenceDetail(absence))"
    }
    let throttle = snapshot.throttled
        ? "Moosewave has throttled sending for this workspace. "
        : ""
    let evidence = snapshot.sends7d == 0
        ? "No sends in the last 7 days"
        : "\(snapshot.sends7d) sends in the last 7 days"
    return "Sender health \(snapshot.score) out of 100, grade \(snapshot.grade), \(snapshot.status). "
        + throttle
        + "\(deliverabilityBreachLine(snapshot)). "
        + "\(evidence). "
        + "Measured \(snapshot.measuredAgo(at: now))."
}

struct DeliverabilityEntry: TimelineEntry {
    let date: Date
    let snapshot: DeliverabilitySnapshot
}

struct DeliverabilityProvider: TimelineProvider {
    func placeholder(in context: Context) -> DeliverabilityEntry {
        DeliverabilityEntry(date: Date(), snapshot: DeliverabilitySnapshot(
            score: 86, grade: "B", status: "Good", throttled: false,
            breaches: 1, sends7d: 12_400,
            measuredAt: Date().timeIntervalSince1970, expiresAt: 0,
            absence: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (DeliverabilityEntry) -> Void) {
        completion(DeliverabilityEntry(date: Date(), snapshot: DeliverabilitySnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DeliverabilityEntry>) -> Void) {
        let now = Date()
        let snapshot = DeliverabilitySnapshot.load(at: now)
        var entries = [DeliverabilityEntry(date: now, snapshot: snapshot)]
        var refreshAt = Calendar.current.date(byAdding: .hour, value: 1, to: now) ?? now

        if snapshot.hasData {
            // Hourly re-renders exist ONLY to age the "as of" line. Every entry
            // carries the same snapshot; the date moves and `measuredAgo(at:)`
            // is computed against it, so the widget cannot freeze on the words
            // it happened to have when the timeline was built.
            let expiresAt = Date(timeIntervalSince1970: snapshot.expiresAt)
            var mark = Date(timeIntervalSince1970: snapshot.measuredAt)
                .addingTimeInterval(3600)
            while mark < expiresAt && entries.count < 12 {
                if mark > now {
                    entries.append(DeliverabilityEntry(date: mark, snapshot: snapshot))
                }
                mark = mark.addingTimeInterval(3600)
            }
            if expiresAt > now {
                entries.append(DeliverabilityEntry(date: expiresAt, snapshot: .empty(.expired)))
                refreshAt = expiresAt
            }
        }

        completion(Timeline(entries: entries, policy: .after(refreshAt)))
    }
}

struct PostwaveDeliverabilityEntryView: View {
    @Environment(\.widgetFamily) var family
    @Environment(\.colorScheme) private var colorScheme
    var entry: DeliverabilityProvider.Entry

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                DeliverabilityAccessoryCircularView(snapshot: entry.snapshot, now: entry.date)
                    .pwAccessoryContainer()
            case .accessoryRectangular:
                DeliverabilityAccessoryRectangularView(snapshot: entry.snapshot, now: entry.date)
                    .pwAccessoryContainer()
            case .accessoryInline:
                DeliverabilityAccessoryInlineView(snapshot: entry.snapshot, now: entry.date)
                    .pwAccessoryContainer()
            case .systemMedium:
                DeliverabilityMediumView(snapshot: entry.snapshot, now: entry.date)
                    .pwWidgetBackground(Brand.paper(colorScheme))
            default:
                DeliverabilitySmallView(snapshot: entry.snapshot, now: entry.date)
                    .pwWidgetBackground(Brand.paper(colorScheme))
            }
        }
        // One destination in every state: the screen that publishes this score
        // is also the screen that explains it, and it is the only action any of
        // the empty states can ask for.
        .widgetURL(widgetDestination(deliverabilityWidgetURL))
    }
}

struct PostwaveDeliverabilityWidget: Widget {
    let kind = "PostwaveDeliverabilityWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DeliverabilityProvider()) { entry in
            PostwaveDeliverabilityEntryView(entry: entry)
        }
        .configurationDisplayName("Moosewave Sender Health (Opt-in)")
        .description("Shows your deliverability score, grade and auto-throttle state, with the time the server computed them. Requires the same widget metrics opt-in.")
        // accessoryCircular is included here and not on the store tile because
        // a 0-100 score with a one-letter grade is the one figure in this app
        // that fits a Lock Screen circle without being compacted into a shape.
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

// MARK: - Bundle

/// Three widgets rather than more metrics on the first one.
///
/// The dashboard tile answers "is anything waiting for me"; the store tile
/// answers "what has the shop done"; the sender-health tile answers "is our
/// mail still getting through". They are measured at different times by
/// different writers, and crowding an all-time currency total or a server-side
/// score onto a tile whose other numbers refresh every fifteen minutes would
/// make one timestamp stand for three different measurements. Separate widgets
/// let somebody place any of them — and each states its own age.
struct PostwaveWidget: Widget {
    let kind = "PostwaveWidget"

    var body: some WidgetConfiguration {
        // AppIntentConfiguration, not StaticConfiguration (DASHBOARD#47): the
        // person who placed the tile chooses which number it leads with, per
        // instance, from long-press → Edit Widget. See the long note beside
        // `PostwaveMetricsIntent`.
        AppIntentConfiguration(
            kind: kind,
            intent: PostwaveMetricsIntent.self,
            provider: Provider()
        ) { entry in
            PostwaveWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Moosewave Metrics (Opt-in)")
        .description("Shows short-lived workspace metrics only after explicit consent in Moosewave Settings. Long-press to choose which numbers appear.")
        // Lock Screen + StandBy accessory families are where a pending approval
        // is actually seen (NATIVE#17). All three, and the configuration intent
        // above, are covered by this target's iOS 17 deployment target.
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

@main
struct PostwaveWidgets: WidgetBundle {
    var body: some Widget {
        PostwaveWidget()
        PostwaveCommerceWidget()
        PostwaveDeliverabilityWidget()
        // The iOS 18 Control Center / Lock Screen / Action Button control
        // (NATIVE#59; declared in ScanControl.swift). It is guarded rather
        // than unconditional because this extension's floor is 17.0 — see
        // expo-target.config.js for why that number is what it is.
        //
        // A CORRECTION, because the note in expo-target.config.js would
        // otherwise say this line cannot exist. That note claims
        // "`WidgetBundleBuilder` accepts NO control flow — `if #available`
        // inside a widget bundle is a compile error". Half of it holds and
        // half does not, and the difference is what makes the guard below
        // legal:
        //
        //   - What DOES hold: a single `Widget.body` has no eraser to return
        //     two different `WidgetConfiguration` TYPES through, so ONE widget
        //     still cannot be static below a version and configurable above
        //     it. The 17.0 floor that argument produced is unchanged.
        //   - What does NOT hold today: `WidgetBundleBuilder` has
        //     `buildLimitedAvailability`, so an availability-guarded member of
        //     a BUNDLE compiles. Verified rather than assumed — this file plus
        //     ScanControl.swift typecheck against the iOS SDK at
        //     `-target arm64-apple-ios17.0` (the floor that matters), and
        //     deleting the `@available` attribute in ScanControl.swift fails
        //     with "'ControlWidgetConfiguration' is only available in iOS 18.0
        //     or newer", which is what proves the guard is load-bearing and
        //     not decoration.
        if #available(iOS 18.0, *) {
            PostwaveScanControl()
        }
    }
}
