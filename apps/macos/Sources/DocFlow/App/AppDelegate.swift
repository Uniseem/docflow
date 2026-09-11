import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // A write to an engine that just exited must fail, not kill the app.
        signal(SIGPIPE, SIG_IGN)
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Notifier.shared.activate { id in
            AppModel.shared.reveal(documentID: id)
        }
        AppModel.shared.start()
    }

    /// Documents dropped on the Dock icon or opened with "打开方式".
    func application(_ application: NSApplication, open urls: [URL]) {
        AppModel.shared.openFiles(urls)
    }

    /// Translations keep running with the window closed; the Dock icon
    /// brings the library back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            AppModel.shared.showMainWindow()
        }
        return true
    }

    /// Stops the engine before quitting; running jobs resume from their
    /// checkpoints on the next launch.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard AppModel.shared.needsShutdown else { return .terminateNow }
        Task {
            await AppModel.shared.shutdown()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
