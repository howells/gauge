import Foundation
import Testing
@testable import GaugeCore

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date
    init(_ date: Date = Date(timeIntervalSince1970: 1_793_612_000)) { value = date }
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

private struct CollectionFixture {
    let root: URL
    var auth: URL { root.appendingPathComponent("auth") }
    var state: URL { root.appendingPathComponent("saved/collection.json") }
    var cache: URL { root.appendingPathComponent("saved/output.json") }

    init(claude: Int = 1, codex: Int = 0) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: auth, withIntermediateDirectories: true)
        for (provider, count) in [("claude", claude), ("codex", codex)] {
            for index in 0..<count {
                let data = Data("{\"type\":\"\(provider)\",\"email\":\"\(index)@example.test\",\"access_token\":\"fixture\"}".utf8)
                try data.write(to: auth.appendingPathComponent("\(provider)-\(index).json"))
            }
        }
    }

    func reader(_ clock: TestClock, cache: URL? = nil, bootstrapCache: URL? = nil, transport: @escaping UsageTransport) -> ProxyUsageReader {
        ProxyUsageReader(directory: auth, cacheURL: cache, stateURL: state, bootstrapCacheURL: bootstrapCache,
                         transport: transport, now: { clock.now() })
    }

    func remove() { try? FileManager.default.removeItem(at: root) }
}

private actor CountingTransport {
    private(set) var claudeRequests = 0
    private(set) var codexRequests = 0
    var claudeResponse: UsageHTTPResponse?

    func setClaude(_ response: UsageHTTPResponse?) { claudeResponse = response }

    func send(_ request: URLRequest) -> UsageHTTPResponse {
        if request.url?.host == "api.anthropic.com" {
            claudeRequests += 1
            return claudeResponse ?? UsageHTTPResponse(status: 200, data: Data(#"{"seven_day":{"utilization":42}}"#.utf8))
        }
        codexRequests += 1
        return UsageHTTPResponse(status: 200, data: Data(#"{"plan_type":"pro","rate_limit":{"allowed":true,"primary_window":{"used_percent":21,"limit_window_seconds":604800}}}"#.utf8))
    }
}

@Test func repeatedReloadsAndRestartsShareOneTenMinuteProviderBatch() async throws {
    let fixture = try CollectionFixture(claude: 5, codex: 3)
    defer { fixture.remove() }
    let clock = TestClock(Date(timeIntervalSince1970: 1_793_612_000.25))
    let transport = CountingTransport()
    let reader = fixture.reader(clock) { await transport.send($0) }
    let first = await reader.refresh()
    #expect(first.accounts.count == 8)
    #expect(await transport.claudeRequests == 5)
    #expect(await transport.codexRequests == 3)
    for _ in 0..<9 {
        clock.advance(60)
        let snapshot = await reader.refresh()
        #expect(snapshot.accounts.allSatisfy { $0.checkedAt == first.accounts[0].checkedAt.map { Date(timeIntervalSince1970: floor($0.timeIntervalSince1970)) } })
        #expect(snapshot.accounts.allSatisfy { $0.checkStatus == .cached })
    }
    clock.advance(60)
    let restarted = fixture.reader(clock, cache: fixture.cache) { await transport.send($0) }
    _ = await restarted.refresh()
    #expect(await transport.claudeRequests == 5)
    #expect(await transport.codexRequests == 3)
    clock.advance(1)
    _ = await restarted.refresh()
    #expect(await transport.claudeRequests == 10)
    #expect(await transport.codexRequests == 6)
}

@Test func first429StopsOnlyItsProviderAndCooldownSurvivesReloadAndRestart() async throws {
    let fixture = try CollectionFixture(claude: 5, codex: 3)
    defer { fixture.remove() }
    let clock = TestClock()
    let transport = CountingTransport()
    let reader = fixture.reader(clock) { await transport.send($0) }
    let good = await reader.refresh()
    clock.advance(600)
    await transport.setClaude(UsageHTTPResponse(status: 429, data: Data("private body".utf8), retryAfter: "7200"))
    let failedAt = clock.now()
    let failed = await reader.refresh()
    let claude = failed.accounts.filter { $0.provider == "claude" }
    #expect(await transport.claudeRequests == 6)
    #expect(await transport.codexRequests == 6)
    #expect(claude.filter { $0.failure?.code == .rateLimited && $0.failure?.httpStatus == 429 }.count == 1)
    #expect(claude.filter { $0.failure?.code == .providerPaused && $0.failure?.httpStatus == nil }.count == 4)
    #expect(claude.allSatisfy { $0.nextCheckAt == failedAt.addingTimeInterval(7200) && $0.checkStatus == .paused })
    #expect(claude.allSatisfy { $0.lastSucceededAt == good.accounts[0].lastSucceededAt && $0.windows[1].usedPercent == 42 })
    #expect(claude.filter { $0.checkedAt == failedAt }.count == 1)
    clock.advance(600)
    let restarted = fixture.reader(clock) { await transport.send($0) }
    let cached = await restarted.refresh()
    #expect(await transport.claudeRequests == 6)
    #expect(await transport.codexRequests == 9)
    #expect(cached.accounts.first?.lastSucceededAt == good.accounts.first?.lastSucceededAt)
    clock.advance(6600)
    _ = await restarted.refresh()
    #expect(await transport.claudeRequests == 7)
    let state = try #require(try CollectionStore(url: fixture.state).load())
    #expect(state.providers["claude"]?.consecutiveRateLimits == 2)
}

@Test func skippedAccountsDoNotAcquireInventedAttemptOrSuccessTimes() async throws {
    let fixture = try CollectionFixture(claude: 5)
    defer { fixture.remove() }
    let clock = TestClock()
    let transport = CountingTransport()
    await transport.setClaude(UsageHTTPResponse(status: 429, data: Data()))
    let snapshot = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(await transport.claudeRequests == 1)
    #expect(snapshot.accounts.filter { $0.checkedAt == nil && $0.failure?.code == .providerPaused }.count == 4)
    #expect(snapshot.accounts.allSatisfy { $0.lastSucceededAt == nil && $0.windows.isEmpty })
}

@Test(arguments: ["7200", "Tue, 03 Nov 2026 00:00:00 GMT", "junk", "0", "-2"])
func retryAfterAndRepeatedRateLimitsRespectConservativeDeadlines(_ header: String) throws {
    let now = try #require(ISO8601DateFormatter().date(from: "2026-11-02T12:00:00Z"))
    var schedule = ProviderSchedule(nextCheckAt: now)
    schedule.rateLimited(at: now, retryAfter: header)
    let delay: TimeInterval = header == "7200" ? 7200 : header.hasPrefix("Tue") ? 43_200 : 1800
    #expect(schedule.nextCheckAt == now.addingTimeInterval(delay))
    #expect(schedule.paused)
    schedule.rateLimited(at: now, retryAfter: nil)
    #expect(schedule.nextCheckAt == now.addingTimeInterval(3600))
    schedule.rateLimited(at: now, retryAfter: nil)
    #expect(schedule.nextCheckAt == now.addingTimeInterval(7200))
}

private actor GatedTransport {
    private var started: CheckedContinuation<Void, Never>?
    private var response: CheckedContinuation<Void, Never>?
    private var didStart = false
    private(set) var requests = 0
    let store: CollectionStore
    let time: Date

    init(store: CollectionStore, time: Date) { self.store = store; self.time = time }

    func waitForRequest() async {
        if didStart { return }
        await withCheckedContinuation { started = $0 }
    }

    func send(_ request: URLRequest) async throws -> UsageHTTPResponse {
        requests += 1
        let state = try #require(try store.load())
        #expect(state.providers["claude"]?.nextCheckAt == time.addingTimeInterval(1800))
        didStart = true
        started?.resume()
        started = nil
        await withCheckedContinuation { response = $0 }
        return UsageHTTPResponse(status: 200, data: Data(#"{"seven_day":{"utilization":42}}"#.utf8))
    }

    func finish() { response?.resume(); response = nil }
}

@Test func simultaneousClientsCannotDuplicateAReservedRequest() async throws {
    let fixture = try CollectionFixture()
    defer { fixture.remove() }
    let clock = TestClock()
    let transport = GatedTransport(store: CollectionStore(url: fixture.state), time: clock.now())
    let first = fixture.reader(clock) { try await transport.send($0) }
    let second = fixture.reader(clock, cache: fixture.cache) { try await transport.send($0) }
    let pending = Task { await first.refresh() }
    await transport.waitForRequest()
    let shared = await second.refresh()
    #expect(shared.accounts[0].checkStatus == .inProgress)
    #expect(shared.accounts[0].checkedAt == nil)
    #expect(await transport.requests == 1)
    await transport.finish()
    let fresh = await pending.value
    let cached = await second.refresh()
    #expect(cached.accounts[0].lastSucceededAt == fresh.accounts[0].lastSucceededAt)
    #expect(cached.accounts[0].checkStatus == .cached)
    #expect(await transport.requests == 1)
}

@Test func aDifferentProcessHoldingTheLeasePreventsAnyProviderRequest() async throws {
    let fixture = try CollectionFixture()
    defer { fixture.remove() }
    try FileManager.default.createDirectory(at: fixture.state.deletingLastPathComponent(), withIntermediateDirectories: true)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = ["-c", "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); sys.stdout.buffer.write(b'R'); sys.stdout.flush(); sys.stdin.buffer.read(1)", fixture.state.appendingPathExtension("lock").path]
    let input = Pipe()
    let output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    try process.run()
    defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
    #expect(output.fileHandleForReading.readData(ofLength: 1) == Data("R".utf8))
    let clock = TestClock()
    let transport = CountingTransport()
    let reader = fixture.reader(clock) { await transport.send($0) }
    let blocked = await reader.refresh()
    #expect(blocked.accounts[0].checkStatus == .inProgress)
    #expect(await transport.claudeRequests == 0)
    try input.fileHandleForWriting.write(contentsOf: Data([1]))
    process.waitUntilExit()
    _ = await reader.refresh()
    #expect(await transport.claudeRequests == 1)
}

@Test func outputCacheFailureCannotResetTheSharedSchedule() async throws {
    let fixture = try CollectionFixture()
    defer { fixture.remove() }
    let clock = TestClock()
    let transport = CountingTransport()
    // A directory cannot be atomically replaced by the JSON output cache.
    let first = await fixture.reader(clock, cache: fixture.auth) { await transport.send($0) }.refresh()
    #expect(first.cacheFailure?.code == .cache)
    let second = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(second.accounts[0].lastSucceededAt == first.accounts[0].lastSucceededAt)
    #expect(await transport.claudeRequests == 1)
    let attributes = try FileManager.default.attributesOfItem(atPath: fixture.state.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

@Test func invalidOrUnwritableSchedulingStateFailsBeforeHTTP() async throws {
    let fixture = try CollectionFixture()
    defer { fixture.remove() }
    let clock = TestClock()
    let transport = CountingTransport()
    try Data("not a directory".utf8).write(to: fixture.state.deletingLastPathComponent())
    let unwritable = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(unwritable.schedulingFailure?.code == .scheduling)
    #expect(await transport.claudeRequests == 0)
    try FileManager.default.removeItem(at: fixture.state.deletingLastPathComponent())
    try FileManager.default.createDirectory(at: fixture.state.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("corrupt schedule".utf8).write(to: fixture.state)
    let corrupt = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(corrupt.schedulingFailure?.code == .scheduling)
    #expect(await transport.claudeRequests == 0)
}

@Test func upgradingAnExisting429CacheStartsWithACooldownAndKeepsItsEvidence() async throws {
    let fixture = try CollectionFixture()
    defer { fixture.remove() }
    let clock = TestClock()
    let checked = clock.now().addingTimeInterval(-60)
    let lastSuccess = checked.addingTimeInterval(-600)
    let old = AccountUsage(id: "claude-0.json", provider: "claude", email: "0@example.test", state: .unavailable,
                           windows: [UsageWindow(id: "weekly", kind: "weekly", usedPercent: 100, resetsAt: nil)],
                           checkedAt: checked, lastSucceededAt: lastSuccess, failure: UsageFailure(.rateLimited, httpStatus: 429))
    try SnapshotCache.write(UsageSnapshot(generatedAt: clock.now(), accounts: [old]), to: fixture.cache)
    let transport = CountingTransport()
    let previousBytes = try Data(contentsOf: fixture.cache)
    // Suppressing output-cache writes must still migrate the shared old reading.
    let snapshot = await fixture.reader(clock, bootstrapCache: fixture.cache) { await transport.send($0) }.refresh()
    #expect(await transport.claudeRequests == 0)
    #expect(snapshot.accounts[0].failure?.httpStatus == 429)
    #expect(snapshot.accounts[0].checkedAt == checked)
    #expect(snapshot.accounts[0].lastSucceededAt == lastSuccess)
    #expect(snapshot.accounts[0].windows[0].remainingPercent == 0)
    #expect(snapshot.accounts[0].nextCheckAt == checked.addingTimeInterval(1800))
    #expect(snapshot.accounts[0].checkStatus == .paused)
    #expect(try Data(contentsOf: fixture.cache) == previousBytes)
}

@Test func anUnsavedReservationPreventsHTTPAndASavedReservationSurvivesAbandonedWork() async throws {
    let fixture = try CollectionFixture()
    let directory = fixture.state.deletingLastPathComponent()
    defer {
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        fixture.remove()
    }
    let store = CollectionStore(url: fixture.state)
    do { let lease = try store.lock(); withExtendedLifetime(lease) {} }
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
    let clock = TestClock()
    let transport = CountingTransport()
    let blocked = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(blocked.schedulingFailure?.code == .scheduling)
    #expect(await transport.claudeRequests == 0)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    var reserved = CollectionState()
    reserved.providers["claude"] = ProviderSchedule(nextCheckAt: clock.now().addingTimeInterval(1800))
    try store.write(reserved)
    let restarted = await fixture.reader(clock) { await transport.send($0) }.refresh()
    #expect(await transport.claudeRequests == 0)
    #expect(restarted.accounts[0].checkedAt == nil)
    #expect(restarted.accounts[0].nextCheckAt == clock.now().addingTimeInterval(1800))
}
