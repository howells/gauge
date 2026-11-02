import AppKit
import Foundation
import GaugeCore
import Observation

@Observable @MainActor
final class GaugeModel {
    var snapshot: UsageSnapshot?
    var isRefreshing = false
    var connectionFailure: String?
    var cacheFailed = false
    private(set) var host: String
    private var lastAttempt: Date?
    @ObservationIgnored private let reader = ProxyUsageReader()
    @ObservationIgnored private var refreshLoop: Task<Void, Never>?
    @ObservationIgnored private var wakeObserver: NSObjectProtocol?

    init() {
        let local = FileManager.default.fileExists(atPath: ProxyUsageReader.defaultDirectory.path)
        host = UserDefaults.standard.string(forKey: "proxyHost")
            ?? (Bundle.main.object(forInfoDictionaryKey: "GaugeDefaultProxyHost") as? String)
            ?? (local ? "" : "studio-m5.rattlesnake-boa.ts.net")
        do { snapshot = try SnapshotCache.load(cacheURL) }
        catch { cacheFailed = true }
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                do { try await Task.sleep(for: .seconds(60)) }
                catch { return }
            }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    var sourceName: String { host.isEmpty ? "This Mac" : host }

    private var cacheURL: URL {
        if host.isEmpty { return ProxyUsageReader.defaultCache }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Caches/Gauge/remote-\(host).json")
    }

    func configure(host: String) async {
        guard !isRefreshing else { return }
        self.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(self.host, forKey: "proxyHost")
        snapshot = nil
        connectionFailure = nil
        cacheFailed = false
        do { snapshot = try SnapshotCache.load(cacheURL) }
        catch { cacheFailed = true }
        await refresh()
    }

    func refreshIfNeeded() async {
        if lastAttempt == nil || Date().timeIntervalSince(lastAttempt ?? .distantPast) > 30 {
            await refresh()
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        lastAttempt = Date()
        defer { isRefreshing = false }
        do {
            if host.isEmpty {
                snapshot = await reader.refresh()
                cacheFailed = false
            } else {
                let reading = try await RemoteUsage.read(host: host)
                snapshot = reading
                do { try SnapshotCache.write(reading, to: cacheURL); cacheFailed = false }
                catch { cacheFailed = true }
            }
            connectionFailure = nil
        } catch let error as RemoteUsage.Failure {
            connectionFailure = error.message
        } catch {
            connectionFailure = "Couldn't read the proxy's allowance."
        }
    }

    func isCurrent(_ account: AccountUsage, at now: Date) -> Bool {
        guard connectionFailure == nil, account.state != .unavailable,
              let success = account.lastSucceededAt,
              now.timeIntervalSince(success) <= 300 else { return false }
        return !account.windows.contains { window in
            guard window.scope == nil, let reset = window.resetsAt else { return false }
            return reset > success && reset <= now
        }
    }
}
