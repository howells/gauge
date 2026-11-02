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
    private let store: CollectionStore
    private let transport: UsageTransport
    private let now: @Sendable () -> Date
    private var lastSnapshot: UsageSnapshot?
    private var inFlight: Task<UsageSnapshot, Never>?

    public init(directory: URL? = nil, cacheURL: URL? = defaultCache, logURL: URL? = defaultLog) {
        let directory = directory ?? Self.defaultDirectory
        self.directory = directory
        self.cacheURL = cacheURL
        self.logURL = logURL
        self.store = CollectionStore(url: CollectionStore.defaultURL(for: directory))
        self.transport = UsageHTTP.transport()
        self.now = { Date() }
    }

    init(directory: URL, cacheURL: URL? = nil, logURL: URL? = nil, stateURL: URL,
         transport: @escaping UsageTransport, now: @escaping @Sendable () -> Date) {
        self.directory = directory
        self.cacheURL = cacheURL
        self.logURL = logURL
        self.store = CollectionStore(url: stateURL)
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
        do { if let cached = try SnapshotCache.load(cacheURL) { lastSnapshot = cached } }
        catch { cacheFailure = UsageFailure(.cache) }
        var state: CollectionState
        let lease: CollectionLease?
        do {
            lease = try store.lock()
            state = try store.load() ?? CollectionState(snapshot: lastSnapshot)
        } catch { return blockedSnapshot(cacheFailure: cacheFailure) }
        // Retain the process lease until responses and scheduling state are saved.
        defer { withExtendedLifetime(lease) {} }
        if let saved = state.snapshot { lastSnapshot = saved }
        let generatedAt = now()
        var traceFailure: UsageFailure?
        let proxyFailures: [String: ProxyFailure]
        do { proxyFailures = try ProxyFailureReader.read(logURL, now: generatedAt) }
        catch { proxyFailures = [:]; traceFailure = UsageFailure(.trace) }
        let previous = Dictionary(uniqueKeysWithValues: (lastSnapshot?.accounts ?? []).map { ($0.id, $0) })
        let accounts: [DiscoveredAccount]
        do { accounts = try ProxyDiscovery.accounts(in: directory) }
        catch {
            return UsageSnapshot(generatedAt: generatedAt, accounts: previous.values.map {
                Self.saved($0, failure: UsageFailure(.discovery), next: $0.nextCheckAt)
            }.sorted(by: Self.ordered), discoveryFailure: UsageFailure(.discovery),
                cacheFailure: cacheFailure, traceFailure: traceFailure)
        }
        var rows: [String: AccountUsage] = [:]
        for account in accounts {
            rows[account.id] = Self.cached(account, previous: previous[account.id], proxyFailure: proxyFailures[account.id],
                                          schedule: state.providers[account.provider], busy: lease == nil)
        }
        if lease == nil {
            return UsageSnapshot(generatedAt: generatedAt, accounts: rows.values.sorted(by: Self.ordered),
                                 cacheFailure: cacheFailure, traceFailure: traceFailure)
        }
        // Reserve before HTTP. A crashed process retains a conservative deadline;
        // completing without a 429 reduces this to the ten-minute minimum.
        let due = ["claude", "codex"].filter { provider in
            accounts.contains { $0.provider == provider && Self.canRead($0) }
                && (state.providers[provider]?.nextCheckAt ?? .distantPast) <= generatedAt
        }
        for provider in due {
            var schedule = state.providers[provider] ?? ProviderSchedule(nextCheckAt: generatedAt)
            schedule.nextCheckAt = ProviderSchedule.deadline(after: schedule.cooldown, from: generatedAt)
            state.providers[provider] = schedule
        }
        state.snapshot = UsageSnapshot(generatedAt: generatedAt, accounts: rows.values.sorted(by: Self.ordered))
        do { try store.write(state) }
        catch { return blockedSnapshot(rows: Array(rows.values), cacheFailure: cacheFailure) }

        for provider in due {
            var schedule = state.providers[provider]!
            var limited = false
            var attempted: Set<String> = []
            for account in accounts where account.provider == provider && Self.canRead(account) {
                let result = await Self.read(account, previous: previous[account.id], proxyFailure: proxyFailures[account.id],
                                             transport: transport, now: now)
                rows[account.id] = result.row
                attempted.insert(account.id)
                if result.row.failure?.code == .rateLimited {
                    schedule.rateLimited(at: now(), retryAfter: result.retryAfter)
                    limited = true
                }
                state.providers[provider] = schedule
                state.snapshot = UsageSnapshot(generatedAt: now(), accounts: rows.values.sorted(by: Self.ordered))
                do { try store.write(state) }
                catch { return blockedSnapshot(rows: Array(rows.values), cacheFailure: cacheFailure) }
                if limited { break }
            }
            if !limited {
                schedule.nextCheckAt = ProviderSchedule.deadline(after: ProviderSchedule.minimumInterval, from: now())
                schedule.paused = false
                schedule.consecutiveRateLimits = 0
            }
            state.providers[provider] = schedule
            for account in accounts where account.provider == provider && Self.canRead(account) {
                let row = rows[account.id]!
                if !attempted.contains(account.id) && limited {
                    rows[account.id] = Self.cached(account, previous: previous[account.id], proxyFailure: proxyFailures[account.id],
                                                  schedule: schedule, busy: false)
                } else {
                    rows[account.id] = Self.saved(row, next: schedule.nextCheckAt,
                                                 status: limited ? .paused : nil)
                }
            }
            state.snapshot = UsageSnapshot(generatedAt: now(), accounts: rows.values.sorted(by: Self.ordered))
            do { try store.write(state) }
            catch { return blockedSnapshot(rows: Array(rows.values), cacheFailure: cacheFailure) }
        }
        var snapshot = UsageSnapshot(generatedAt: now(), accounts: rows.values.sorted(by: Self.ordered),
                                     cacheFailure: cacheFailure, traceFailure: traceFailure)
        state.snapshot = snapshot
        do { try store.write(state) }
        catch { return blockedSnapshot(rows: Array(rows.values), cacheFailure: cacheFailure) }
        do { try SnapshotCache.write(snapshot, to: cacheURL) }
        catch { snapshot = UsageSnapshot(generatedAt: snapshot.generatedAt, accounts: snapshot.accounts,
                                        cacheFailure: UsageFailure(.cache), traceFailure: traceFailure) }
        lastSnapshot = snapshot
        return snapshot
    }

    private func blockedSnapshot(rows: [AccountUsage]? = nil, cacheFailure: UsageFailure?) -> UsageSnapshot {
        UsageSnapshot(generatedAt: now(), accounts: (rows ?? lastSnapshot?.accounts ?? []).map {
            Self.saved($0, failure: $0.failure ?? UsageFailure(.scheduling), next: $0.nextCheckAt)
        }.sorted(by: Self.ordered), cacheFailure: cacheFailure, schedulingFailure: UsageFailure(.scheduling))
    }

    private static func ordered(_ lhs: AccountUsage, _ rhs: AccountUsage) -> Bool {
        (lhs.provider, lhs.email, lhs.id) < (rhs.provider, rhs.email, rhs.id)
    }

    private static func canRead(_ account: DiscoveredAccount) -> Bool {
        guard ["claude", "codex"].contains(account.provider), account.credential?.disabled != true,
              let token = account.credential?.access_token else { return false }
        return !token.isEmpty && !token.contains(where: { $0.isNewline || $0.asciiValue == 0 })
    }

    private static func saved(_ row: AccountUsage, failure: UsageFailure? = nil, next: Date?, status: CheckStatus? = .cached) -> AccountUsage {
        AccountUsage(id: row.id, provider: row.provider, email: row.email, plan: row.plan,
                     state: failure == nil ? row.state : .unavailable, windows: row.windows, checkedAt: row.checkedAt,
                     lastSucceededAt: row.lastSucceededAt, failure: failure ?? row.failure,
                     recentProxyFailure: row.recentProxyFailure, nextCheckAt: next, checkStatus: status)
    }

    private static func cached(_ account: DiscoveredAccount, previous: AccountUsage?, proxyFailure: ProxyFailure?,
                               schedule: ProviderSchedule?, busy: Bool) -> AccountUsage {
        var failure: UsageFailure?
        var state: AccountState = .unavailable
        if account.credential == nil { failure = UsageFailure(.unreadableCredentials) }
        else if account.credential?.disabled == true { state = .disabled }
        else if !["claude", "codex"].contains(account.provider) { state = .unsupported; failure = UsageFailure(.unsupportedProvider) }
        else if !canRead(account) { failure = UsageFailure(.missingCredentials) }
        else {
            failure = previous?.failure
            state = previous?.state ?? .unavailable
            if schedule?.paused == true, failure?.code != .rateLimited {
                failure = UsageFailure(.providerPaused)
                state = .unavailable
            } else if previous == nil { failure = UsageFailure(busy ? .collectionInProgress : .notReported) }
        }
        let readable = canRead(account)
        return AccountUsage(id: account.id, provider: account.provider, email: account.email,
                            plan: previous?.plan, state: state, windows: previous?.windows ?? [],
                            checkedAt: previous?.checkedAt, lastSucceededAt: previous?.lastSucceededAt,
                            failure: failure, recentProxyFailure: proxyFailure,
                            nextCheckAt: readable ? schedule?.nextCheckAt : nil,
                            checkStatus: readable ? (busy ? .inProgress : schedule?.paused == true ? .paused : .cached) : nil)
    }

    private static func read(_ account: DiscoveredAccount, previous: AccountUsage?, proxyFailure: ProxyFailure?,
                             transport: UsageTransport, now: @Sendable () -> Date) async -> (row: AccountUsage, retryAfter: String?) {
        var attemptedAt: Date?
        var retryAfter: String?
        do {
            try Task.checkCancellation()
            let address = account.provider == "claude"
                ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage"
            let request = try UsageHTTP.request(address, token: account.credential?.access_token ?? "",
                                                provider: account.provider, accountID: account.credential?.account_id)
            attemptedAt = now()
            let response = try await transport(request)
            retryAfter = response.retryAfter
            let data = try UsageHTTP.validated(response)
            let reading = try account.provider == "claude" ? ProviderReadings.claude(data) : ProviderReadings.codex(data)
            return (AccountUsage(id: account.id, provider: account.provider, email: account.email, plan: reading.plan,
                                 state: reading.limited ? .limited : .ready, windows: reading.windows,
                                 checkedAt: attemptedAt, lastSucceededAt: now(), recentProxyFailure: proxyFailure), nil)
        } catch {
            let failure = (error as? AcquisitionError)?.failure ?? UsageFailure(.network)
            return (AccountUsage(id: account.id, provider: account.provider, email: account.email, plan: previous?.plan,
                                 state: .unavailable, windows: previous?.windows ?? [], checkedAt: attemptedAt ?? previous?.checkedAt,
                                 lastSucceededAt: previous?.lastSucceededAt, failure: failure, recentProxyFailure: proxyFailure), retryAfter)
        }
    }
}
