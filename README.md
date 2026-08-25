# 文流（DocFlow）

文流是一个可自托管的文档解析、中文翻译与阅读服务。用户提交 MinerU 支持的 PDF、Office 文档、图片或 HTML 后，Rust Worker 在后台完成解析、WebP 图片转换、三档并发中文翻译、Markdown 规范化和 VPS 本地永久归档。极速档使用 Google Cloud Translation；均衡档使用 `deepseek-v4-flash` 非思考模式；精准档使用同一模型的思考模式。Google 与 DeepSeek 各有一个全站共享任务池，多篇文档可并行翻译且不会由单篇长文档独占队列。Cloudflare R2 是可选镜像，不是运行前提。

新文档默认私有，没有普通用户账户，也没有删除接口。上传响应会给当前浏览器设置每份文档独立的 HttpOnly 访问凭证；管理员在 `/admin` 能看到全部文档，并可逐份公开或恢复私有。管理后台固定在 `/admin`，前台不显示入口；首次访问后台的用户可以注册为唯一管理员。

## 架构

- Rust、Axum、Tokio：带文档级访问控制的 HTTP API、管理 API、上传流、SSE 实时进度和后台 Worker。
- SQLx、PostgreSQL：元数据、三种 Markdown、最终 HTML、管理员、加密配置、任务租约和不可删除的详细事件。
- PostgreSQL 持久队列：Worker 通过 `FOR UPDATE SKIP LOCKED` 并发领取任务，不再依赖 Redis/Celery。
- Tokio 全站翻译池：Google 与 DeepSeek 使用彼此独立的 FIFO 队列和并发执行槽；单篇文档还有独立的在途分块上限。
- VPS 当前目录：`./data` 绑定挂载 PostgreSQL、实例密钥、源文件、MinerU ZIP、三种 Markdown、HTML、WebP、事件和归档清单，不使用 Docker 命名卷。
- Cloudflare R2：可选的异地对象镜像；失败不会阻止本地任务发布，也不会触发本地删除。
- Vue 3、Vuetify、Vite：提交页、公开文库、阅读页、SSE 进度页和 `/admin` 管理后台。
- Nginx：同源反向代理、SSE 透传和 SPA 路由。

旧 Python/FastAPI 代码保留在 `backend/` 仅用于迁移审计，Compose 不再构建或运行它。

## 数据规则

- 新文档和处理事件默认私有：只有持有该文档浏览器凭证的上传者和管理员可读取；管理员主动公开后才会出现在公开文库。
- 文档详情、SSE 事件、Markdown、源文件、ZIP 和图片使用同一套权限判断，私有状态不是仅在列表中隐藏。
- Markdown 永久保存：数据库和本地 `.md` 文件同时持久化 MinerU 原稿、中文译稿和规范化终稿。
- 翻译分块可以并行完成，但会按原始序号合并；每块都独立校验公式、代码、图片和链接占位符。
- 图片不使用 MinerU 链接：本地或远程图片会下载、去重、转成 WebP，并改写为本站稳定 API 路径。
- 展示标题、原始上传名和可修改的下载名保存在 PostgreSQL；磁盘只使用随机 `storage_key`、UUID 目录与 `source.pdf` 等 ASCII 物理名。
- 管理员重命名只更新数据库映射，不移动或覆盖磁盘文件，也不改变图片 URL。
- `GET /api/v1/jobs/{id}/bundle` 按需生成完整 ZIP，统一包含源文件、Markdown、HTML、WebP 与元数据。
- 发布完成后只删除 `/data/work/{文档 UUID}` 中可再生的 MinerU 解压临时目录；`/data/archives` 永不自动清理。
- R2 未配置时照常上传和处理；配置后在本地归档完成后追加镜像与 `HeadObject` 校验。
- 历史 Redis 卷不会在升级中删除，但新架构不再挂载或运行 Redis。

## 工作流与进度

1. `0–4%`：流式上传、SHA-256、PostgreSQL 入队、并发 Worker 原子领取。
2. `5–52%`：申请 MinerU 上传地址、直传源文件、逐次轮询和页面进度。
3. `53–64%`：校验公网地址、分块下载 ZIP、防路径穿越和解压规模检查。
4. `65–70%`：扫描图片、逐张转 WebP、内容寻址去重、改写本站资源路径。
5. `71–87%`：执行任务创建时固定的三档翻译。极速档进入 Google 共享池；均衡档进入 DeepSeek 非思考池；精准档进入 DeepSeek 思考池。分块以 FIFO 排队、并行执行、按序合并；每次排队、服务调用、限流退避、占位符重译、完成数量和耗时都会写入永久事件。公式、代码、图片与链接连续三次无损校验失败时任务会明确报错，不发布损坏文章。
6. `88–93%`：统一公式定界符、中英文间距、CommonMark/GFM 解析和 HTML 白名单消毒。
7. `94–98%`：源文件、Markdown、HTML、WebP、MinerU ZIP 与元数据写入本地永久归档并生成清单。
8. `99–100%`：可选 R2 镜像；无 R2 或镜像失败时保留告警并正常发布，最后只清理可再生工作区。

每个细分步骤都会追加到 `processing_events`。网页通过 SSE 接收实时事件；REST 增量接口可在断线后从任意事件 ID 恢复。

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
GET  /api/v1/jobs/{id}/source             原始文件
GET  /api/v1/jobs/{id}/bundle             完整本地归档 ZIP
GET  /api/v1/jobs/{id}/assets/{name}      本地 WebP（R2 仅作回退）
```

示例：

```bash
curl -c docflow.cookies -F "file=@paper.pdf" -F "title=文档标题" -F "translation_tier=3" \
  http://你的服务器IP:38100/api/v1/jobs
```

上传响应中的 Cookie 是该私有文档的访问凭证。命令行后续读取进度或下载时使用 `-b docflow.cookies`。网页会自动管理该凭证。全站始终翻译为中文；`translation_tier` 可选 1–3，不传时采用管理员默认值，最终选择会在任务创建时固定。客户端提交的旧版 `translate` 字段会被兼容接收但忽略。

极速档使用 Google Cloud Translation Basic v2 官方接口，需要管理员配置已启用 Cloud Translation API 的 Google Cloud API Key。Google 每月前 50 万字符有抵扣额度，超出后按官方定价计费。均衡档和精准档需要 DeepSeek API Key，模型固定为 `deepseek-v4-flash`，不能由前端改成语义不明的其他模型。管理员设置上传页默认档位，访问者可以为单次任务选择任一已开放档位。

### 翻译并发与长度保护

- Google 官方建议单次请求最多 5,000 Unicode code points；本项目固定留出 10% 余量，单块最多 4,500 字符。
- Google Basic 默认内容配额为每项目、每用户每分钟 600 万字符，请求配额为每分钟 30 万次；项目内置限流器只使用其中 80%，即每分钟 480 万字符和 24 万次请求，并默认只开 32 个 HTTP 执行槽。
- DeepSeek 官方给 `deepseek-v4-flash` 的账号级并发上限为 2,500。程序硬钳制在 80%（2,000），但 VPS 默认只开 64 个执行槽。
- DeepSeek V4 Flash 上下文为 100 万 tokens，最大输出为 38.4 万 tokens。项目仍将均衡档单块限制为 12,000 字符、精准档限制为 8,000 字符，降低重试成本并为思考留出空间。
- DeepSeek 的 `max_tokens` 包含可见译文和思考 token；均衡档显式发送 `thinking: disabled`，精准档显式发送 `thinking: enabled` 并提高输出预算。
- 每篇文档默认最多有 8 个在途分块。服务端收到 429、5xx、网络超时或 `Retry-After` 时会指数退避并重新进入同一公平队列。
- Worker 启动时持有 PostgreSQL advisory lock，保证整个站点只有一个任务池所有者；不要使用 `docker compose up --scale worker=...` 横向复制 Worker。

以上限制依据 [Google Cloud Translation 配额](https://docs.cloud.google.com/translate/quotas)、[Google Cloud Translation 定价](https://cloud.google.com/products/translate/pricing)、[DeepSeek 限流说明](https://api-docs.deepseek.com/quick_start/rate_limit/)、[DeepSeek 模型与定价](https://api-docs.deepseek.com/quick_start/pricing) 和 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)；部署者调整并发环境变量时仍应根据自己的 VPS 资源和账号额度保守设置。

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
    └── documents/    # 源文件、Markdown、HTML、WebP、MinerU ZIP 与工作区
```

端口和并发等参数都有保守默认值；如需覆盖，可在同目录创建可选 `.env`，参考仓库中的 `.env.example`。MinerU、Google Cloud Translation、DeepSeek 和可选 R2 凭据始终在 `/admin` 中配置，而不是写入 Compose 或 `.env`。

管理员访问 `http://你的服务器IP:38100/admin`：

1. 首次注册唯一管理员；已有 Python 版本的 Argon2 密码可直接登录。
2. 配置并验证 MinerU API Key 与模型。
3. 配置并验证 Google Cloud Translation API Key 后开放极速档。
4. 配置并验证 DeepSeek API Key 后开放均衡档（V4 Flash 非思考）和精准档（V4 Flash 思考）；模型名称由系统固定。
5. 在“默认翻译档位”中设置上传页默认值；访问者仍可为单次任务选择其他已开放档位。
6. 如需异地镜像，可选配置 R2 Account ID、Access Key ID、Secret Access Key 和 Bucket。凭据在数据库中使用 `data/config/secret_key` 派生的 Fernet 密钥加密。
7. 在“文档管理”中查看全部文档、切换公开/私有状态，并修改展示标题与下载文件名；扩展名必须保持一致，后端物理路径不会变化。

Cloudflare R2 凭据应仅授予目标存储桶对象读写权限。应用没有 R2 删除调用，也不配置生命周期规则。

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

## 安全边界

- 新上传默认私有，但当前使用的是明文 HTTP；同网段攻击者仍可能窃取 Cookie 或管理员凭据。敏感材料应在配置 HTTPS 后使用。
- 管理员密码使用 Argon2，管理会话为 12 小时 HS256 JWT，并同步写入 HttpOnly、SameSite=Lax Cookie；数据库只保存文档访问凭证的 SHA-256 哈希。
- ZIP 解压限制路径、条目数与总大小；外链下载拒绝私网、回环和链路本地地址。
- HTML 由 Comrak 渲染，并经 Ammonia 白名单消毒。
- 当前入口是明文 IP + 端口。管理员填写凭据时应使用可信网络、VPN 或 SSH 隧道；长期公网运行建议后续增加域名和 HTTPS。
