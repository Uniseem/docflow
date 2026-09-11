import AppKit
import SwiftUI

/// Menu bar commands. Document commands act on the selected document.
@MainActor
struct DocFlowCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("关于 DocFlow") { model.showAbout() }
        }

        CommandGroup(replacing: .newItem) {
            Button("新建翻译…") { model.presentNewTranslation() }
                .keyboardShortcut("n")
                .disabled(!model.isReady)
        }

        CommandGroup(after: .newItem) {
            Divider()
            Button("在访达中显示文档库") { FileActions.openFolder(model.dataDirectory) }
        }

        SidebarCommands()
        InspectorCommands()

        CommandMenu("文档") {
            let document = model.selectedDocument
            Button("用默认应用打开") {
                if let document { model.openExternally(document) }
            }
            .keyboardShortcut("o")
            .disabled(document?.isCompleted != true)
            Button("在访达中显示") {
                if let document { model.revealInFinder(document) }
            }
            .keyboardShortcut("r", modifiers: [.command, .option])
            .disabled(document == nil)
            Divider()
            Button("重新处理") {
                if let document { model.retry(document.id) }
            }
            .keyboardShortcut("r")
            .disabled(document?.isStopped != true)
            Button("取消处理…") {
                if let document { model.cancelCandidate = document }
            }
            .keyboardShortcut(".")
            .disabled(document?.isActive != true)
            Divider()
            Button("重命名…") {
                if let document { model.beginRename(document) }
            }
            .disabled(document == nil)
            Button("导出全部文件（ZIP）…") {
                if let document { model.exportBundle(document) }
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(document?.isCompleted != true)
            Divider()
            Button("删除…") {
                if let document { model.beginDelete([document.id]) }
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(document == nil)
        }

        CommandGroup(replacing: .help) {
            Button("DocFlow 源代码与说明") {
                if let url = URL(string: "https://github.com/FengYuchen1314/docflow") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }
}
