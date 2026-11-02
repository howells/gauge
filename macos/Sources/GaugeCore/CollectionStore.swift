import CryptoKit
import Darwin
import Foundation

struct ProviderSchedule: Codable, Sendable {
    static let minimumInterval: TimeInterval = 600
    static let initialCooldown: TimeInterval = 1_800

    var nextCheckAt: Date
    var consecutiveRateLimits = 0
    var paused = false

    var cooldown: TimeInterval {
        Self.initialCooldown * pow(2, Double(min(consecutiveRateLimits, 5)))
    }

    static func deadline(after interval: TimeInterval, from date: Date) -> Date {
        // ISO-8601 cache dates have whole-second precision. Round up so encoding
        // cannot shorten a minimum interval or a Retry-After delay.
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 + interval).rounded(.up))
    }

    mutating func rateLimited(at date: Date, retryAfter: String?) {
        let delay = cooldown
        consecutiveRateLimits = min(consecutiveRateLimits + 1, 6)
        paused = true
        let retry = Self.retryDate(retryAfter, now: date) ?? date
        nextCheckAt = max(Self.deadline(after: delay, from: date), Self.deadline(after: 0, from: retry))
    }

    static func retryDate(_ value: String?, now: Date) -> Date? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let seconds = Double(trimmed), seconds.isFinite, seconds >= 0 {
            return now.addingTimeInterval(seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: trimmed)
    }
}

struct CollectionState: Codable, Sendable {
    var schemaVersion = 1
    var providers: [String: ProviderSchedule] = [:]
    var snapshot: UsageSnapshot?

    init(snapshot: UsageSnapshot? = nil) {
        self.snapshot = snapshot
        for provider in ["claude", "codex"] {
            let rows = snapshot?.accounts.filter { $0.provider == provider } ?? []
            guard let checked = rows.compactMap(\.checkedAt).max() else { continue }
            let limited = rows.contains { $0.failure?.code == .rateLimited }
            providers[provider] = ProviderSchedule(
                nextCheckAt: ProviderSchedule.deadline(after: limited ? ProviderSchedule.initialCooldown : ProviderSchedule.minimumInterval, from: checked),
                consecutiveRateLimits: limited ? 1 : 0, paused: limited)
        }
    }
}

struct CollectionStore: Sendable {
    let url: URL

    // Scheduling is tied to the inventory, never the caller's output cache.
    static func defaultURL(for directory: URL) -> URL {
        let path = directory.resolvingSymlinksInPath().standardizedFileURL.path
        let digest = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        return ProxyUsageReader.defaultCache.deletingLastPathComponent()
            .appendingPathComponent("collection-\(digest).json")
    }

    func load() throws -> CollectionState? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= 2_000_000 else { throw AcquisitionError(.scheduling) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let state = try decoder.decode(CollectionState.self, from: data)
        guard state.schemaVersion == 1,
              state.providers.keys.allSatisfy({ ["claude", "codex"].contains($0) }),
              state.providers.values.allSatisfy({ (0...6).contains($0.consecutiveRateLimits) }),
              state.snapshot.map({ $0.schemaVersion == 1 && Set($0.accounts.map(\.id)).count == $0.accounts.count }) ?? true
        else { throw AcquisitionError(.scheduling) }
        return state
    }

    func write(_ state: CollectionState) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(state)
        guard data.count <= 2_000_000 else { throw AcquisitionError(.scheduling) }
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    func lock() throws -> CollectionLease? {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let descriptor = open(url.appendingPathExtension("lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw AcquisitionError(.scheduling) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let busy = errno == EWOULDBLOCK
            close(descriptor)
            if busy { return nil }
            throw AcquisitionError(.scheduling)
        }
        return CollectionLease(descriptor: descriptor)
    }
}

// A nonblocking descriptor-owned process lease, independent of Swift threads.
// Closing, including on a crash, releases it without waiting on an executor.
final class CollectionLease {
    let descriptor: Int32
    init(descriptor: Int32) { self.descriptor = descriptor }
    deinit { close(descriptor) }
}
