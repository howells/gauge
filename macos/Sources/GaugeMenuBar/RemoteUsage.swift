import Foundation
import GaugeCore

enum RemoteUsage {
    enum Failure: Error {
        case invalidHost, connection, invalidSnapshot

        var message: String {
            switch self {
            case .invalidHost: "Enter an SSH host name, such as studio-m5."
            case .connection: "Couldn't connect. Check SSH access and that Gauge's collector is installed on the proxy Mac."
            case .invalidSnapshot: "The proxy Mac didn't return a valid allowance reading."
            }
        }
    }

    static func valid(host: String) -> Bool {
        !host.isEmpty && host.count <= 253 && !host.hasPrefix("-")
            && host.utf8.allSatisfy {
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
                    || [45, 46, 64, 95].contains($0)
            }
    }

    // Process pipes block, so this operation must not occupy the UI actor.
    @concurrent static func read(host: String) async throws -> UsageSnapshot {
        guard valid(host: host) else { throw Failure.invalidHost }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = [
            "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
            "-o", "ConnectTimeout=8", "-o", "ConnectionAttempts=1",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
            host, "exec \"$HOME/Library/Application Support/Gauge/bin/gauge-proxy-usage\""
        ]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() }
        catch { throw Failure.connection }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard !data.isEmpty else { throw Failure.connection }
        guard data.count <= 1_000_000 else { throw Failure.invalidSnapshot }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let snapshot = try? decoder.decode(UsageSnapshot.self, from: data),
              snapshot.schemaVersion == 1,
              Set(snapshot.accounts.map(\.id)).count == snapshot.accounts.count else {
            throw Failure.invalidSnapshot
        }
        // The collector can exit 1 with a valid snapshot when every check failed.
        return snapshot
    }
}
