import SwiftUI

@main
struct DocFlowApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        let model = AppModel.shared

        Window("DocFlow", id: "main") {
            MainView()
                .environment(model)
                .frame(minWidth: 960, minHeight: 600)
        }
        .defaultSize(width: 1240, height: 800)
        .windowResizability(.contentMinSize)
        .commands {
            DocFlowCommands(model: model)
        }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}
