import Foundation
import Testing
@testable import GaugeCore

@Test func missingSessionIsUnknownAndWeeklyScopeKeepsItsIdentity() throws {
    let reading = try ProviderReadings.claude(Data(#"{"five_hour":null,"seven_day":{"utilization":100,"resets_at":"2026-11-02T21:00:00.123456Z"},"limits":[{"kind":"weekly_scoped","percent":32,"scope":{"model":{"display_name":"Fable"}}}]}"#.utf8))
    #expect(reading.windows[0].kind == "five_hour")
    #expect(reading.windows[0].remainingPercent == nil)
    #expect(reading.windows[1].kind == "weekly")
    #expect(reading.windows[1].remainingPercent == 0)
    #expect(reading.windows[1].resetsAt != nil)
    #expect(reading.windows[2].scope == "Fable")
    #expect(reading.windows[2].remainingPercent == 68)
    #expect(reading.limited)
}

@Test func modernLimitsRetainAnIdleSessionWithNoResetClock() throws {
    let reading = try ProviderReadings.claude(Data(#"{"five_hour":null,"seven_day":null,"limits":[{"kind":"session","percent":0,"resets_at":null},{"kind":"weekly_all","percent":19,"resets_at":null}]}"#.utf8))
    #expect(reading.windows[0].usedPercent == 0)
    #expect(reading.windows[0].remainingPercent == 100)
    #expect(reading.windows[0].resetsAt == nil)
    #expect(reading.windows[1].usedPercent == 19)
    #expect(!reading.limited)
}

@Test(arguments: [(604_800, "weekly"), (2_592_000, "monthly"), (18_000, "five_hour"), (3600, "custom")])
func codexWindowDurationComesFromProvider(seconds: Int, kind: String) throws {
    let body = #"{"plan_type":"free","rate_limit":{"allowed":true,"primary_window":{"used_percent":21,"limit_window_seconds":\#(seconds),"reset_at":1795027515},"secondary_window":null}}"#
    let reading = try ProviderReadings.codex(Data(body.utf8))
    #expect(reading.plan == "free")
    #expect(reading.windows.count == 1)
    #expect(reading.windows[0].kind == kind)
    #expect(reading.windows[0].durationSeconds == seconds)
    #expect(reading.windows[0].remainingPercent == 79)
}

@Test func malformedAndMissingUsageNeverBecomeAFullAllowance() {
    for body in [#"{}"#, #"{"seven_day":{"utilization":true}}"#, #"{"seven_day":{"utilization":-1}}"#] {
        #expect(throws: AcquisitionError.self) { try ProviderReadings.claude(Data(body.utf8)) }
    }
    #expect(throws: AcquisitionError.self) { try ProviderReadings.codex(Data("not JSON".utf8)) }
}

@Test func providerDeniedAccessWinsOverAnIncompleteWindow() throws {
    let reading = try ProviderReadings.codex(Data(#"{"rate_limit":{"allowed":false,"primary_window":{"used_percent":0,"limit_window_seconds":604800}}}"#.utf8))
    #expect(reading.limited)
}

@Test func proxyErrorsNameTheirActualCredentialAndKeepOnlyAllowlistedFields() throws {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let now = try #require(formatter.date(from: "2026-11-02 09:32:00"))
    let log = """
    [2026-11-01 08:00:00] cursor-old.json model=claude-opus-5-5 Your team has reached its usage limit
    [2026-11-02 09:29:18] cursor-dhowells-materialbank.com.json model=claude-opus-5-5 Your team has reached its usage limit return on 11/21/2026 secret_payload=never-export-this
    [2026-11-02 09:30:00] claude-personal.json model=claude-opus-5-5 authentication failed
    """
    let failures = ProxyFailureReader.parse(log, now: now)
    #expect(failures.count == 2)
    let cursor = try #require(failures["cursor-dhowells-materialbank.com.json"])
    #expect(cursor.kind == "quota")
    #expect(cursor.model == "claude-opus-5-5")
    #expect(cursor.resetDate == "2026-11-21")
    #expect(!String(decoding: try JSONEncoder().encode(cursor), as: UTF8.self).contains("never-export-this"))
}
