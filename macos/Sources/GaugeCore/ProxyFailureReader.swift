import Foundation

enum ProxyFailureReader {
    static func read(_ url: URL?, now: Date) throws -> [String: ProxyFailure] {
        guard let url else { return [:] }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let end = try handle.seekToEnd()
        let start = end > 512_000 ? end - 512_000 : 0
        try handle.seek(toOffset: start)
        guard let data = try handle.readToEnd() else { return [:] }
        return parse(String(decoding: data, as: UTF8.self), now: now)
    }

    static func parse(_ contents: String, now: Date) -> [String: ProxyFailure] {
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let filePattern = /(?:claude|codex|cursor|xai)-[^\s"\]\[,{}]+\.json/
        let modelPattern = /(?:model[=:]\s*["']?|model\s+)([A-Za-z0-9_\/.:-]+)/
        let resetPattern = /return on (\d{2})\/(\d{2})\/(\d{4})/
        var failures: [String: ProxyFailure] = [:]
        for line in contents.split(separator: "\n") {
            guard let file = line.firstMatch(of: filePattern)?.0,
                  line.first == "[", line.count > 20,
                  let time = dateFormatter.date(from: String(line.dropFirst().prefix(19))),
                  now.timeIntervalSince(time) >= -60, now.timeIntervalSince(time) < 86_400 else { continue }
            let kind: String
            if line.contains("Your team has reached its usage limit") || line.contains("quota exceeded") {
                kind = "quota"
            } else if line.contains("unauthorized") || line.contains("authentication failed") {
                kind = "authentication"
            } else { continue }
            let model = line.firstMatch(of: modelPattern).map { String($0.1) }
                ?? (line.contains("claude-opus-5-5") ? "claude-opus-5-5" : nil)
            let reset = line.firstMatch(of: resetPattern).map { "\($0.3)-\($0.1)-\($0.2)" }
            failures[String(file)] = ProxyFailure(observedAt: time, kind: kind, model: model, resetDate: reset)
        }
        return failures
    }
}
