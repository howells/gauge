import Foundation

public enum SnapshotCache {
    public static func load(_ url: URL?) throws -> UsageSnapshot? {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= 1_000_000 else { throw AcquisitionError(.cache) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(UsageSnapshot.self, from: data)
        guard snapshot.schemaVersion == 1, Set(snapshot.accounts.map(\.id)).count == snapshot.accounts.count else {
            throw AcquisitionError(.cache)
        }
        return snapshot
    }

    public static func write(_ snapshot: UsageSnapshot, to url: URL?) throws {
        guard let url else { return }
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(snapshot).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
