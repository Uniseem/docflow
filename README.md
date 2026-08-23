# 文流（DocFlow）

文流是一个可自托管的公开文档解析、中文翻译与阅读服务。用户提交 MinerU 支持的 PDF、Office 文档、图片或 HTML 后，Rust Worker 在后台完成解析、WebP 图片转换、DeepSeek 分块翻译、Markdown 规范化和 VPS 本地永久归档。Cloudflare R2 是可选镜像，不是运行前提。

站点默认公开，没有普通用户账户，也没有删除接口。管理后台固定在 `/admin`，前台不显示入口；首次访问后台的用户可以注册为唯一管理员。

## 架构

- Rust、Axum、Tokio：公开 HTTP API、管理 API、上传流、SSE 实时进度和后台 Worker。
- SQLx、PostgreSQL：元数据、三种 Markdown、最终 HTML、管理员、加密配置、任务租约和不可删除的详细事件。
- PostgreSQL 持久队列：Worker 通过 `FOR UPDATE SKIP LOCKED` 并发领取任务，不再依赖 Redis/Celery。
- VPS 当前目录：`./data` 绑定挂载 PostgreSQL、实例密钥、源文件、MinerU ZIP、三种 Markdown、HTML、WebP、事件和归档清单，不使用 Docker 命名卷。
- Cloudflare R2：可选的异地对象镜像；失败不会阻止本地任务发布，也不会触发本地删除。
- Vue 3、Vuetify、Vite：提交页、公开文库、阅读页、SSE 进度页和 `/admin` 管理后台。
- Nginx：同源反向代理、SSE 透传和 SPA 路由。

旧 Python/FastAPI 代码保留在 `backend/` 仅用于迁移审计，Compose 不再构建或运行它。

## 数据规则

- 所有文档和任务状态默认向所有访问者公开。
- Markdown 永久保存：数据库和本地 `.md` 文件同时持久化 MinerU 原稿、中文译稿和规范化终稿。
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
5. `71–87%`：保护公式/代码/图片/链接、规划分块、DeepSeek 调用、重试和无损校验。单块三次校验仍失败时保留该块原文并继续，不再让占位符问题毁掉整个任务。
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
GET  /api/v1/jobs                         公开任务列表
GET  /api/v1/jobs/{id}                    状态与最终文章
GET  /api/v1/jobs/{id}/events             永久事件增量读取
GET  /api/v1/jobs/{id}/events/stream      SSE 实时进度
GET  /api/v1/jobs/{id}/markdown           original/translated/normalized
GET  /api/v1/jobs/{id}/source             原始文件
GET  /api/v1/jobs/{id}/bundle             完整本地归档 ZIP
GET  /api/v1/jobs/{id}/assets/{name}      本地 WebP（R2 仅作回退）
```

示例：

```bash
curl -F "file=@paper.pdf" -F "translate=true" \
  http://185.99.135.224:8090/api/v1/jobs
```

## VPS 一键部署

目标地址：`http://185.99.135.224:8090`。VPS 只需要 Docker Engine 和 Docker Compose，不需要 Git、Rust、Node 或手工创建 `.env`。Compose 直接拉取 GHCR 公共镜像，首次启动自动生成数据库密码与实例密钥，已有密钥永不覆盖。

```bash
mkdir -p /opt/docflow && cd /opt/docflow
curl -fsSLO https://raw.githubusercontent.com/FengYuchen1314/docflow/main/docker-compose.yml
docker compose up -d
```

大多数情况下也可以直接在 VPS 上新建 `docker-compose.yml`，完整复制下面的内容，然后运行 `docker compose up -d`。以下代码块与仓库根目录的 `docker-compose.yml` 保持一致：

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
  MINERU_POLL_SECONDS: ${MINERU_POLL_SECONDS:-5}
  MINERU_MAX_WAIT_SECONDS: ${MINERU_MAX_WAIT_SECONDS:-7200}
  WEBP_QUALITY: ${WEBP_QUALITY:-88}
  DATABASE_POOL_SIZE: ${DATABASE_POOL_SIZE:-20}
  PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-http://185.99.135.224:8090}
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
    restart: "no"
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
      - "0.0.0.0:${HTTP_PORT:-8090}:80"
    volumes:
      - type: bind
        source: ./data/documents
        target: /data
        read_only: true
```

如果部署地址不是 `185.99.135.224:8090`，可在同目录创建 `.env`，例如写入 `PUBLIC_ORIGIN=http://你的VPS公网IP:8090`；如需修改监听端口，再增加 `HTTP_PORT=新端口`。

运行后目录即完整实例：

```text
/opt/docflow/
├── docker-compose.yml
└── data/
    ├── config/       # 实例密钥与 PostgreSQL 密码
    ├── postgres/     # 完整 PostgreSQL 数据目录
    └── documents/    # 源文件、Markdown、HTML、WebP、MinerU ZIP 与工作区
```

端口等参数有默认值；如需覆盖，可在同目录创建可选 `.env`，参考仓库中的 `.env.example`。MinerU、DeepSeek 和 R2 凭据始终在 `/admin` 中配置，而不是写入 Compose 或 `.env`。

管理员访问 `http://185.99.135.224:8090/admin`：

1. 首次注册唯一管理员；已有 Python 版本的 Argon2 密码可直接登录。
2. 配置并验证 MinerU API Key 与模型。
3. 可选配置 DeepSeek API Key 和模型；验证成功后前台默认选择中文翻译。
4. 如需异地镜像，可选配置 R2 Account ID、Access Key ID、Secret Access Key 和 Bucket。凭据在数据库中使用 `data/config/secret_key` 派生的 Fernet 密钥加密。
5. 在“文档重命名”中修改公开标题与下载文件名；扩展名必须保持一致，后端物理路径不会变化。

Cloudflare R2 凭据应仅授予目标存储桶对象读写权限。应用没有 R2 删除调用，也不配置生命周期规则。

## 运维与备份

```bash
docker compose ps
docker compose logs -f api worker
curl --fail http://127.0.0.1:8090/api/health
```

完整迁移或冷备份时先停服务，再打包 Compose 与整个 `data` 目录：

```bash
cd /opt/docflow
docker compose stop
tar -czf ../docflow-backup-$(date +%Y%m%d-%H%M%S).tar.gz docker-compose.yml data
docker compose start
```

在新 VPS 原样解压后执行 `docker compose up -d` 即可恢复。不要只复制 `documents`：数据库、加密凭据和文件路径映射需要作为同一实例一起迁移。R2 若已配置，只是额外镜像，不替代本地 `data` 备份。

现有 Alembic 表不会重建。Rust 的 SQLx 迁移只追加字段与索引，不提供降级或删除逻辑。

## 安全边界

- 公开是产品设定，请勿提交不能公开的材料。
- 管理员密码使用 Argon2，管理会话为 12 小时 HS256 JWT。
- ZIP 解压限制路径、条目数与总大小；外链下载拒绝私网、回环和链路本地地址。
- HTML 由 Comrak 渲染，并经 Ammonia 白名单消毒。
- 当前入口是明文 IP + 端口。管理员填写凭据时应使用可信网络、VPN 或 SSH 隧道；长期公网运行建议后续增加域名和 HTTPS。
