import AppKit
import SwiftUI

@MainActor
enum GaugePalette {
    static let secondary = adaptive(light: 0x655E57, dark: 0xC3BAB1)
    static let red = adaptive(light: 0xAD3029, dark: 0xFF9F93)
    static let green = adaptive(light: 0x23633D, dark: 0x82D9A0)
    static let amber = adaptive(light: 0x8A570C, dark: 0xE7BF75)

    private static func adaptive(light: Int, dark: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: Double((value >> 16) & 255) / 255,
                           green: Double((value >> 8) & 255) / 255,
                           blue: Double(value & 255) / 255, alpha: 1)
        })
    }
}
