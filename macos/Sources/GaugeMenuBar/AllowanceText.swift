import Foundation
import GaugeCore

enum AllowanceText {
    static func provider(_ name: String) -> String {
        switch name {
        case "claude": "Claude"
        case "codex": "Codex"
        case "cursor": "Cursor"
        case "xai": "xAI"
        default: name.capitalized
        }
    }

    static func window(_ window: UsageWindow) -> String {
        let duration: String = switch window.kind {
        case "five_hour": "5 hours"
        case "weekly": "Weekly"
        case "monthly": "30 days"
        default: window.durationSeconds.map { "\($0 / 3600) hours" } ?? "Allowance"
        }
        return window.scope.map { "\($0) · \(duration.lowercased())" } ?? duration
    }

    static func percent(_ value: Double) -> String {
        if value > 0 && value < 1 { return "<1%" }
        return value.formatted(.number.precision(.fractionLength(0))) + "%"
    }

    static func reset(_ date: Date?, now: Date) -> String {
        guard let date else { return "Reset not reported" }
        if date <= now { return "Reset passed · refresh needed" }
        let minute = Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded() * 60)
        return "Resets " + minute.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
    }

    static func failure(_ failure: UsageFailure?) -> String {
        guard let failure else { return "Check failed" }
        let message: String = switch failure.code {
        case .authentication, .missingCredentials: "Sign-in required"
        case .forbidden: "Access denied"
        case .rateLimited: "Too many checks"
        case .network: "Connection failed"
        case .unsupportedProvider: "Allowance unknown"
        case .notReported: "Allowance not reported"
        case .unreadableCredentials: "Can't read account"
        case .invalidResponse: "Unexpected provider response"
        case .discovery: "Can't find proxy accounts"
        case .cache: "Couldn't save last reading"
        case .trace: "Can't read recent failures"
        }
        return failure.httpStatus.map { "\(message) (\($0))" } ?? message
    }
}
