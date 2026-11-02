import GaugeCore
import SwiftUI

struct AccountCard: View {
    let account: AccountUsage
    let now: Date
    let current: Bool
    let showProvider: Bool
    @State private var expanded = false

    private var primary: UsageWindow? {
        account.windows.filter { $0.scope == nil && $0.remainingPercent != nil }
            .min { ($0.remainingPercent ?? 100) < ($1.remainingPercent ?? 100) }
    }

    private var colour: Color {
        if !current { return GaugePalette.secondary }
        return account.state == .limited ? GaugePalette.red : GaugePalette.green
    }

    private var status: String {
        switch account.state {
        case .disabled: "Disabled"
        case .unsupported: "Allowance unknown"
        case .unavailable: AllowanceText.failure(account.failure)
        case .limited: current ? "Limit reached" : "Last known · limit reached"
        case .ready: current ? "Allowance available" : "Reading out of date"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded.toggle() } label: {
                VStack(alignment: .leading, spacing: 7) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(account.email).font(.system(size: 12, weight: .semibold))
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 0)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold)).foregroundStyle(GaugePalette.secondary)
                    }
                    HStack {
                        Text(status).font(.system(size: 11, weight: .medium)).foregroundStyle(colour)
                        Spacer()
                        if showProvider { Text(AllowanceText.provider(account.provider)).font(.system(size: 11)).foregroundStyle(GaugePalette.secondary) }
                    }
                    if let primary, let remaining = primary.remainingPercent {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(AllowanceText.percent(remaining)) left").font(.system(size: 20, weight: .semibold, design: .rounded))
                                .foregroundStyle(colour)
                            Text(AllowanceText.window(primary).lowercased()).font(.system(size: 11)).foregroundStyle(GaugePalette.secondary)
                            Spacer()
                        }
                        Text(AllowanceText.reset(primary.resetsAt, now: now))
                            .font(.system(size: 11)).foregroundStyle(GaugePalette.secondary)
                    } else if account.state == .unsupported {
                        Text("No live allowance reading").font(.system(size: 11)).foregroundStyle(GaugePalette.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([account.email, status, primary?.remainingPercent.map { AllowanceText.percent($0) + " left" }].compactMap { $0 }.joined(separator: ", "))
            .accessibilityHint("Show all limits and check details")
            if expanded {
                Divider()
                ForEach(account.windows) { window in
                    AllowanceWindowRow(window: window, now: now, current: current)
                }
                if let plan = account.plan { Text("Plan: \(plan.capitalized)").font(.system(size: 11)) }
                Text("Checked \(account.checkedAt.formatted(.dateTime.day().month(.abbreviated).hour().minute()))")
                    .font(.system(size: 11)).foregroundStyle(GaugePalette.secondary)
                if !current, let last = account.lastSucceededAt {
                    Text("Last known allowance: \(last.formatted(.dateTime.day().month(.abbreviated).hour().minute()))")
                        .font(.system(size: 11)).foregroundStyle(GaugePalette.amber)
                }
                if let failure = account.failure, account.state != .unsupported {
                    Text(AllowanceText.failure(failure)).font(.system(size: 11)).foregroundStyle(GaugePalette.red)
                }
                if let failure = account.recentProxyFailure { ProxyFailureView(account: account, failure: failure) }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.07), lineWidth: 1))
    }
}

private struct AllowanceWindowRow: View {
    let window: UsageWindow
    let now: Date
    let current: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(AllowanceText.window(window))
                if window.isActive == false { Text("Not active").foregroundStyle(GaugePalette.secondary) }
                Spacer()
                if let value = window.remainingPercent { Text("\(AllowanceText.percent(value)) left").fontWeight(.medium) }
                else { Text("Not reported").foregroundStyle(GaugePalette.secondary) }
            }
            if let value = window.remainingPercent {
                ProgressView(value: min(100, value), total: 100)
                    .tint(current ? (value > 10 ? GaugePalette.green : GaugePalette.red) : GaugePalette.secondary)
                    .accessibilityLabel("\(AllowanceText.window(window)), \(AllowanceText.percent(value)) remaining")
            }
            Text(AllowanceText.reset(window.resetsAt, now: now)).foregroundStyle(GaugePalette.secondary)
        }
        .font(.system(size: 11))
        .padding(.vertical, 3)
    }
}
