import Foundation
import CoreFoundation

struct ProviderReading: Sendable {
    let plan: String?
    let windows: [UsageWindow]
    let limited: Bool
}

enum ProviderReadings {
    static func date(_ value: Any?) -> Date? {
        if let seconds = value as? Double {
            guard seconds.isFinite else { return nil }
            return Date(timeIntervalSince1970: seconds > 1_000_000_000_000 ? seconds / 1000 : seconds)
        }
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func object(_ data: Data) throws -> [String: Any] {
        do {
            guard data.count <= 1_000_000,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw AcquisitionError(.invalidResponse)
            }
            return object
        } catch { throw AcquisitionError(.invalidResponse) }
    }

    static func percent(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber,
              CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue >= 0 else { return nil }
        return value.doubleValue
    }

    static func text(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 320,
              value.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return value
    }

    static func claude(_ data: Data, plan: String? = nil) throws -> ProviderReading {
        let body = try object(data)
        let limits = body["limits"] as? [[String: Any]] ?? []
        guard limits.count <= 100 else { throw AcquisitionError(.invalidResponse) }
        func window(_ field: String, limitKind: String, kind: String, seconds: Int) -> UsageWindow {
            let legacy = body[field] as? [String: Any]
            let limit = limits.first { $0["kind"] as? String == limitKind }
            let used = percent(legacy?["utilization"]) ?? percent(limit?["percent"])
            return UsageWindow(id: field, kind: kind, usedPercent: used,
                               resetsAt: date(legacy?["resets_at"] ?? limit?["resets_at"]), durationSeconds: seconds)
        }
        var windows = [
            window("five_hour", limitKind: "session", kind: "five_hour", seconds: 18_000),
            window("seven_day", limitKind: "weekly_all", kind: "weekly", seconds: 604_800)
        ]
        for (field, scope) in [("seven_day_opus", "Opus"), ("seven_day_sonnet", "Sonnet"),
                               ("seven_day_oauth_apps", "OAuth apps"), ("seven_day_cowork", "Cowork")] {
            if let value = body[field] as? [String: Any], let used = percent(value["utilization"]) {
                windows.append(UsageWindow(id: field, kind: "weekly", scope: scope, usedPercent: used,
                                           resetsAt: date(value["resets_at"]), durationSeconds: 604_800))
            }
        }
        for (index, limit) in limits.enumerated() where limit["kind"] as? String == "weekly_scoped" {
            let scope = limit["scope"] as? [String: Any]
            let model = scope?["model"] as? [String: Any]
            if let name = text(model?["display_name"]), let used = percent(limit["percent"]) {
                windows.append(UsageWindow(id: "scoped_\(index)", kind: "weekly", scope: name, usedPercent: used,
                                           resetsAt: date(limit["resets_at"]), durationSeconds: 604_800))
            }
        }
        guard windows.contains(where: { $0.usedPercent != nil }) else { throw AcquisitionError(.notReported) }
        return ProviderReading(plan: plan, windows: windows,
                               limited: windows.contains { $0.scope == nil && ($0.usedPercent ?? -1) >= 100 })
    }

    static func codex(_ data: Data) throws -> ProviderReading {
        let body = try object(data)
        let rate = body["rate_limit"] as? [String: Any]
        var windows: [UsageWindow] = []
        func append(_ block: [String: Any]?, prefix: String, scope: String? = nil) {
            for field in ["primary_window", "secondary_window"] {
                guard let value = block?[field] as? [String: Any] else { continue }
                let seconds = percent(value["limit_window_seconds"]).map(Int.init)
                let kind: String = switch seconds {
                case 18_000: "five_hour"
                case 604_800: "weekly"
                case 2_592_000: "monthly"
                default: "custom"
                }
                windows.append(UsageWindow(id: "\(prefix)_\(field)", kind: kind, scope: scope,
                                           usedPercent: percent(value["used_percent"]),
                                           resetsAt: date(value["reset_at"]), durationSeconds: seconds))
            }
        }
        append(rate, prefix: "account")
        let additional = body["additional_rate_limits"] as? [[String: Any]] ?? []
        guard additional.count <= 100 else { throw AcquisitionError(.invalidResponse) }
        for (index, block) in additional.enumerated() {
            let scope = text(block["limit_name"]) ?? text(block["metered_feature"])
            append(block["rate_limit"] as? [String: Any], prefix: "additional_\(index)", scope: scope ?? "additional")
        }
        guard windows.contains(where: { $0.usedPercent != nil }) else { throw AcquisitionError(.notReported) }
        let limited = (rate?["allowed"] as? Bool == false) || (rate?["limit_reached"] as? Bool == true)
            || windows.contains { $0.scope == nil && ($0.usedPercent ?? -1) >= 100 }
        return ProviderReading(plan: text(body["plan_type"]), windows: windows, limited: limited)
    }
}
