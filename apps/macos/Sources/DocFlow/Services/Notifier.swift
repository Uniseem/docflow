import Foundation
import UserNotifications

/// "翻译完成" / "处理失败" notifications while the app is in the background.
/// Permission is requested the first time one is needed, not at launch.
final class Notifier: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = Notifier()

    private var onOpen: (@MainActor (String) -> Void)?

    /// UserNotifications needs a real app bundle; `swift run` has none.
    private var isAvailable: Bool {
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
    }

    func activate(onOpen: @escaping @MainActor (String) -> Void) {
        self.onOpen = onOpen
        guard isAvailable else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    func post(title: String, body: String, documentID: String) {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["document": documentID]
            let request = UNNotificationRequest(identifier: "document-\(documentID)", content: content, trigger: nil)
            center.add(request, withCompletionHandler: nil)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let id = response.notification.request.content.userInfo["document"] as? String {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.onOpen?(id)
                }
            }
        }
        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The window already shows the result.
        completionHandler([])
    }
}
