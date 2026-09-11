import AppKit
import SwiftUI

/// "新建翻译": choose files, the processing mode and the translation service.
@MainActor
struct NewTranslationSheet: View {
    @Environment(AppModel.self) private var app
    @State private var isImporterPresented = false
    @State private var isDropTargeted = false

    var body: some View {
        @Bindable var form = app.newTranslation
        VStack(spacing: 0) {
            Text("新建翻译")
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 16)
            Form {
                Section {
                    if form.files.isEmpty {
                        DropPrompt { isImporterPresented = true }
                    } else {
                        ForEach(form.files) { file in
                            PendingFileRow(file: file, problem: form.problem(for: file)) {
                                form.remove(file)
                            }
                        }
                    }
                } header: {
                    Text("文件")
                } footer: {
                    Text(form.acceptedHint)
                }

                Section {
                    Picker("处理方式", selection: $form.mode) {
                        Text("PDF 原生翻译").tag("pdf2zh")
                        Text("MinerU 解析翻译").tag("mineru")
                    }
                    .pickerStyle(.radioGroup)
                    Text(form.isNative
                        ? "保留原 PDF 的版式与图表，生成中文 PDF 和双语对照 PDF。"
                        : "由 MinerU 解析文档结构，生成可阅读的译文与期刊排版 PDF，适合扫描件、Office 文档和图片。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Picker("翻译服务", selection: $form.translator) {
                        ForEach(form.translatorOptions) { option in
                            Text(option.label).tag(option.choice)
                        }
                    }
                    Text(form.translatorDetail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    if !form.llmReady {
                        HStack {
                            Text("想用 DeepSeek、通义千问、Kimi、Claude 等大模型翻译？")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Spacer()
                            SettingsLink {
                                Text("添加服务商…")
                            }
                        }
                    }
                }

                if form.files.count == 1 {
                    Section {
                        TextField("标题", text: $form.title, prompt: Text("默认使用文件名"))
                    }
                }

                if let issue = form.issue {
                    Section {
                        HStack(alignment: .firstTextBaseline) {
                            Label {
                                Text(issue)
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                            }
                            Spacer()
                            SettingsLink {
                                Text("打开设置…")
                            }
                        }
                    }
                }

                if let error = form.submitError {
                    Section {
                        Label {
                            Text(error)
                                .textSelection(.enabled)
                        } icon: {
                            Image(systemName: "xmark.octagon.fill")
                                .foregroundStyle(.red)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .overlay {
                if isDropTargeted {
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(Color.accentColor, lineWidth: 3)
                        .padding(6)
                        .allowsHitTesting(false)
                }
            }
            .dropDestination(for: URL.self) { urls, _ in
                form.add(urls)
                return true
            } isTargeted: { targeted in
                isDropTargeted = targeted
            }

            Divider()

            HStack {
                Button("添加文件…") { isImporterPresented = true }
                Spacer()
                if form.isSubmitting {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("取消", role: .cancel) {
                    app.isNewTranslationPresented = false
                }
                .keyboardShortcut(.cancelAction)
                Button(form.files.count > 1 ? "开始翻译 \(form.files.count) 个文件" : "开始翻译") {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!form.canSubmit)
            }
            .padding(16)
        }
        .frame(width: 580, height: 640)
        .fileImporter(
            isPresented: $isImporterPresented,
            allowedContentTypes: form.importableTypes,
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                form.add(urls)
            }
        }
    }

    private func submit() {
        Task {
            let created = await app.newTranslation.submit()
            guard !created.isEmpty else { return }
            if app.newTranslation.files.isEmpty {
                app.didCreate(created)
            } else {
                // Some files were rejected; they stay in the sheet with the reason.
                await app.reloadLibrary()
            }
        }
    }
}

@MainActor
private struct DropPrompt: View {
    let choose: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.badge.plus")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.secondary)
            Text("将文件拖到这里")
                .font(.headline)
            Button("选择文件…", action: choose)
        }
        .frame(maxWidth: .infinity, minHeight: 150)
    }
}

@MainActor
private struct PendingFileRow: View {
    let file: PendingFile
    let problem: String?
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: file.url.path))
                .resizable()
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let problem {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    Text(Format.size(file.size))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help("移除这个文件")
            .accessibilityLabel("移除 \(file.name)")
        }
    }
}
