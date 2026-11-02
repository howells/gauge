import Foundation

public struct UsageSnapshot: Codable, Sendable {
    public let schemaVersion: Int
    public let generatedAt: Date
    public let accounts: [AccountUsage]
    public let discoveryFailure: UsageFailure?
    public let cacheFailure: UsageFailure?
    public let traceFailure: UsageFailure?

    public init(generatedAt: Date, accounts: [AccountUsage], discoveryFailure: UsageFailure? = nil, cacheFailure: UsageFailure? = nil, traceFailure: UsageFailure? = nil) {
        self.schemaVersion = 1
        self.generatedAt = generatedAt
        self.accounts = accounts
        self.discoveryFailure = discoveryFailure
        self.cacheFailure = cacheFailure
        self.traceFailure = traceFailure
    }
}

public enum AccountState: String, Codable, Sendable {
    case ready, limited, unavailable, disabled, unsupported
}

public enum FailureCode: String, Codable, Sendable {
    case authentication, forbidden, rateLimited, network, invalidResponse
    case unreadableCredentials, missingCredentials, unsupportedProvider, discovery, cache, trace, notReported
}

public struct UsageFailure: Codable, Sendable {
    public let code: FailureCode
    public let httpStatus: Int?

    public init(_ code: FailureCode, httpStatus: Int? = nil) {
        self.code = code
        self.httpStatus = httpStatus
    }
}

public struct UsageWindow: Identifiable, Codable, Sendable {
    public let id: String
    public let kind: String
    public let scope: String?
    public let usedPercent: Double?
    public let resetsAt: Date?
    public let durationSeconds: Int?
    public let isActive: Bool?

    public var remainingPercent: Double? {
        usedPercent.map { max(0, 100 - $0) }
    }

    public init(id: String, kind: String, scope: String? = nil, usedPercent: Double?, resetsAt: Date?, durationSeconds: Int? = nil, isActive: Bool? = nil) {
        self.id = id
        self.kind = kind
        self.scope = scope
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.durationSeconds = durationSeconds
        self.isActive = isActive
    }
}

public struct AccountUsage: Identifiable, Codable, Sendable {
    public let id: String
    public let provider: String
    public let email: String
    public let plan: String?
    public let state: AccountState
    public let windows: [UsageWindow]
    public let checkedAt: Date
    public let lastSucceededAt: Date?
    public let failure: UsageFailure?
    public let recentProxyFailure: ProxyFailure?

    public var isStale: Bool { state == .unavailable && lastSucceededAt != nil }

    public init(id: String, provider: String, email: String, plan: String? = nil, state: AccountState, windows: [UsageWindow] = [], checkedAt: Date, lastSucceededAt: Date? = nil, failure: UsageFailure? = nil, recentProxyFailure: ProxyFailure? = nil) {
        self.id = id
        self.provider = provider
        self.email = email
        self.plan = plan
        self.state = state
        self.windows = windows
        self.checkedAt = checkedAt
        self.lastSucceededAt = lastSucceededAt
        self.failure = failure
        self.recentProxyFailure = recentProxyFailure
    }
}

public struct ProxyFailure: Codable, Sendable {
    public let observedAt: Date
    public let kind: String
    public let model: String?
    public let resetDate: String?

    public init(observedAt: Date, kind: String, model: String? = nil, resetDate: String? = nil) {
        self.observedAt = observedAt
        self.kind = kind
        self.model = model
        self.resetDate = resetDate
    }
}
