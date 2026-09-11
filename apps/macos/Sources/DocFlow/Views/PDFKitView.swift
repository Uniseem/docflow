import PDFKit
import SwiftUI

/// A translated PDF in PDFKit, continuous scrolling, fit to width.
struct PDFKitView: NSViewRepresentable {
    let url: URL
    /// Changes when the document is processed again, forcing a reload of
    /// the same path.
    let revision: Date?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displaysPageBreaks = true
        view.displayDirection = .vertical
        load(into: view, context: context)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        if context.coordinator.url != url || context.coordinator.revision != revision {
            load(into: view, context: context)
        }
    }

    private func load(into view: PDFView, context: Context) {
        context.coordinator.url = url
        context.coordinator.revision = revision
        view.document = PDFDocument(url: url)
        view.autoScales = true
    }

    final class Coordinator {
        var url: URL?
        var revision: Date?
    }
}
