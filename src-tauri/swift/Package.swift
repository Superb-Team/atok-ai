// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AtokAudio",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "AtokAudio", type: .static, targets: ["AtokAudio"])
    ],
    targets: [
        .target(
            name: "AtokAudio",
            path: "Sources/AtokAudio"
        )
    ]
)
