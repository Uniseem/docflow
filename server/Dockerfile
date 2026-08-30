FROM rust:1-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY migrations ./migrations
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    (cargo build --release --locked 2>/dev/null || cargo build --release) \
    && cp target/release/docflow-server /build/docflow-server

FROM build AS test
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    rustup component add rustfmt clippy \
    && cargo fmt --check \
    && cargo test --release --locked \
    && cargo clippy --release --locked -- -D warnings

FROM node:24-bookworm-slim AS pdf-runtime
WORKDIR /opt/docflow/pdf
COPY pdf-assets/package.json pdf-assets/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY pdf-assets/render.mjs ./render.mjs

FROM debian:bookworm-slim AS native-pdf-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        python3-venv \
        build-essential \
        libfreetype6 \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/docflow/native-pdf
COPY native-pdf/requirements.txt ./requirements.txt
RUN python3 -m venv /opt/docflow/native-pdf/venv \
    && venv/bin/python -m pip install --no-cache-dir pip==25.2 \
    && venv/bin/python -m pip install --no-cache-dir -r requirements.txt \
    && venv/bin/python -m pip check
COPY native-pdf/ ./
RUN venv/bin/python -B -m unittest discover -s tests -v \
    && venv/bin/python -B prepare_assets.py --asset-dir /opt/docflow/native-pdf/assets \
    && venv/bin/python -B prepare_assets.py --asset-dir /opt/docflow/native-pdf/assets --verify-only \
    && test -f /opt/docflow/native-pdf/assets/.ready

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fonts-liberation \
        fonts-linuxlibertine \
        fonts-noto-cjk \
        fonts-noto-core \
        fonts-noto-mono \
        nodejs \
        python3 \
        libfreetype6 \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --create-home --shell /usr/sbin/nologin app \
    && mkdir -p /data/work /app/.config /app/.cache \
    && chown -R app:app /data /app
COPY --from=build /build/docflow-server /usr/local/bin/docflow-server
COPY --from=pdf-runtime /opt/docflow/pdf /opt/docflow/pdf
COPY --from=native-pdf-runtime /opt/docflow/native-pdf /opt/docflow/native-pdf
ENV CHROMIUM_PATH=/usr/bin/chromium \
    HOME=/app \
    XDG_CONFIG_HOME=/tmp/.chromium-config \
    XDG_CACHE_HOME=/tmp/.chromium-cache \
    PDF_NODE_BINARY=node \
    PDF_RENDERER_SCRIPT=/opt/docflow/pdf/render.mjs \
    PDF_KATEX_ROOT=/opt/docflow/pdf/node_modules/katex/dist \
    PDF2ZH_PYTHON_BINARY=/opt/docflow/native-pdf/venv/bin/python \
    PDF2ZH_RUNNER_SCRIPT=/opt/docflow/native-pdf/runner.py \
    PDF2ZH_ASSET_DIR=/opt/docflow/native-pdf/assets
USER app
EXPOSE 8000
ENTRYPOINT ["docflow-server"]
