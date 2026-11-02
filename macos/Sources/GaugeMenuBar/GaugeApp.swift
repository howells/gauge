import AppKit
import SwiftUI

@main
struct GaugeApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = GaugeDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class GaugeDelegate: NSObject, NSApplicationDelegate {
    private let model = GaugeModel()
    private var item: NSStatusItem?
    private let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 660),
                                 styleMask: [.titled, .closable], backing: .buffered, defer: false)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.item = item
        guard let button = item.button else { preconditionFailure("No menu bar button") }
        button.title = " Gauge"
        button.image = NSImage(systemSymbolName: "gauge.medium", accessibilityDescription: "Gauge")
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(togglePanel)
        button.toolTip = "AI account allowance"
        panel.title = "Gauge"
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.moveToActiveSpace]
        panel.contentViewController = NSHostingController(rootView:
            GaugePanel(model: model).environment(\.locale, Locale(identifier: "en_GB")))
        panel.center()
        showPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showPanel()
        return true
    }

    @objc private func togglePanel() {
        if panel.isVisible { panel.orderOut(nil) }
        else { showPanel() }
    }

    private func showPanel() {
        panel.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
