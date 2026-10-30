// Moosewave share extension.
//
// Only two payloads have a real mobile action and are eligible for the App
// Group hand-off: a canonical Moosewave entity link or one bare email address.
// Arbitrary text, generic URLs, compose notes, URL query strings, fragments,
// and legacy queue records are never retained. The extension and main app
// independently enforce the same 15-minute TTL and byte/count budgets.

import UIKit
import Social
import UniformTypeIdentifiers

private let appGroup = "group.com.moosewave.app"
private let sharedKey = "pw_shared_items_v2"
private let legacySharedKey = "pw_shared_items"
private let maxSharedItemAge: TimeInterval = 15 * 60
private let maxFutureClockSkew: TimeInterval = 0
private let maxSharedItemBytes = 2 * 1024
private let maxQueueBytes = 12 * 1024
private let maxQueueCount = 8
// Mirrors packages/route-map/src/entities.ts, filtered to entities whose
// `surfaces.mobile` is not "none" — this extension queues a URL for the app to
// open, so accepting an entity the app has no screen for would consume the
// user's share and then strand them. `affiliate` and `sequence-template` are
// excluded for exactly that reason.
// apps/mobile/src/lib/nativePrivacyContracts.test.ts fails if these drift.
private let allowedEntityActions: Set<String> = [
    "approval", "subscriber", "campaign", "sequence",
    "form", "list", "segment", "helpdesk-conversation",
    "template", "migration", "discount", "integration",
    "flow", "inbound-webhook", "landing-page",
    // Mobile ships app/(tabs)/suppressions/[email].tsx, so a shared
    // moosewave://suppression/<email> link opens a real screen. It is also
    // reachable from global search, which is what added it to the registry.
    "suppression"
]
private let allowedEntitySlugs: Set<String> = [
    "approvals", "subscribers", "campaigns", "sequences",
    "forms", "lists", "segments", "helpdesk",
    "templates", "migrations", "discounts", "integrations",
    "flows", "inbound-webhooks", "landing-pages",
    "suppressions"
]

private struct SharedEntry: Codable, Equatable {
    let kind: String
    let value: String
    let createdAt: TimeInterval
}

private func utf8Count(_ value: String) -> Int {
    value.lengthOfBytes(using: .utf8)
}

private func isSafeResourceID(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= 128 else { return false }
    return value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
}

private func isCanonicalUUID(_ value: String) -> Bool {
    return value.range(
        of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        options: .regularExpression
    ) != nil
}

private func isEntityID(action: String, identifier: String) -> Bool {
    guard isSafeResourceID(identifier) else { return false }
    return action != "helpdesk-conversation" || isCanonicalUUID(identifier)
}

private func canonicalEntityLink(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, utf8Count(trimmed) <= maxSharedItemBytes,
          var components = URLComponents(string: trimmed) else {
        return nil
    }
    components.query = nil
    components.fragment = nil

    if components.scheme == "postwave",
       let action = components.host,
       allowedEntityActions.contains(action) {
        let parts = components.path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].isEmpty else { return nil }
        let identifier = String(parts[1])
        guard isEntityID(action: action, identifier: identifier) else { return nil }
        return "moosewave://\(action)/\(identifier)"
    }

    if components.scheme == "https",
       components.host == "app.moosewave.com",
       components.port == nil,
       components.user == nil,
       components.password == nil {
        let parts = components.path.split(separator: "/").map(String.init)
        guard parts.count == 3, parts[0] == "app",
              allowedEntitySlugs.contains(parts[1]),
              isSafeResourceID(parts[2]),
              parts[1] != "helpdesk" || isCanonicalUUID(parts[2]) else {
            return nil
        }
        return "https://app.moosewave.com/app/\(parts[1])/\(parts[2])"
    }
    return nil
}

private func canonicalEmail(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, utf8Count(trimmed) <= 320,
          trimmed.range(
            of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
            options: .regularExpression
          ) != nil else {
        return nil
    }
    return trimmed
}

private func encodedItemFits(_ entry: SharedEntry) -> Bool {
    guard let data = try? JSONEncoder().encode(entry) else { return false }
    return data.count <= maxSharedItemBytes
}

private func newSharedEntry(from raw: String, now: TimeInterval) -> SharedEntry? {
    let createdAt = floor(now)
    let entry: SharedEntry
    if let entity = canonicalEntityLink(raw) {
        entry = SharedEntry(kind: "entity", value: entity, createdAt: createdAt)
    } else if let email = canonicalEmail(raw) {
        entry = SharedEntry(kind: "email", value: email, createdAt: createdAt)
    } else {
        return nil
    }
    return encodedItemFits(entry) ? entry : nil
}

private func validatedSharedEntry(
    _ entry: SharedEntry,
    now: TimeInterval
) -> SharedEntry? {
    let age = now - entry.createdAt
    guard entry.createdAt > 0,
          age >= -maxFutureClockSkew,
          age <= maxSharedItemAge else {
        return nil
    }

    let value: String?
    switch entry.kind {
    case "entity": value = canonicalEntityLink(entry.value)
    case "email": value = canonicalEmail(entry.value)
    default: value = nil
    }
    guard let canonicalValue = value else { return nil }
    let canonical = SharedEntry(
        kind: entry.kind,
        value: canonicalValue,
        createdAt: floor(entry.createdAt)
    )
    return encodedItemFits(canonical) ? canonical : nil
}

private func encodedBoundedQueue(_ entries: [SharedEntry]) -> Data? {
    var queue = Array(entries.suffix(maxQueueCount))
    while !queue.isEmpty {
        guard let data = try? JSONEncoder().encode(queue) else { return nil }
        if data.count <= maxQueueBytes { return data }
        queue.removeFirst()
    }
    return try? JSONEncoder().encode([SharedEntry]())
}

@discardableResult
private func persistQueue(_ entries: [SharedEntry], defaults: UserDefaults) -> Bool {
    guard !entries.isEmpty else {
        defaults.removeObject(forKey: sharedKey)
        return defaults.object(forKey: sharedKey) == nil
    }
    guard let data = encodedBoundedQueue(entries),
          data.count <= maxQueueBytes,
          let json = String(data: data, encoding: .utf8) else {
        defaults.removeObject(forKey: sharedKey)
        return false
    }
    defaults.set(json, forKey: sharedKey)
    return defaults.string(forKey: sharedKey) == json
}

private func loadAndPruneQueue(
    defaults: UserDefaults,
    now: TimeInterval
) -> [SharedEntry] {
    // Do not migrate the v1 schema: it may contain arbitrary text and notes.
    defaults.removeObject(forKey: legacySharedKey)
    guard let raw = defaults.string(forKey: sharedKey),
          let data = raw.data(using: .utf8),
          data.count <= maxQueueBytes,
          let decoded = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else {
        defaults.removeObject(forKey: sharedKey)
        return []
    }
    let queue = decoded.suffix(maxQueueCount).compactMap { rawEntry -> SharedEntry? in
        guard JSONSerialization.isValidJSONObject(rawEntry),
              let itemData = try? JSONSerialization.data(withJSONObject: rawEntry),
              itemData.count <= maxSharedItemBytes,
              let entry = try? JSONDecoder().decode(SharedEntry.self, from: itemData) else {
            return nil
        }
        return validatedSharedEntry(entry, now: now)
    }
    _ = persistQueue(queue, defaults: defaults)
    return queue
}

final class ShareViewController: SLComposeServiceViewController {
    private var sharedEntry: SharedEntry?

    override func presentationAnimationDidFinish() {
        placeholder = "Moosewave saves only a shared entity link or email. Notes are not retained."
        title = "Moosewave"

        if let defaults = UserDefaults(suiteName: appGroup) {
            _ = loadAndPruneQueue(
                defaults: defaults,
                now: Date().timeIntervalSince1970
            )
        }

        guard let item = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = item.attachments else {
            return
        }

        // The activation rule caps URLs/web pages at one. Limit attachment
        // inspection as defence in depth against a malformed host request.
        for provider in attachments.prefix(3) {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                provider.loadItem(
                    forTypeIdentifier: UTType.url.identifier,
                    options: nil
                ) { [weak self] data, _ in
                    let raw = (data as? URL)?.absoluteString ?? (data as? String)
                    if let raw { self?.consider(raw) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                provider.loadItem(
                    forTypeIdentifier: UTType.plainText.identifier,
                    options: nil
                ) { [weak self] data, _ in
                    if let raw = data as? String { self?.consider(raw) }
                }
            }
        }
    }

    private func consider(_ raw: String) {
        guard let candidate = newSharedEntry(
            from: raw,
            now: Date().timeIntervalSince1970
        ) else {
            return
        }
        DispatchQueue.main.async { [weak self] in
            // Prefer a product entity link over an email if a host supplies
            // both representations for the same shared item.
            if self?.sharedEntry == nil || candidate.kind == "entity" {
                self?.sharedEntry = candidate
                self?.validateContent()
            }
        }
    }

    override func isContentValid() -> Bool {
        // contentText is intentionally ignored: the compose field is not a
        // durable notes feature and arbitrary prose must never reach App Group.
        return sharedEntry != nil
    }

    override func didSelectPost() {
        guard let entry = sharedEntry,
              let defaults = UserDefaults(suiteName: appGroup) else {
            extensionContext?.cancelRequest(
                withError: NSError(
                    domain: "com.moosewave.share",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No supported Moosewave link or email was found."]
                )
            )
            return
        }

        let now = Date().timeIntervalSince1970
        var queue = loadAndPruneQueue(defaults: defaults, now: now)
        if let validated = validatedSharedEntry(entry, now: now) {
            queue.append(validated)
        }
        guard persistQueue(queue, defaults: defaults) else {
            extensionContext?.cancelRequest(
                withError: NSError(
                    domain: "com.moosewave.share",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Moosewave could not securely queue this item."]
                )
            )
            return
        }
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    override func configurationItems() -> [Any]! {
        return []
    }
}
