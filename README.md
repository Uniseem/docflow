# 文流（DocFlow）

文流是一个可自托管的文档解析、中文翻译与阅读服务。上传时可选 **MinerU 文档转换** 或 **PDF 原生翻译（pdf2zh）**：前者输出 Markdown 阅读页和重新排版的 PDF，后者保留原 PDF 页面布局并输出中文 PDF 与双语 PDF。两条路线共享后台翻译设置、任务快照及全站 Google / DeepSeek 任务池，不需要为原生翻译另配密钥。所有文件永久保存在本地，Cloudflare R2 仅是可选镜像。

极速档使用 Google Cloud Translation；均衡档使用 `deepseek-v4-flash` 非思考模式；精准档使用同一模型的思考模式。多个文档、两条处理路线的请求合计受同一个服务池并发上限约束。

新文档默认私有，没有普通用户账户，也没有删除接口。上传响应会给当前浏览器设置每份文档独立的 HttpOnly 访问凭证；管理员在 `/admin` 能看到全部文档，并可逐份公开或恢复私有。管理后台固定在 `/admin`，前台不显示入口；首次访问后台的用户可以注册为唯一管理员。

## 架构

- Rust、Axum、Tokio：带文档级访问控制的 HTTP API、管理 API、上传流、SSE 实时进度和后台 Worker。
- SQLx、PostgreSQL：元数据、三种 Markdown、最终 HTML、PDF 路径与大小、管理员、加密配置、任务租约和不可删除的详细事件。
- PostgreSQL 持久队列：Worker 通过 `FOR UPDATE SKIP LOCKED` 并发领取任务，不再依赖 Redis/Celery。
- Tokio 全站翻译池：Google 与 DeepSeek 使用彼此独立的 FIFO 队列和并发执行槽；多个分段可合并为一个请求，单篇文档还有独立的在途请求上限。管理员可在后台调整两个池的并发、分段长度、每请求段数和全局翻译提示词。
- Python / BabelDOC 0.6.4：pdf2zh-next 使用的原生 PDF 排版内核，在受管控的独立进程中执行 CPU 版面分析与译文回填。它不持有云服务密钥，也不直接调用 Google / DeepSeek；通过有界 JSONL 管道把段落交给 Rust 的现有翻译池。
- VPS 当前目录：`./data` 绑定挂载 PostgreSQL、实例密钥、源文件、MinerU ZIP、三种 Markdown、期刊排版 PDF、HTML、WebP、事件和归档清单，不使用 Docker 命名卷。
- Cloudflare R2：可选的异地对象镜像；失败不会阻止本地任务发布，也不会触发本地删除。
- Vue 3、Ant Design Vue、Vite：提交页、公开文库、阅读页、SSE 进度页和 `/admin` 管理后台；界面使用标准 Ant Design 的布局、表单、表格和反馈组件。
- Nginx：同源反向代理、SSE 透传和 SPA 路由。

旧 Python/FastAPI 代码保留在 `backend/` 仅用于迁移审计，Compose 不再构建或运行它。

## 两种处理方式

| | MinerU 文档转换 | PDF 原生翻译（pdf2zh） |
| --- | --- | --- |
| 输入 | MinerU 支持的 PDF、Office、图片、HTML | 带可用文本层、未加密的 PDF |
| 版面 | 解析为 Markdown，再生成统一版式 PDF | 尽量保持原文页面布局、尺寸、图像及公式 |
| 下载 | Markdown、PDF、完整文件包 | 中文 PDF、双语对照 PDF、完整文件包 |
| 阅读页 | 默认渲染 Markdown | 显示文件与处理记录，点击后才在新窗口预览 PDF |
| MinerU 密钥 | 需要 | 不需要 |
| 翻译与存储 | 共用三档服务、全站池、后台参数；本地永久归档 | 与左侧完全相同，无第二套翻译配置 |

原生模式使用 [BabelDOC 0.6.4](https://github.com/funstory-ai/BabelDOC/releases/tag/v0.6.4)，不是把 pdf2zh 的 Web 服务再部署一套。选择它是为了把 pdf2zh-next 的排版能力接到本项目的统一调度中；接口按精确版本固定并有契约测试，升级不能直接换成 `latest`。[pdf2zh-next 上游说明](https://pdf2zh-next.com/)

扫描页、仅含页码文本的扫描件、无文本层或加密 PDF 会停止原生处理，提示改用 MinerU 或先解密，不会悄悄当作成功。混合扫描文档也建议使用 MinerU。当前采用逐段文本回填，关闭上游额外的 LLM 组批、术语抽取和跨页段落拼接，以免绕过全站设置。复杂行内粗斜体等富文本不保证逐项复刻；竖排及无法提取的文字也不适合此模式。

## 数据规则

- 新文档和处理事件默认私有：只有持有该文档浏览器凭证的上传者和管理员可读取；管理员主动公开后才会出现在公开文库。
- 文档详情、SSE 事件、Markdown、源文件、ZIP 和图片使用同一套权限判断，私有状态不是仅在列表中隐藏。
- MinerU 的 Markdown 永久保存：数据库和本地 `.md` 文件同时持久化原稿、中文译稿和规范化终稿。原生路线不伪造 Markdown、HTML 或 MinerU ZIP；这些字段为空是正常情况。
- MinerU 的 PDF 在 Worker 内使用本地 Chromium 打印；KaTeX、字体和图片均来自容器或永久目录，不依赖外部 CDN。版式包含 A4 版心、衬线中英文字体、摘要区、分级标题、表格/图片分页控制、页眉和页码。
- 原生路线生成与原文页数相同的中文 PDF，以及原文/译文交替排列、页数为原文两倍的双语 PDF；两份 PDF 均须通过页数、页面尺寸、逐页解析与文件完整性检查。任何段落回调错误或排版错误都会使本次任务失败，不发布部分未翻译的结果。
- Chromium 以非特权用户运行，每次 PDF 渲染使用独立且可写的临时配置、缓存和用户数据目录；单次浏览器异常会在 PDF 阶段内使用全新运行目录重试，不必立即重跑整份文档。
- 翻译分块可以并行完成，但会按原始序号合并；每块都独立校验公式、代码、图片和链接占位符。常见的空格、反引号、编号改写或重复编号会按原文顺序在本地无损修复；仍无法确认时自动改为“保护内容留在本机、只翻译普通文本片段”的隔离模式。
- 每个通过校验的译文分块都会写入工作目录断点，并校验源文本、翻译档位与本次翻译配置是否一致。网络、服务或后续步骤失败导致任务重跑时复用相符的断点；更换提示词后不会误用旧译文。发布成功后才随可再生工作区一起清理。
- 图片不使用 MinerU 链接：本地或远程图片会下载、去重、转成 WebP，并改写为本站稳定 API 路径。
- 展示标题、原始上传名和可修改的下载名保存在 PostgreSQL；磁盘只使用随机 `storage_key`、UUID 目录与 `source.pdf` 等 ASCII 物理名。
- 管理员重命名只更新数据库映射，不移动或覆盖磁盘文件，也不改变图片 URL。
- `GET /api/v1/jobs/{id}/pdf` 下载本任务的主 PDF：MinerU 返回重新排版 PDF，原生任务返回中文 PDF；原生任务的 `?variant=dual` 返回双语 PDF。`GET /api/v1/jobs/{id}/bundle` 包含源文件、该模式全部已有产物与元数据。
- 原生输出只进入 `archives/{storage_key}/pdf2zh/mono.pdf` 和 `dual.pdf`，不写入公开静态目录。下载与主动预览均走原有文档鉴权，展示文件名由数据库生成，不影响磁盘路径。
- 发布完成后只删除 `/data/work/{文档 UUID}` 中可再生的 MinerU 解压临时目录；`/data/archives` 永不自动清理。
- R2 未配置时照常上传和处理；配置后在本地归档完成后追加镜像与 `HeadObject` 校验。
- 历史 Redis 卷不会在升级中删除，但新架构不再挂载或运行 Redis。

## 工作流与进度

MinerU 路线：

1. `0–4%`：流式上传、SHA-256、PostgreSQL 入队、并发 Worker 原子领取。
2. `5–52%`：申请 MinerU 上传地址、直传源文件、逐次轮询和页面进度。
3. `53–64%`：校验公网地址、分块下载 ZIP、防路径穿越和解压规模检查。
4. `65–70%`：扫描图片、逐张转 WebP、内容寻址去重、改写本站资源路径。
5. `71–87%`：按任务创建时固定的档位、分段参数和提示词翻译。极速档进入 Google 共享池；均衡档和精准档共用 DeepSeek 池，分别使用非思考和思考模式。分段按配置组批，FIFO 排队、并行执行、按原始序号合并；每次排队、服务调用、限流退避、标记自愈、隔离降级、断点复用、完成数量和耗时都会写入永久事件。整块翻译连续无法通过无损校验时，程序不发布损坏文章，而是把公式、代码、图片和链接留在本地，仅翻译中间的普通文本后原位拼回。
6. `88–93%`：统一公式定界符、中英文间距、CommonMark/GFM 解析、HTML 白名单消毒，并使用本地 KaTeX 与 Chromium 生成 A4 期刊排版 PDF。
7. `94–98%`：源文件、Markdown、PDF、打印版 HTML、WebP、MinerU ZIP 与元数据写入本地永久归档并生成清单。
8. `99–100%`：可选 R2 镜像；无 R2 或镜像失败时保留告警并正常发布，最后只清理可再生工作区。

每个细分步骤都会追加到 `processing_events`。网页通过 SSE 接收实时事件；REST 增量接口可在断线后从任意事件 ID 恢复。

原生路线共用接收、归档和发布步骤，中间阶段为：`5–9%` 文本层检查；`10–29%` 页面、表格、段落和公式分析；`30–79%` 共享池分段翻译；`80–89%` 译文回填、字体与绘制指令；`90–93%` 双 PDF 校验。页面显示具体阶段计数、组批信息、队列等待时间、服务耗时、重试和断点复用。

排版回调凑不满一批时约 25 ms 后即允许提交，避免“每次最多段数”大于排版线程数时相互等待。PDF 公式和样式标记会先在 Rust 保护，译文校验后恢复并按原段落编号回填。原生模式只修复标记的大小写和空格等形式差异；编号或顺序变化时转入隔离重译，不按位置重编号，以免调换公式的语义。重试优先复用匹配当前提示词、档位和分段参数的已验证段落断点；原生缓存与 Markdown 缓存隔离。

## 开放 API

机器可读规范：`GET /api/openapi.json`  
人类可读说明：`GET /api/docs`

主要 v1 接口：

```text
POST /api/v1/jobs                         multipart 创建任务
GET  /api/v1/jobs                         管理员主动公开的任务列表
GET  /api/v1/jobs/{id}                    状态与最终文章（私有任务需 Cookie）
GET  /api/v1/jobs/{id}/events             永久事件增量读取
GET  /api/v1/jobs/{id}/events/stream      SSE 实时进度
GET  /api/v1/jobs/{id}/markdown           original/translated/normalized
GET  /api/v1/jobs/{id}/pdf                主 PDF，或 ?variant=journal|mono|dual
GET  /api/v1/jobs/{id}/source             原始文件
GET  /api/v1/jobs/{id}/bundle             含 PDF 的完整本地归档 ZIP
GET  /api/v1/jobs/{id}/assets/{name}      本地 WebP（R2 仅作回退）
```

示例：

```bash
curl -c docflow.cookies -F "file=@paper.pdf" -F "title=文档标题" -F "translation_tier=3" \
  http://你的服务器IP:38100/api/v1/jobs
```

上传响应中的 Cookie 是该私有文档的访问凭证。命令行后续读取进度或下载时使用 `-b docflow.cookies`。网页会自动管理该凭证。全站始终翻译为中文；`translation_tier` 可选 1–3，不传时采用管理员默认值，最终选择会在任务创建时固定。客户端提交的旧版 `translate` 字段会被兼容接收但忽略。

原生模式在同一上传请求中增加 `-F "processing_mode=pdf2zh"`。`processing_mode` 省略时仍使用 `mineru`，已有任务也保留 MinerU 模式；模式创建后不可改变，重新选择模式需提交新任务。原生任务只接受 PDF，不依赖 MinerU Key；两条路线都至少需要一个已配置的翻译服务。

`GET /api/config/public` 的 `processing_modes` 分别报告可用性与允许的扩展名。旧字段 `accepting_uploads` 只代表默认 MinerU 模式，不应用它阻止原生模式。详情中的 `pdf_variants_available: {journal, mono, dual}` 和 `markdown_available` 用于判断已有产物。`?inline=true` 仅改变 PDF 的浏览器显示方式，不放宽访问权限。

极速档使用 Google Cloud Translation Basic v2 官方接口，需要管理员配置已启用 Cloud Translation API 的 Google Cloud API Key。Google 每月前 50 万字符有抵扣额度，超出后按官方定价计费。均衡档和精准档需要 DeepSeek API Key，模型固定为 `deepseek-v4-flash`，不能由前端改成语义不明的其他模型。管理员设置上传页默认档位，访问者可以为单次任务选择任一已开放档位。

### 翻译并发与长度保护

管理员在 `/admin` 的翻译运行参数中分别配置两个服务。这里的“每次提交”指 Worker 发给翻译服务的一次 HTTP 请求，不是用户一次上传可提交的文件数；“段”指按长度切出的翻译分段。

| 参数 | Google 极速档 | DeepSeek 均衡档与精准档 |
| --- | --- | --- |
| 全站并发请求数 | 默认 32；范围 1–256 | 默认 64；范围 1–2,000，两档合计 |
| 每段最长字符数 | 默认 4,000；范围 100–4,000 | Compose 默认 12,000；范围 100–12,000 |
| 每次请求最多提交段数 | 默认 4；范围 1–100 | 默认 4；范围 1–64 |

每篇文档的在途请求数另设全局上限，默认 8，可设为 1–32。字符数按 Unicode code points 计算，不按 UTF-8 字节或中文“词”计算。段数和段长都是上限：不足一批会直接提交，超过请求体或模型预算会自动拆成更小的批次。

- Google Basic v2 的单次请求硬限制是 100 KB，本项目将实际 JSON 请求体控制在 80,000 字节以内。官方另建议每次请求不超过 5,000 字符以降低延迟，这不是硬限制；需要低延迟时可降低每批段数或段长。[Google Cloud Translation 配额](https://docs.cloud.google.com/translate/quotas)
- Google 官方未为 Basic 文本翻译单列并发连接上限；256 是本项目的应用安全阈值，不是 Google 的额度承诺。内置分钟限流器按默认配额预留 20% 余量，最多每分钟 480 万字符、24 万次请求；实际仍受账号自定义配额和同一项目其他调用影响。[Google Cloud Translation 配额](https://docs.cloud.google.com/translate/quotas)
- DeepSeek 的 2,000 上限取 `deepseek-v4-flash` 官方账号级 2,500 并发的 80%。均衡档、精准档共用这一个池；同账号在其他应用中的请求也计入官方总额，应相应调低后台并发。[DeepSeek 限流说明](https://api-docs.deepseek.com/quick_start/rate_limit/)
- DeepSeek V4 Flash 的上下文窗口为 100 万 tokens，最大输出为 38.4 万 tokens。本项目把每批待译正文控制在 32,000 字符以内；同时以 UTF-8 字节数保守估计提示词和输入的 token 用量，再计入输出预算与协议余量，控制在上下文窗口的 80% 以内，输出预算也不超过官方最大值的 80%。超出任一预算会拆批，不能把“每段字符数 × 每批段数”直接当成模型可以接收的 token 数。[DeepSeek 模型与定价](https://api-docs.deepseek.com/quick_start/pricing/)
- 均衡档显式关闭思考，精准档显式开启思考；思考模式会预留更大的输出预算，返回的思考过程不混入译文。[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- 收到限流、可重试的服务故障、网络超时或 `Retry-After` 时，任务会退避后重新进入同一队列。整份任务最多自动尝试 3 次；最终失败时继续保留源文件、事件和翻译断点，管理员可以修复配置后手动重试。
- Worker 启动时持有 PostgreSQL advisory lock，保证整个站点只有一个翻译池所有者；不要使用 `docker compose up --scale worker=...` 横向复制 Worker。锁由独立连接持有并定期检查，锁连接失效时会停止本进程的 Worker 和翻译池，退出后由 Compose 重启并重新竞争锁。

### 全局翻译提示词与生效时机

后台可编辑 1–12,000 个 Unicode 字符的全局系统提示词。两条路线的 DeepSeek 两档每次翻译请求、拆分请求和请求重试都会使用该任务固定的提示词。可填写术语、语气和格式要求。程序会在其后追加不可编辑的结构保护规则及批次输出协议：MinerU 保护 Markdown、公式、代码和链接；原生路线只翻译段落，禁止额外生成 Markdown 标题/围栏，并恢复 PDF 公式与样式标记。Google Basic v2 没有系统提示词参数，因此该项不影响极速档。

运行参数作为一份 JSON 原子写入 PostgreSQL，避免读到一半新、一半旧的配置。全局提示词只通过已登录的管理接口读取，不在公开配置、任务响应或事件中下发。

- **两个池的并发数**：Worker 正常运行时约每 2 秒同步后台设置，无需重启。调低上限时已发出的请求继续完成，新请求等待空位；暂时读取失败时沿用上次有效并发，恢复连接后继续同步。
- **段长、每批段数、单文档并发和提示词**：新任务提交时保存快照。修改后台设置不会改变正在处理或等待自动重试的任务，自动重试继续使用原快照。
- **管理员手动重试**：失败任务保留原档位，但改用重试时的最新运行参数与提示词；只复用与新配置匹配的断点。
- **旧任务**：升级前尚无快照的任务首次进入翻译阶段时补写快照，此后按同一规则重试。
- **环境变量**：只用于未保存后台运行配置时的初始值。已有后台配置优先；修改 `.env` 不会覆盖已保存的设置。直接运行服务器、不使用 Compose 时，DeepSeek 初始段长为 10,000；本 README 的 Compose 显式设为 12,000。

管理 API（需要管理员 Cookie 或 Bearer token）：

```text
GET /api/admin/settings
    返回 translation_runtime、translation_runtime_defaults、translation_runtime_limits
PUT /api/admin/settings/translation-runtime
    整体校验并保存运行参数，返回更新后的管理设置
```

`PUT` 请求体示例（直接提交对象，不要再包一层 `translation_runtime`）：

```json
{
  "google": {
    "concurrency": 32,
    "chunk_chars": 4000,
    "max_segments_per_request": 4
  },
  "deepseek": {
    "concurrency": 64,
    "chunk_chars": 12000,
    "max_segments_per_request": 4
  },
  "per_document_concurrency": 8,
  "system_prompt": "请将输入内容忠实翻译为简体中文，统一术语，不添加解释。"
}
```

越界、缺少字段、类型错误或未知字段会返回 HTTP 400，原配置保持不变。上述硬限制不替代账号额度管理；应根据 VPS 资源、实际限流和调用费用逐步调整。

## VPS 一键部署

默认监听所有网卡的 `38100` 端口，部署后访问 `http://你的服务器IP:38100`。VPS 只需要 Docker Engine 和 Docker Compose，不需要 Git、Rust、Node 或手工创建 `.env`。Compose 直接拉取 GHCR 公共镜像，首次启动自动生成数据库密码与实例密钥，已有密钥永不覆盖；域名、HTTPS 和反向代理由部署者按需配置。

```bash
mkdir -p /opt/docflow && cd /opt/docflow
curl -fsSLO https://raw.githubusercontent.com/FengYuchen1314/docflow/main/docker-compose.yml
docker compose up -d
```

### 手动创建 `docker-compose.yml`（完整内容）

不需要克隆仓库。可以在 VPS 的任意空目录中手动新建 `docker-compose.yml`，完整复制下面的内容。以下代码块与仓库根目录的 `docker-compose.yml` 保持一致：

```yaml
name: docflow

x-logging: &default_logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "5"

x-backend-environment: &backend_environment
  APP_NAME: ${APP_NAME:-文流}
  DATABASE_HOST: db
  DATABASE_PORT: "5432"
  DATABASE_NAME: ${POSTGRES_DB:-docflow}
  DATABASE_USER: ${POSTGRES_USER:-docflow}
  DATABASE_PASSWORD_FILE: /run/docflow/postgres_password
  SECRET_KEY_FILE: /run/docflow/secret_key
  DATA_ROOT: /data
  MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-200}
  TRANSLATION_CHUNK_CHARS: ${TRANSLATION_CHUNK_CHARS:-12000}
  TRANSLATION_PER_DOCUMENT_CONCURRENCY: ${TRANSLATION_PER_DOCUMENT_CONCURRENCY:-8}
  TRANSLATION_QUEUE_CAPACITY: ${TRANSLATION_QUEUE_CAPACITY:-4096}
  GOOGLE_TRANSLATION_CONCURRENCY: ${GOOGLE_TRANSLATION_CONCURRENCY:-32}
  DEEPSEEK_TRANSLATION_CONCURRENCY: ${DEEPSEEK_TRANSLATION_CONCURRENCY:-64}
  MINERU_POLL_SECONDS: ${MINERU_POLL_SECONDS:-5}
  MINERU_MAX_WAIT_SECONDS: ${MINERU_MAX_WAIT_SECONDS:-7200}
  WEBP_QUALITY: ${WEBP_QUALITY:-88}
  PDF_RENDER_TIMEOUT_SECONDS: ${PDF_RENDER_TIMEOUT_SECONDS:-180}
  PDF2ZH_CONCURRENCY: ${PDF2ZH_CONCURRENCY:-1}
  PDF2ZH_TIMEOUT_SECONDS: ${PDF2ZH_TIMEOUT_SECONDS:-7200}
  DATABASE_POOL_SIZE: ${DATABASE_POOL_SIZE:-20}
  PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-}"
  RUST_LOG: ${RUST_LOG:-docflow_server=info,tower_http=info}
  TZ: ${TZ:-Asia/Shanghai}

services:
  # 第一次启动时生成实例密钥，并准备宿主机持久化目录。已有文件永不覆盖。
  init:
    image: alpine:3.22
    restart: "no"
    logging: *default_logging
    user: "0:0"
    command:
      - /bin/sh
      - -ec
      - |
        mkdir -p /config /documents/archives /documents/work
        if [ ! -s /config/secret_key ]; then
          head -c 64 /dev/urandom | sha256sum | cut -d ' ' -f 1 > /config/secret_key
        fi
        if [ ! -s /config/postgres_password ]; then
          head -c 64 /dev/urandom | sha256sum | cut -d ' ' -f 1 > /config/postgres_password
        fi
        chmod 755 /config /documents
        chmod 644 /config/secret_key /config/postgres_password
        if [ ! -e /config/documents_permissions_v1 ]; then
          chown -R 10001:10001 /documents
          touch /config/documents_permissions_v1
        fi
    volumes:
      - type: bind
        source: ./data/config
        target: /config
      - type: bind
        source: ./data/documents
        target: /documents

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    logging: *default_logging
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-docflow}
      POSTGRES_USER: ${POSTGRES_USER:-docflow}
      POSTGRES_PASSWORD_FILE: /run/docflow/postgres_password
      TZ: ${TZ:-Asia/Shanghai}
    depends_on:
      init:
        condition: service_completed_successfully
    volumes:
      - type: bind
        source: ./data/postgres
        target: /var/lib/postgresql/data
      - type: bind
        source: ./data/config
        target: /run/docflow
        read_only: true
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-docflow} -d ${POSTGRES_DB:-docflow}"]
      interval: 5s
      timeout: 5s
      retries: 20

  migrate:
    image: ghcr.io/fengyuchen1314/docflow-server:latest
    pull_policy: always
    environment: *backend_environment
    command: ["migrate"]
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - type: bind
        source: ./data/documents
        target: /data
      - type: bind
        source: ./data/config
        target: /run/docflow
        read_only: true
    restart: "on-failure:5"
    logging: *default_logging

  api:
    image: ghcr.io/fengyuchen1314/docflow-server:latest
    pull_policy: always
    restart: unless-stopped
    logging: *default_logging
    environment: *backend_environment
    command: ["api"]
    depends_on:
      migrate:
        condition: service_completed_successfully
    volumes:
      - type: bind
        source: ./data/documents
        target: /data
      - type: bind
        source: ./data/config
        target: /run/docflow
        read_only: true
    healthcheck:
      test: ["CMD", "docflow-server", "healthcheck"]
      interval: 10s
      timeout: 5s
      retries: 12

  worker:
    image: ghcr.io/fengyuchen1314/docflow-server:latest
    pull_policy: always
    restart: unless-stopped
    logging: *default_logging
    environment:
      <<: *backend_environment
      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-3}
    command: ["worker"]
    depends_on:
      migrate:
        condition: service_completed_successfully
    volumes:
      - type: bind
        source: ./data/documents
        target: /data
      - type: bind
        source: ./data/config
        target: /run/docflow
        read_only: true

  web:
    image: ghcr.io/fengyuchen1314/docflow-web:latest
    pull_policy: always
    restart: unless-stopped
    logging: *default_logging
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "0.0.0.0:${HTTP_PORT:-38100}:80"
    volumes:
      - type: bind
        source: ./data/documents
        target: /data
        read_only: true
```

保存文件后，在同一目录启动并查看容器状态：

```bash
docker compose up -d
docker compose ps
```

默认监听端口为 `38100`，无需指定服务器 IP。如需修改，只需在同目录创建 `.env`：

```dotenv
HTTP_PORT=9000
```

`PUBLIC_ORIGIN` 默认留空，OpenAPI 会使用相对地址并自动跟随当前 IP、域名或反向代理入口。如确实需要在 OpenAPI 中固定绝对地址，可另外设置 `PUBLIC_ORIGIN=https://你的域名`。

运行后目录即完整实例：

```text
/opt/docflow/
├── docker-compose.yml
└── data/
    ├── config/       # 实例密钥与 PostgreSQL 密码
    ├── postgres/     # 完整 PostgreSQL 数据目录
    └── documents/    # 源文件、Markdown、PDF、HTML、WebP、MinerU ZIP 与工作区
```

端口、Worker 文档并发等启动参数都有保守默认值；如需覆盖，可在同目录创建可选 `.env`，参考仓库中的 `.env.example`。翻译池并发、分段、批次和提示词应在 `/admin` 保存，无需编辑 Compose 或重启服务。MinerU、Google Cloud Translation、DeepSeek 和可选 R2 凭据也始终在 `/admin` 中配置，而不是写入 Compose 或 `.env`。

原生排版的 ONNX 模型、字体、CMap 与 tokenizer 资源在镜像构建时下载并校验，任务期间禁止 Python 排版进程主动访问外网；因此新版服务端镜像和首次构建会比仅 MinerU 的版本大。无需新增服务、额外端口或 GPU。`PDF2ZH_CONCURRENCY` 是本机同时排版的 PDF 数（默认 1，范围 1–4），不是另一个翻译并发池；`PDF2ZH_TIMEOUT_SECONDS` 是单次原生执行的总时限（默认 7,200 秒，范围 300–14,400）。应先观察 VPS 的内存与 CPU 再提高本机并行数。等待排版位和云服务时都会续租，超时或 Worker 停止会关闭子进程，保留源文件及断点供重试。

管理员访问 `http://你的服务器IP:38100/admin`：

1. 首次注册唯一管理员；已有 Python 版本的 Argon2 密码可直接登录。
2. 使用 MinerU 路线时配置并验证 MinerU API Key 与模型；只用 PDF 原生翻译可以跳过。
3. 配置并验证 Google Cloud Translation API Key 后开放极速档。
4. 配置并验证 DeepSeek API Key 后开放均衡档（V4 Flash 非思考）和精准档（V4 Flash 思考）；模型名称由系统固定。
5. 在“默认翻译档位”中设置上传页默认值；访问者仍可为单次任务选择其他已开放档位。
6. 在翻译运行参数中分别设置 Google、DeepSeek 的并发、每段字数和每请求段数；按需调整单文档并发与全局系统提示词，保存后会显示实际生效规则。
7. 如需异地镜像，可选配置 R2 Account ID、Access Key ID、Secret Access Key 和 Bucket。凭据在数据库中使用 `data/config/secret_key` 派生的 Fernet 密钥加密。
8. 在“文档管理”中查看全部文档、切换公开/私有状态，并修改展示标题与下载文件名；扩展名必须保持一致，后端物理路径不会变化。

Cloudflare R2 凭据应仅授予目标存储桶对象读写权限。**存储桶必须保持私有**：镜像包含私有文档，请关闭公开访问、`r2.dev` 和公开自定义域名，后台旧版“公开域名”字段建议留空。应用只能保护经本站下载接口的访问，不能保护公开桶的对象直链。应用没有 R2 删除调用，也不配置生命周期规则。

## 运维与备份

```bash
docker compose ps
docker compose logs -f api worker
curl --fail http://127.0.0.1:38100/api/health
```

完整迁移或冷备份时先停服务，再打包 Compose 与整个 `data` 目录：

```bash
cd /opt/docflow
docker compose stop
tar -czf ../docflow-backup-$(date +%Y%m%d-%H%M%S).tar.gz docker-compose.yml data
docker compose start
```

在新 VPS 原样解压后执行 `docker compose up -d` 即可恢复。不要只复制 `documents`：数据库、加密凭据和文件路径映射需要作为同一实例一起迁移。R2 若已配置，只是额外镜像，不替代本地 `data` 备份。

首次启动会幂等创建旧版 Alembic 基础表，再执行 Rust 的 SQLx 增量迁移；因此全新空库和旧版数据库都可直接启动。现有 SQLx 迁移文件不会改写，不会触发历史迁移 checksum 冲突。所有数据库变更均为非破坏性操作，不提供降级或删除逻辑。

## 发布前验证

GitHub Actions 在发布镜像前并行检查前后端。前端使用与生产构建一致的 Node.js 24，执行 `npm ci`、`npm test`、Vue/TypeScript 类型检查和 Vite 构建；后端执行 Rust 格式、测试、Clippy、全新数据库迁移、重复迁移和非特权 Chromium PDF 渲染检查。另有真实 PostgreSQL 集成检查，验证单连接池可启动 Worker、第二个 Worker 无法取得同一全站锁、锁连接被终止后原 Worker 有限时退出。运行参数的 HTTP 集成检查会验证管理员权限、边界与 Unicode 字符计数、配置原子保存、两条路线的任务快照、手动重试、下载权限和公开接口的提示词隔离。两个检查任务全部通过才会发布任何镜像。

原生引擎另有 Python 标准库测试与 BabelDOC 0.6.4 的实际 API 契约检查。`server/native-pdf/smoke.py` 用本地确定性测试译文走真实 CPU 排版，检查中文字体、两栏、矢量图、页数、尺寸、原译双语对照，以及回调失败、扫描件和加密文件拒绝。CI 在非特权、`--network none` 容器中执行它，既验证离线资源完整，也不产生翻译服务费用。它验证运行链路与产物，不替代真实翻译质量评估。

集成检查只连接 CI 临时 PostgreSQL。独占锁检查在没有文档、管理员和服务密钥的空库中启动临时 Worker；运行参数 HTTP 检查随后只启动 API，不启动 Worker，测试密钥直接写入该临时库作为非真实 fixture。两者均不调用 MinerU、Google 或 DeepSeek，不产生翻译费用。不要把 `scripts/worker-pool-smoke.py` 或 `scripts/translation-runtime-smoke.py` 指向已有实例或真实业务数据库。README 中的 Compose 复制块由 `python3 scripts/verify-compose-readme.py` 校验，与根目录文件逐字一致。

## 安全边界

- 新上传默认私有，但当前使用的是明文 HTTP；同网段攻击者仍可能窃取 Cookie 或管理员凭据。敏感材料应在配置 HTTPS 后使用。
- 管理员密码使用 Argon2，管理会话为 12 小时 HS256 JWT，并同步写入 HttpOnly、SameSite=Lax Cookie；数据库只保存文档访问凭证的 SHA-256 哈希。
- ZIP 解压限制路径、条目数与总大小；外链下载拒绝私网、回环和链路本地地址。
- HTML 由 Comrak 渲染，并经 Ammonia 白名单消毒。
- 原生排版子进程不继承数据库、实例或翻译密钥；进出消息、回调数量和日志尾部均有上限。解析器仍处理不可信 PDF，Python 侧网络保护不等同于完整系统沙箱，应保持非特权容器运行并及时更新安全修复。
- 当前入口是明文 IP + 端口。管理员填写凭据时应使用可信网络、VPN 或 SSH 隧道；长期公网运行建议后续增加域名和 HTTPS。

## 开源组件与许可

本仓库原有代码的 MIT 许可证保留不变。原生 PDF 镜像同时包含 **AGPL-3.0** 的 BabelDOC / PyMuPDF 等组件，不能将整个镜像理解为仅适用 MIT。上游版本、源码入口、许可证及本项目适配说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。部署、再分发或修改这些组件时须遵守其对应许可证与源码提供要求；网页页脚提供源码和许可入口。
