import AppKit
import GaugeCore
import SwiftUI

struct GaugePanel: View {
    @Bindable var model: GaugeModel
    @State private var provider = "claude"
    @State private var showSettings = false
    @State private var remote = false
    @State private var editedHost = ""
    @State private var editedIdentityFile = ""

    private var accounts: [AccountUsage] { model.snapshot?.accounts ?? [] }
    private var visibleAccounts: [AccountUsage] {
        accounts.filter {
            provider == "all" || $0.provider == provider
                || (provider == "other" && !["claude", "codex"].contains($0.provider))
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(spacing: 0) {
                header
                Divider()
                if showSettings { settings }
                else { content(now: context.date) }
                Divider()
                footer
            }
            .frame(width: 460, height: 660)
            .background(Color(nsColor: NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    ? NSColor(calibratedRed: 0.12, green: 0.115, blue: 0.11, alpha: 1)
                    : NSColor(calibratedRed: 0.975, green: 0.968, blue: 0.955, alpha: 1)
            }))
        }
        .task { await model.refreshIfNeeded() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "gauge.medium").font(.system(size: 22, weight: .medium))
                .foregroundStyle(.brown)
            VStack(alignment: .leading, spacing: 3) {
                Text("Gauge").font(.system(size: 19, weight: .semibold))
                Text("Account allowance").font(.system(size: 12)).foregroundStyle(GaugePalette.secondary)
            }
            Spacer()
            if model.isRefreshing { ProgressView().controlSize(.small).accessibilityLabel("Loading allowance") }
            Button {
                editedHost = model.host
                editedIdentityFile = model.identityFile
                remote = !model.host.isEmpty
                showSettings.toggle()
            } label: { Image(systemName: showSettings ? "xmark" : "gearshape") }
                .buttonStyle(.borderless)
                .help(showSettings ? "Close settings" : "Proxy settings")
                .accessibilityLabel(showSettings ? "Close settings" : "Proxy settings")
        }
        .padding(18)
    }

    private func content(now: Date) -> some View {
        VStack(spacing: 12) {
            if let message = model.connectionFailure {
                Notice(message: message, symbol: "wifi.exclamationmark")
            }
            if model.snapshot?.discoveryFailure != nil {
                Notice(message: "Can't find proxy accounts. Check the proxy location in settings.", symbol: "folder.badge.questionmark")
            }
            if model.snapshot?.traceFailure != nil {
                Notice(message: "Recent failed requests couldn't be checked.", symbol: "exclamationmark.triangle")
            }
            if model.cacheFailed || model.snapshot?.cacheFailure != nil {
                Notice(message: "Couldn't save the last reading for offline use.", symbol: "exclamationmark.triangle")
            }
            if model.snapshot?.schedulingFailure != nil {
                Notice(message: "Provider checks paused. Couldn't save the shared check schedule.", symbol: "pause.circle")
            }
            if let failed = accounts.filter({ $0.recentProxyFailure != nil }).max(by: {
                ($0.recentProxyFailure?.observedAt ?? .distantPast) < ($1.recentProxyFailure?.observedAt ?? .distantPast)
            }), let failure = failed.recentProxyFailure {
                ProxyFailureView(account: failed, failure: failure)
            }
            Picker("Provider", selection: $provider) {
                Text("Claude").tag("claude")
                Text("Codex").tag("codex")
                Text("Other").tag("other")
                Text("All").tag("all")
            }
            .pickerStyle(.segmented)
            HStack {
                Text(model.snapshot == nil && model.connectionFailure != nil
                     ? "Accounts unavailable" : "\(visibleAccounts.count) accounts").fontWeight(.medium)
                Spacer()
                let limited = visibleAccounts.filter { $0.state == .limited && model.isCurrent($0, at: now) }.count
                if limited > 0 { Text("\(limited) at limit").foregroundStyle(GaugePalette.red) }
            }
            .font(.system(size: 12))
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(visibleAccounts) { account in
                        AccountCard(account: account, now: now, current: model.isCurrent(account, at: now), showProvider: provider == "all" || provider == "other")
                    }
                    if visibleAccounts.isEmpty {
                        VStack(spacing: 8) {
                            Text(model.isRefreshing ? "Checking proxy accounts…"
                                 : model.connectionFailure != nil ? "Can't load accounts" : "No accounts here").fontWeight(.medium)
                            Text(accounts.isEmpty ? "Choose the Mac running CLIProxyAPI in settings." : "Try another provider.")
                                .foregroundStyle(GaugePalette.secondary)
                        }.font(.system(size: 13)).padding(.vertical, 36)
                    }
                }
                .padding(.bottom, 8)
            }
            .scrollIndicators(.visible)
        }
        .padding(.horizontal, 16).padding(.top, 12)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Proxy location").font(.system(size: 17, weight: .semibold))
            Text("Choose the Mac running CLIProxyAPI.").font(.system(size: 13))
            Picker("Location", selection: $remote) {
                Text("This Mac").tag(false)
                Text("Another Mac over SSH").tag(true)
            }.pickerStyle(.radioGroup)
            if remote {
                TextField("SSH host", text: $editedHost)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("SSH host")
                VStack(alignment: .leading, spacing: 6) {
                    Text("SSH key (optional)").font(.system(size: 12))
                    TextField("Use SSH defaults", text: $editedIdentityFile)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("SSH key")
                    if !RemoteUsage.valid(identityFile: editedIdentityFile.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        Text("Choose a readable SSH key file.")
                            .font(.system(size: 12)).foregroundStyle(GaugePalette.red)
                    }
                }
                Text("Uses your existing SSH access. Only allowance readings leave the proxy Mac.")
                    .font(.system(size: 12)).foregroundStyle(GaugePalette.secondary)
            }
            Button("Save and reload") {
                showSettings = false
                Task { await model.configure(host: remote ? editedHost : "", identityFile: editedIdentityFile) }
            }
            .disabled(model.isRefreshing || (remote && (
                !RemoteUsage.valid(host: editedHost.trimmingCharacters(in: .whitespacesAndNewlines))
                    || !RemoteUsage.valid(identityFile: editedIdentityFile.trimmingCharacters(in: .whitespacesAndNewlines))
            )))
            .buttonStyle(.borderedProminent)
            Spacer()
            Text("Reloads saved readings every minute. Provider checks are at least 10 minutes apart, with longer pauses after rate limits. Times use \(TimeZone.current.identifier).")
                .font(.system(size: 12)).foregroundStyle(GaugePalette.secondary)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var footer: some View {
        VStack(spacing: 10) {
            HStack {
                if let checked = visibleAccounts.compactMap(\.lastSucceededAt).max() {
                    Text("Last success \(checked, style: .relative) ago")
                } else { Text("No successful check yet") }
                Spacer()
                Text(TimeZone.current.identifier)
            }
            .font(.system(size: 11)).foregroundStyle(GaugePalette.secondary)
            HStack {
                Text(model.host.isEmpty ? "Proxy on this Mac" : "Proxy on \(model.host)")
                    .font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                    .help(model.sourceName)
                Spacer()
                Button("Reload", systemImage: "arrow.clockwise") { Task { await model.refresh() } }
                    .disabled(model.isRefreshing).keyboardShortcut("r")
                    .help("Reload saved readings. Checks run only when the shared schedule allows.")
                Button("Quit") { NSApplication.shared.terminate(nil) }
            }
        }.padding(.horizontal, 16).padding(.vertical, 12)
    }
}

private struct Notice: View {
    let message: String
    let symbol: String
    var body: some View {
        Label(message, systemImage: symbol)
            .font(.system(size: 12)).foregroundStyle(GaugePalette.amber)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct ProxyFailureView: View {
    let account: AccountUsage
    let failure: ProxyFailure

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(failure.kind == "quota" ? "Request hit a quota" : "Failed request", systemImage: "exclamationmark.triangle.fill")
                    .fontWeight(.semibold).foregroundStyle(GaugePalette.red)
                Spacer()
                Text(failure.observedAt, style: .time).foregroundStyle(GaugePalette.secondary)
            }
            Text("\(AllowanceText.provider(account.provider)) · \(account.email)").textSelection(.enabled)
            if let model = failure.model { Text(model).foregroundStyle(GaugePalette.secondary) }
            if let reset = failure.resetDate { Text("Reset date: \(reset) · time not reported") }
        }
        .font(.system(size: 11))
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}
