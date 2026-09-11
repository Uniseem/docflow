import AppKit
import SwiftUI
import WebKit

/// The reading view (reader.html next to the article). It loads the
/// library's own files only; links to the web open in the default browser.
struct ReaderView: NSViewRepresentable {
    let url: URL
    /// The library folder: reader.html uses the shared reader-assets there.
    let readAccess: URL
    let serif: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsMagnification = true
        view.allowsBackForwardNavigationGestures = false
        context.coordinator.serif = serif
        context.coordinator.load(url, readAccess: readAccess, in: view)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.loaded != url {
            coordinator.serif = serif
            coordinator.load(url, readAccess: readAccess, in: view)
        } else if coordinator.serif != serif {
            coordinator.serif = serif
            coordinator.applyFont(in: view)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var loaded: URL?
        var serif = false

        func load(_ url: URL, readAccess: URL, in view: WKWebView) {
            loaded = url
            view.loadFileURL(url, allowingReadAccessTo: readAccess)
        }

        func applyFont(in view: WKWebView) {
            view.evaluateJavaScript("document.documentElement.classList.toggle('serif', \(serif ? "true" : "false"));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            applyFont(in: webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if target.isFileURL || target.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            if navigationAction.navigationType == .linkActivated {
                openExternally(target)
            }
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let target = navigationAction.request.url, !target.isFileURL {
                openExternally(target)
            }
            return nil
        }

        private func openExternally(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
            NSWorkspace.shared.open(url)
        }
    }
}
