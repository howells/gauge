import Foundation
import Testing
@testable import GaugeCore

private actor Responses {
    private var responses: [UsageHTTPResponse]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [UsageHTTPResponse]) { self.responses = responses }

    func send(_ request: URLRequest) throws -> UsageHTTPResponse {
        requests.append(request)
        guard !responses.isEmpty else { throw AcquisitionError(.network) }
        return responses.removeFirst()
    }
}

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Test func failedChecksRetainLastGoodReadingWithoutTouchingCredentials() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let credential = directory.appendingPathComponent("claude-personal.json")
    let credentialData = Data(#"{"type":"claude","email":"personal@example.test","access_token":"test-access-value","refresh_token":"test-refresh-value"}"#.utf8)
    try credentialData.write(to: credential)
    let transport = Responses([
        UsageHTTPResponse(status: 200, data: Data(#"{"seven_day":{"utilization":42,"resets_at":null}}"#.utf8)),
        UsageHTTPResponse(status: 401, data: Data("private provider body".utf8))
    ])
    let time = Date(timeIntervalSince1970: 1_793_612_000)
    let reader = ProxyUsageReader(directory: directory, transport: { try await transport.send($0) }, now: { time })
    let first = await reader.refresh()
    #expect(first.accounts[0].state == .ready)
    let second = await reader.refresh()
    let row = try #require(second.accounts.first)
    #expect(row.state == .unavailable)
    #expect(row.failure?.code == .authentication)
    #expect(row.failure?.httpStatus == 401)
    #expect(row.isStale)
    #expect(row.lastSucceededAt == first.accounts[0].lastSucceededAt)
    #expect(row.windows[1].usedPercent == 42)
    #expect(try Data(contentsOf: credential) == credentialData)
    let requests = await transport.requests
    #expect(requests.count == 2)
    #expect(requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/api/oauth/usage" })
    let encoded = String(decoding: try JSONEncoder().encode(second), as: UTF8.self)
    #expect(!encoded.contains("test-access-value"))
    #expect(!encoded.contains("test-refresh-value"))
    #expect(!encoded.contains("private provider body"))
}

@Test func everyDiscoveredAccountRemainsVisibleIncludingUnsupportedAndBrokenFiles() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let files = [
        "xai-disabled.json": #"{"type":"xai","email":"disabled@example.test","disabled":true}"#,
        "cursor-team.json": #"{"type":"cursor","email":"team@example.test","api_key":"never-read-this"}"#,
        "claude-broken.json": "not JSON"
    ]
    for (name, contents) in files { try Data(contents.utf8).write(to: directory.appendingPathComponent(name)) }
    let transport = Responses([])
    let reader = ProxyUsageReader(directory: directory, transport: { try await transport.send($0) }, now: { Date() })
    let snapshot = await reader.refresh()
    #expect(snapshot.accounts.count == 3)
    #expect(Set(snapshot.accounts.map(\.state)) == [.disabled, .unsupported, .unavailable])
    #expect(await transport.requests.isEmpty)
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).count == 3)
}

@Test func malformedUpstreamDataIsNotMisclassifiedAsANetworkFailure() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data(#"{"type":"codex","access_token":"test"}"#.utf8).write(to: directory.appendingPathComponent("codex-one.json"))
    let reader = ProxyUsageReader(directory: directory,
        transport: { _ in UsageHTTPResponse(status: 200, data: Data("not JSON".utf8)) }, now: { Date() })
    let snapshot = await reader.refresh()
    #expect(snapshot.accounts[0].state == .unavailable)
    #expect(snapshot.accounts[0].failure?.code == .invalidResponse)
    #expect(snapshot.accounts[0].windows.isEmpty)
}

@Test func durableCacheSurvivesRestartAndDiscoveryFailureRemainsExplicit() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let directory = root.appendingPathComponent("auth", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    try Data(#"{"type":"claude","access_token":"test"}"#.utf8).write(to: directory.appendingPathComponent("claude-one.json"))
    let cache = root.appendingPathComponent("cache/snapshot.json")
    let time = Date(timeIntervalSince1970: 1_793_612_000)
    let reader = ProxyUsageReader(directory: directory, cacheURL: cache,
        transport: { _ in UsageHTTPResponse(status: 200, data: Data(#"{"seven_day":{"utilization":87}}"#.utf8)) }, now: { time })
    _ = await reader.refresh()
    let mode = try FileManager.default.attributesOfItem(atPath: cache.path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o600)
    try FileManager.default.removeItem(at: directory)
    let restarted = ProxyUsageReader(directory: directory, cacheURL: cache,
        transport: { _ in throw AcquisitionError(.network) }, now: { time.addingTimeInterval(600) })
    let snapshot = await restarted.refresh()
    #expect(snapshot.discoveryFailure?.code == .discovery)
    #expect(snapshot.accounts.count == 1)
    #expect(snapshot.accounts[0].isStale)
    #expect(snapshot.accounts[0].windows[1].usedPercent == 87)
}
