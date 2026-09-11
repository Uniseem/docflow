// swift-tools-version: 5.10
// DocFlow for macOS. `./build.sh` assembles DocFlow.app around this
// executable; the package can also be opened in Xcode for editing.
import PackageDescription

let package = Package(
    name: "DocFlow",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "DocFlow", targets: ["DocFlow"]),
    ],
    targets: [
        .executableTarget(
            name: "DocFlow",
            path: "Sources/DocFlow"
        ),
    ]
)
