import Foundation

public actor ProxyUsageReader {
    public static var defaultDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CLIProxyAPI/auth", isDirectory: true)
    }

    public static var defaultCache: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/Gauge/proxy-usage.json")
    }

    public static var defaultLog: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/CLIProxyAPI/service.log")
    }

    private let directory: URL
    private let cacheURL: URL?
    private let logURL: URL?
    private let transport: UsageTransport
    private let now: @Sendable () -> Date
    private var lastSnapshot: UsageSnapshot?
    private var loadedCache = false
    private var inFlight: Task<UsageSnapshot, Never>?

    public init(directory: URL? = nil, cacheURL: URL? = defaultCache, logURL: URL? = defaultLog) {
        self.directory = directory ?? Self.defaultDirectory
        self.cacheURL = cacheURL
        self.logURL = logURL
        self.transport = UsageHTTP.transport()
        self.now = { Date() }
    }

    init(directory: URL, cacheURL: URL? = nil, logURL: URL? = nil,
         transport: @escaping UsageTransport, now: @escaping @Sendable () -> Date) {
        self.directory = directory
        self.cacheURL = cacheURL
        self.logURL = logURL
        self.transport = transport
        self.now = now
    }

    public func refresh() async -> UsageSnapshot {
        if let inFlight { return await inFlight.value }
        let task = Task { await acquire() }
        inFlight = task
        let snapshot = await task.value
        inFlight = nil
        return snapshot
    }

    private func acquire() async -> UsageSnapshot {
        var cacheFailure: UsageFailure?
        if !loadedCache {
            do { lastSnapshot = try SnapshotCache.load(cacheURL) }
            catch { cacheFailure = UsageFailure(.cache) }
            loadedCache = true
        }
        let checkedAt = now()
        var traceFailure: UsageFailure?
        let proxyFailures: [String: ProxyFailure]
        do { proxyFailures = try ProxyFailureReader.read(logURL, now: checkedAt) }
        catch { proxyFailures = [:]; traceFailure = UsageFailure(.trace) }
        let previous = Dictionary(uniqueKeysWithValues: (lastSnapshot?.accounts ?? []).map { ($0.id, $0) })
        let accounts: [DiscoveredAccount]
        do { accounts = try ProxyDiscovery.accounts(in: directory) }
        catch {
            return UsageSnapshot(generatedAt: checkedAt,
                accounts: (lastSnapshot?.accounts ?? []).map {
                    AccountUsage(id: $0.id, provider: $0.provider, email: $0.email, plan: $0.plan,
                                 state: .unavailable, windows: $0.windows, checkedAt: checkedAt,
                                 lastSucceededAt: $0.lastSucceededAt, failure: UsageFailure(.discovery),
                                 recentProxyFailure: proxyFailures[$0.id])
                }, discoveryFailure: UsageFailure(.discovery), cacheFailure: cacheFailure, traceFailure: traceFailure)
        }
        let fetch = transport
        let rows = await withTaskGroup(of: AccountUsage.self, returning: [AccountUsage].self) { group in
            var iterator = accounts.makeIterator()
            func enqueue(_ account: DiscoveredAccount) {
                group.addTask {
                    await Self.read(account, previous: previous[account.id], proxyFailure: proxyFailures[account.id],
                                    checkedAt: checkedAt, transport: fetch)
                }
            }
            for _ in 0..<4 { if let account = iterator.next() { enqueue(account) } }
            var rows: [AccountUsage] = []
            while let row = await group.next() {
                rows.append(row)
                if let account = iterator.next() { enqueue(account) }
            }
            return rows.sorted { ($0.provider, $0.email, $0.id) < ($1.provider, $1.email, $1.id) }
        }
        var snapshot = UsageSnapshot(generatedAt: now(), accounts: rows, cacheFailure: cacheFailure, traceFailure: traceFailure)
        do { try SnapshotCache.write(snapshot, to: cacheURL) }
        catch { snapshot = UsageSnapshot(generatedAt: snapshot.generatedAt, accounts: rows,
                                        cacheFailure: UsageFailure(.cache), traceFailure: traceFailure) }
        lastSnapshot = snapshot
        return snapshot
    }

    private static func read(_ account: DiscoveredAccount, previous: AccountUsage?, proxyFailure: ProxyFailure?,
                             checkedAt: Date, transport: UsageTransport) async -> AccountUsage {
        func row(_ state: AccountState, reading: ProviderReading? = nil, failure: UsageFailure? = nil) -> AccountUsage {
            let cached = state == .unavailable ? previous : nil
            return AccountUsage(id: account.id, provider: account.provider, email: account.email,
                plan: reading?.plan ?? cached?.plan, state: state,
                windows: reading?.windows ?? cached?.windows ?? [], checkedAt: checkedAt,
                lastSucceededAt: reading != nil ? checkedAt : cached?.lastSucceededAt,
                failure: failure, recentProxyFailure: proxyFailure)
        }
        guard let credential = account.credential else { return row(.unavailable, failure: UsageFailure(.unreadableCredentials)) }
        if credential.disabled == true { return row(.disabled) }
        guard ["claude", "codex"].contains(account.provider) else {
            return row(.unsupported, failure: UsageFailure(.unsupportedProvider))
        }
        guard let token = credential.access_token else { return row(.unavailable, failure: UsageFailure(.missingCredentials)) }
        do {
            try Task.checkCancellation()
            let address = account.provider == "claude"
                ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage"
            let request = try UsageHTTP.request(address, token: token, provider: account.provider, accountID: credential.account_id)
            let data = try UsageHTTP.validated(await transport(request))
            let reading = try account.provider == "claude" ? ProviderReadings.claude(data) : ProviderReadings.codex(data)
            return row(reading.limited ? .limited : .ready, reading: reading)
        } catch let error as AcquisitionError {
            return row(.unavailable, failure: error.failure)
        } catch {
            return row(.unavailable, failure: UsageFailure(.network))
        }
    }
}
