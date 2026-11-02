import Foundation
import GaugeCore
import Darwin

@main
struct GaugeUsageCLI {
    static func main() async {
        var directory: URL?
        var cache: URL? = ProxyUsageReader.defaultCache
        var log: URL? = ProxyUsageReader.defaultLog
        var arguments = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = arguments.next() {
            switch argument {
            case "--auth-dir", "--cache-file", "--proxy-log":
                guard let value = arguments.next(), !value.hasPrefix("--") else { exit(2) }
                let url = URL(fileURLWithPath: (value as NSString).expandingTildeInPath)
                switch argument {
                case "--auth-dir": directory = url
                case "--cache-file": cache = url
                default: log = url
                }
            case "--no-cache": cache = nil
            case "--no-proxy-log": log = nil
            case "--help":
                print("gauge-proxy-usage [--auth-dir PATH] [--cache-file PATH | --no-cache] [--proxy-log PATH | --no-proxy-log]")
                print("Provider checks share a persisted schedule for each auth directory. --no-cache skips only the output cache; it never bypasses shared scheduling or cooldowns.")
                return
            default: exit(2)
            }
        }
        let reader = ProxyUsageReader(directory: directory, cacheURL: cache, logURL: log)
        let snapshot = await reader.refresh()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try FileHandle.standardOutput.write(contentsOf: encoder.encode(snapshot))
            try FileHandle.standardOutput.write(contentsOf: Data([10]))
        } catch { exit(1) }
        if snapshot.discoveryFailure != nil || !snapshot.accounts.contains(where: { $0.state == .ready || $0.state == .limited }) { exit(1) }
    }
}
