// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GaugeMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "GaugeCore", targets: ["GaugeCore"]),
        .executable(name: "gauge-proxy-usage", targets: ["GaugeUsageCLI"]),
        .executable(name: "GaugeMenuBar", targets: ["GaugeMenuBar"])
    ],
    targets: [
        .target(name: "GaugeCore"),
        .executableTarget(name: "GaugeUsageCLI", dependencies: ["GaugeCore"]),
        .executableTarget(name: "GaugeMenuBar", dependencies: ["GaugeCore"]),
        .testTarget(name: "GaugeCoreTests", dependencies: ["GaugeCore"])
    ]
)
