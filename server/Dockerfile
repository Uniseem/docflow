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

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /data/work \
    && chown -R app:app /data
COPY --from=build /build/docflow-server /usr/local/bin/docflow-server
USER app
EXPOSE 8000
ENTRYPOINT ["docflow-server"]
