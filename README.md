# DocFlow

DocFlow 是 Windows 与 macOS 上的文档翻译应用。把 PDF、Word、PowerPoint、Excel、图片或网页交给它，它会译成简体中文，并把源文件、译文、PDF 和完整的处理记录保存在本机文档库里。

- **PDF 原生翻译**：基于 pdf2zh-next 使用的 [BabelDOC 0.6.4](https://github.com/funstory-ai/BabelDOC/releases/tag/v0.6.4) 排版内核，保留原 PDF 的版式、图表和公式，生成中文 PDF 与双语对照 PDF。不需要 MinerU。
- **MinerU 解析翻译**：由 [MinerU](https://mineru.net/) 解析文档结构，生成可阅读的译文（阅读视图，公式由 KaTeX 渲染）和由 Typst 排版的 A4 期刊风格 PDF。适合扫描件、Office 文档和图片。

两种方式共用同一套翻译服务：

- **Google 翻译（免费）**：使用 Google 翻译的免费网页接口，无需 API Key，开箱即用。
- **大模型服务商**：参考 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 的服务商接入方式——从预设中选择服务商（DeepSeek、OpenAI、Anthropic、Google Gemini、OpenRouter、硅基流动、阿里云百炼、火山引擎、Kimi、智谱、腾讯混元、阶跃星辰、零一万物、xAI、Groq、Mistral、Azure OpenAI、Ollama、LM Studio），或添加任何 OpenAI 兼容 / Anthropic / Gemini 接口；填写 API 地址和 Key 后一键**获取模型列表**，勾选要用的模型即可。每个服务商的并发请求数可以手动调整，默认 100。

两个应用都是原生界面：Windows 版使用 WinUI 3 与 Fluent Design，macOS 版使用 SwiftUI 并遵循 Apple 人机界面指南。它们共享同一个处理引擎，文档库格式相同。

## 系统要求

| | Windows | macOS |
| --- | --- | --- |
| 系统 | Windows 10 2004（19041）或更高版本，x64 | macOS 14 Sonoma 或更高版本，Apple 芯片或 Intel |
| 其他 | Microsoft Edge WebView2 运行时（Windows 11 已自带）；Visual C++ 运行库已内置，无需另装 | — |
| 磁盘 | 应用约 1.3 GB（含 Python 与 BabelDOC 离线资源），另需文档库空间 | 同左 |

翻译需要联网访问所选服务；PDF 原生翻译的版面分析在本机 CPU 上进行，不需要 GPU。

## 安装

### Windows

解压 `DocFlow-win-x64.zip`，运行其中的 `DocFlow.exe`。不需要管理员权限，也不需要另外安装 .NET 或 Visual C++ 运行库；可以放在任何文件夹，包括含中文的路径。

没有代码签名的构建第一次运行时，Windows 可能显示“Windows 已保护你的电脑”：点“更多信息 → 仍要运行”即可，之后不再询问。

### macOS

双击 `DocFlow-macos-<架构>.pkg` 安装包，按提示安装到“应用程序”文件夹。Apple 芯片的 Mac 用 arm64 版，Intel 芯片的 Mac 用 x86_64 版。

经过 Apple 公证的安装包可以直接打开。**未公证的安装包**第一次打开时，macOS 会提示“无法验证开发者”（macOS 15 显示“未打开”）——这是 macOS 对所有未公证软件的统一提示，手动允许一次即可：

- macOS 15 及以后：双击安装包，在提示中点“完成”；打开“系统设置 → 隐私与安全性”，在页面下方点“仍要打开”并输入登录密码，再点“打开”。
- macOS 14：按住 Control 点按安装包，选“打开”，再点“打开”。

之后安装器会把 DocFlow 放进“应用程序”文件夹。由安装器安装的应用不带下载隔离标记，打开 DocFlow 时不会再有任何提示，也不会出现“已损坏”之类的错误。

## 使用

1. **选择翻译服务**：Google 翻译无需设置即可使用。要使用大模型，打开“设置 → 翻译服务”，点“添加服务商”选择预设，填写 API Key（多个 Key 用英文逗号分隔，会轮流使用），点“获取模型列表”勾选要用的模型；每个模型旁的“检查”会发送一个测试请求。使用 MinerU 解析翻译时，在“设置 → 文档解析”填写 MinerU 的 API Key。
2. **新建翻译**：把文件拖到窗口里，或点“新建翻译”选择文件，选好处理方式和翻译服务即可开始。一次可以加入多个文件。
3. **查看进度**：文档库按“全部 / 进行中 / 已完成 / 失败与取消”分类，可搜索标题和文件名。处理中的文档显示当前阶段、各阶段状态和逐条处理记录（可只看警告和错误）。
4. **阅读与导出**：完成后可以在应用内阅读中文 PDF、双语对照、阅读视图或期刊 PDF，也可以导出单个文件或包含全部文件与处理记录的 ZIP。

失败的文档可以重新处理，已通过校验的翻译分段会作为断点复用。关闭应用时，进行中的任务会停止，下次启动后从断点继续。在 macOS 上关闭窗口不会停止任务，按 ⌘Q 退出应用时才会停止；在 Windows 上关闭窗口即退出应用。

所在网络无法直接访问 Google 或某个服务商时，在“设置 → 网络”选择代理：跟随系统（读取 Windows / macOS 的系统代理）、不使用代理或自定义（HTTP、HTTPS、SOCKS5）。

### 数据保存在哪里

| | Windows | macOS |
| --- | --- | --- |
| 文档库（默认） | `%LOCALAPPDATA%\DocFlow` | `~/Library/Application Support/DocFlow` |
| API Key | Windows 凭据管理器（`DocFlow/mineru`、`DocFlow/provider:<服务商>`） | 钥匙串（服务 `DocFlow`，所有 Key 在一个条目中） |

文档库可以在设置中移到其他文件夹。BabelDOC 只能处理纯英文（ASCII）路径：在 Windows 上，如果文档库或应用所在路径含中文（例如中文用户名），引擎会自动改用 `%ProgramData%\DocFlow`——处理中的临时文件放在只有当前用户能打开的子文件夹里，BabelDOC 的离线资源在首次使用时链接或复制到那里。macOS 的用户文件夹总是英文路径；把文档库移到含中文的文件夹时，PDF 原生翻译会提示原因。

文档库的结构：

```text
DocFlow/
├── docflow.db        # SQLite：文档、处理记录与设置（含服务商配置，不含 Key）
├── archives/<key>/   # 每个文档：源文件、Markdown、PDF、阅读视图、图片、MinerU 原始结果
├── work/             # 处理中的临时文件与翻译断点
├── reader-assets/    # 阅读视图共用的 KaTeX 与样式
├── native-pdf/       # PDF 原生翻译的适配脚本
└── logs/             # 引擎日志（engine.log）和应用日志
```

API Key 只保存在系统的凭据存储中，启动时由应用在内存中交给引擎，不会写入文档库或日志；服务商返回的错误信息在显示前会去掉 Key。PDF 原生翻译的 Python 进程不持有任何 Key，也不直接访问翻译服务；它把段落交给引擎，由引擎统一调度。

## 翻译与自动修复

**分段**：公式、代码、图片、链接地址、HTML 标签、脚注等先由本地占位符保护，表格（HTML 与 Markdown 管道表格）按单元格翻译、结构不动。之后每个段落是一段，超过上限的长段落在句子边界拆开（从不切开占位符）；只有公式、图片或代码的段落不发送。多个段落合并成一次请求：大模型用 `<segment id="…">` 标记区分段落，Google 翻译按行数把译文分回各段。

**校验与修复**：每段译文都要通过校验才会保存，出现问题时逐级修复：

1. 批量请求中缺失、重复或未通过校验的段落单独重译；输出被截断时，已完整返回的段落直接保留。
2. 占位符被模型改动（加空格、反引号、改大小写、调换顺序）时先在本地修复；修复不了则用更严格的要求重译。
3. 输出被截断、被服务拒绝、请求超出上下文长度或仍未通过校验的长段落，在段落或句子边界一分为二，每半段带着公式和标记照常翻译。
4. 仍然失败的短段落改为只翻译占位符之间的普通文本；被拒绝的片段继续拆小，实在无法翻译的少量文字保留原文并在处理记录中给出警告。无法翻译的文字过多时任务失败并说明原因，不会发布大半没翻译的结果。

**网络与服务错误**：限流（HTTP 429）时服务商的并发自动减半，恢复后逐步回升；网络超时和临时故障退避后重试。多个 Key 中某个失效、受限或余额不足时，它会暂停使用 10 分钟，其余 Key 继续完成任务；全部失效时任务停止并说明原因。Key 错误、模型不存在、账户余额不足等无法自动恢复的错误会立即失败并给出原因，修正设置后可重新处理。整个任务最多自动尝试 3 次，断点保证不重复翻译已完成的段落。

### 参数

“设置 → 翻译服务”中可以调整 Google 翻译和每个服务商的并发请求数；“设置 → 高级”中可以调整分段与组批参数和大模型的翻译提示词。新任务提交时会保存一份参数快照，修改设置不影响进行中的任务，手动重新处理时使用最新设置。

| 参数 | 默认值 | 范围 |
| --- | --- | --- |
| Google 翻译并发请求数 | 8 | 1–64 |
| Google 翻译每次请求最多字符 | 3,000 | 100–5,000 |
| 每个大模型服务商的并发请求数 | 100 | 1–2,000 |
| 大模型每段最多字符 | 4,000 | 100–32,000 |
| 大模型单次请求最多段数 | 8 | 1–64 |
| 大模型单次请求最多字符 | 8,000 | 500–100,000 |
| 大模型最大输出 tokens | 0（使用服务商默认值） | 0–1,000,000 |
| 单个文档最多同时发出的请求数 | 100 | 1–1,000 |
| 同时处理的文档数（通用设置） | 2 | 1–4 |

每个服务商还可以填写“附加请求参数”（JSON），合并进每个请求，例如 `{"temperature": 0.3}` 或关闭思考模式的参数。本机模型（Ollama、LM Studio 等 localhost 地址）不需要 Key。思考类模型写在正文中的 `<think>` 内容和单独返回的思考内容都不会混入译文。

## 构建

目前没有预编译的发行版，需要从源码构建。两个平台的构建脚本都会依次构建处理引擎、准备内置的 Python + BabelDOC 运行环境（首次需要下载约 1 GB 的依赖和模型），再构建应用并组装成可直接运行的目录。

### Windows

需要 Rust（MSVC 工具链）、.NET 10 SDK，以及带 C++ 工作负载的 Visual Studio 或 Build Tools（提供可再分发的 Visual C++ 运行库）。在 PowerShell 中：

```powershell
./apps/windows/build.ps1 -Zip
```

产物是 `apps/windows/dist/DocFlow/DocFlow.exe`（自包含，无需安装 .NET），`-Zip` 另外生成 `DocFlow-win-x64.zip`。脚本会：

- 以静态 C 运行库链接引擎，并把 Visual C++ 运行库放在内置的 `python.exe` 旁边（onnxruntime、PyMuPDF 等依赖它），使应用能在没有安装 VC++ 运行库的电脑上运行；
- 检查应用、引擎和 Python 运行环境中每个 `.exe/.dll/.pyd` 的依赖都能在干净的 Windows 上找到（`runtime/check-windows-dlls.py`），否则构建失败；
- 可选地用 Authenticode 签名所有未签名的二进制文件：`-SignPfx 证书.pfx`（密码放在 `DOCFLOW_SIGN_PASSWORD`）或 `-SignThumbprint <证书指纹>`，使用 RFC 3161 时间戳。签名后 SmartScreen 与“智能应用控制”不再拦截（新证书需要积累信誉）。

### macOS

需要 Xcode 15.3 或更高版本（或对应的 Command Line Tools）和 Rust：

```bash
bash apps/macos/build.sh --pkg
```

产物是 `apps/macos/dist/DocFlow.app`，`--pkg` 另外生成安装包 `DocFlow-macos-<arch>.pkg`（没有 Developer ID 时推荐用它分发）；`--dmg` 和 `--zip` 生成磁盘映像和 zip。默认为当前 Mac 的架构构建，`--arch x86_64` 可在 Apple 芯片上为 Intel Mac 构建（运行环境这一步需要 Rosetta）。

- 运行环境构建会检查每个二进制文件要求的最低系统版本不高于 macOS 14：在更新的 macOS 上构建时，pip 可能选到只支持新系统的 wheel，那样的构建会在 macOS 14 上无法导入。请在 macOS 14 上构建发行版（CI 即如此）。
- 没有 Developer ID 时使用临时（ad-hoc）签名：内置 Python 的每个二进制文件、引擎和应用都会由内向外重新签名并封存，构建时逐一严格校验，并拒绝指向包外的符号链接。“已损坏”只会出现在签名无效的应用上，这些检查保证构建出的应用签名有效。安装包只包含与签名时完全一致的应用（打包后会再校验一次），装好的应用不带下载隔离标记。
- 有 Apple Developer ID 时，可以签名并公证，用户打开时没有任何提示：

  ```bash
  xcrun notarytool store-credentials docflow --apple-id <Apple ID> --team-id <团队 ID> --password <App 专用密码>
  bash apps/macos/build.sh --sign "Developer ID Application: 姓名 (团队 ID)" \
      --installer-sign "Developer ID Installer: 姓名 (团队 ID)" --notarize docflow --pkg --dmg
  ```

  脚本由内向外以强化运行时和安全时间戳签名全部 Mach-O 文件（只有 Python 解释器带必要的例外权限），签名安装包，提交公证、等待结果并把公证票据装订到应用、安装包和磁盘映像上。

`.github/workflows/desktop.yml` 在 macOS 14（arm64 与 x86_64）和 Windows 上构建两个应用；配置了签名相关的仓库机密时自动签名和公证，没有时 macOS 只生成未签名的安装包，Windows 生成未签名的 zip。

## 架构

```text
apps/windows/   WinUI 3 应用（.NET 10、Windows App SDK、Fluent Design）
apps/macos/     SwiftUI 应用（macOS 14+，Swift Package + 组装 .app 的脚本）
apps/shared/    应用图标的生成脚本
engine/         docflow-engine：Rust 编写的处理引擎
  src/            文档库、调度、服务商与翻译池、MinerU、Typst 排版、BabelDOC 监管、JSON-RPC
  typeset/        期刊 PDF 的 Typst 模板与内置的 MiTeX（LaTeX 公式转 Typst）
  reader/         阅读视图的样式、脚本与 KaTeX
  native-pdf/     BabelDOC 适配脚本（在内置 Python 中运行）
  migrations/     SQLite 结构
  tests/          端到端测试与模拟服务商
runtime/        构建内置 Python 3.12 + BabelDOC 运行环境的脚本（Windows / macOS）
```

- **引擎**（`docflow-engine`）是应用启动的子进程，通过标准输入输出上逐行的 JSON-RPC 通信，日志写入文档库的 `logs/`。标准输入关闭时引擎自行退出，因此不会在应用退出后残留。
- **存储**：SQLite（WAL 模式）保存文档、处理记录、服务商配置和设置；文件保存在 `archives/`，全部使用随机的 ASCII 物理名，展示标题只存在数据库里。
- **服务商**：支持四种接口——OpenAI 兼容 Chat Completions、Azure OpenAI、Anthropic Messages、Gemini generateContent——以及各自的模型列表接口。Google 翻译和每个服务商各有一个全局共享的 FIFO 翻译池，并发上限可调，遇到限流自动收缩。
- **期刊 PDF**：由嵌入引擎的 Typst 0.15 排版，公式经 MiTeX 从 LaTeX 转换，无法转换的公式保留源码而不会让整篇失败。不依赖浏览器。
- **PDF 原生翻译**：引擎启动内置 Python 中的 BabelDOC 适配脚本，通过有界的 JSONL 管道交换段落；Python 进程不继承任何凭据，任务结束或取消时会被结束。
- **应用**：Windows 版用 WebView2 显示阅读视图和 PDF，用 Windows 凭据管理器保存 Key；macOS 版用 PDFKit 显示 PDF、WKWebView 显示阅读视图，用钥匙串保存 Key，任务完成时在后台发送通知，Dock 图标显示进行中的文档数。

### 引擎协议

请求 `{"id": 1, "method": "documents.list", "params": {…}}`，响应 `{"id": 1, "result": …}` 或 `{"id": 1, "error": {"code": "…", "message": "…"}}`；引擎另外推送没有 `id` 的通知：`event`（新的处理记录）、`document.changed`、`document.removed`。当前协议版本为 2。

| 方法 | 作用 |
| --- | --- |
| `engine.initialize` | 传入 API Key（`mineru`、`provider:<id>`），启动调度器，返回版本和全部设置 |
| `engine.shutdown` | 停止引擎（关闭标准输入效果相同） |
| `settings.get` / `settings.update` | 读取、修改偏好设置（含默认翻译服务）和翻译参数 |
| `secrets.set` / `secrets.verify` | 在内存中设置 Key；向 MinerU 验证 Key |
| `providers.save` / `providers.delete` | 新增或修改、删除大模型服务商 |
| `providers.models` / `providers.check` | 获取服务商的模型列表；用某个模型发送测试请求 |
| `google.check` | 测试能否访问 Google 翻译 |
| `documents.create` | 以本地文件路径、处理方式和翻译服务（`{"kind":"google"}` 或 `{"kind":"llm","provider_id":…,"model":…}`）新建任务 |
| `documents.list` / `documents.get` / `documents.events` | 列表与计数、单个文档及其文件路径、分页读取处理记录 |
| `documents.rename` / `retry` / `cancel` / `delete` | 重命名、重新处理、取消、删除 |
| `documents.exportBundle` | 把一个文档的全部文件和处理记录导出为 ZIP |

## 开发与测试

```bash
cargo test --manifest-path engine/Cargo.toml          # 引擎单元测试（分段、占位符修复、表格、服务商协议、Typst 排版…）
python engine/tests/e2e.py --engine engine/target/debug/docflow-engine \
    --resources runtime/build/<平台>/resources --work-dir <临时目录> [--mock] [--pdf <文本层 PDF>]
```

`e2e.py` 通过 JSON-RPC 驱动真实的引擎，不需要 API Key，也不产生费用：

- 默认设置 `DOCFLOW_FAKE_PROVIDERS=1`，用本地测试译文代替云端翻译，并用合成的 MinerU 结果走完 MinerU 路线；给出 `--resources` 和 `--pdf` 时还会用真实的 BabelDOC 运行环境完成一次 PDF 原生翻译。
- `--mock` 改为通过真实的 HTTP 请求访问本地的模拟服务（`engine/tests/mock_providers.py`：Google 免费接口、OpenAI 兼容、Anthropic、Gemini）。模拟服务会故意限流、截断输出、漏掉段落、改坏或删掉占位符、拒绝翻译，并返回错误的 Key 等，用来验证获取模型列表、多 Key 轮换和上面的每一级自动修复。

`engine/native-pdf/` 下另有 BabelDOC 适配层的单元测试和离线排版冒烟测试（见其中的 README）。

开发时可以直接运行应用：Windows 版在 Visual Studio 或 `dotnet build` 后运行，macOS 版在 `apps/macos` 中执行 `swift run`。两个应用都会自动使用 `engine/target` 下已构建的引擎和 `runtime/build` 下的运行环境；也可以用 `DOCFLOW_ENGINE`、`DOCFLOW_RESOURCES` 和 `DOCFLOW_DATA_DIR` 环境变量分别指定引擎、运行环境和文档库。想在应用里试用大模型流程而不花钱时，可以运行 `python engine/tests/mock_providers.py 8765 --open`，再添加一个 API 地址为 `http://127.0.0.1:8765/v1` 的自定义服务商。

## 许可

DocFlow 本身以 [MIT 许可证](LICENSE)发布。构建产物中内置的 BabelDOC 与 PyMuPDF 以 **GNU AGPL v3** 发布，因此包含 PDF 原生翻译运行环境的应用包整体不能视为仅适用 MIT；再分发或修改这些组件时须遵守其许可证与源码提供要求。期刊 PDF 由 Typst 排版，公式由 MiTeX 转换，阅读视图使用 KaTeX；Windows 版内置 Microsoft Visual C++ 可再分发运行库。各组件、字体与模型保留其原始许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
