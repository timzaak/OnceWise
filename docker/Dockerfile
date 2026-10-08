# Multi-stage build for oncewise-ai-sync (single-crate Rust backend; migrations are embedded into
# the binary by sqlx::migrate!, so the runtime image carries no extra files).

# Stage 1: Rust build environment with cargo-chef for dependency caching
FROM rust:1-alpine AS chef
WORKDIR /app
# gcc/musl-dev: ring (via rustls, via sqlx runtime-tokio-rustls) needs a working C toolchain on musl
RUN apk add --no-cache gcc musl-dev && \
    cargo install cargo-chef --locked

# Stage 2: Analyze the dependency graph
FROM chef AS planner
COPY backend/ ./
RUN cargo chef prepare --recipe-path recipe.json

# Stage 3: Build dependencies first (cached across builds when Cargo.lock is unchanged)
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo chef cook --release --recipe-path recipe.json

# Copy the actual source and build
COPY backend/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --bin oncewise-ai-sync

# Stage 4: Minimal runtime
FROM alpine:3.20

RUN apk add --no-cache \
    ca-certificates \
    libgcc \
    tzdata \
    wget \
    && addgroup -g 1000 oncewise \
    && adduser -D -u 1000 -G oncewise oncewise

WORKDIR /app

COPY --from=builder /app/target/release/oncewise-ai-sync /app/oncewise-ai-sync

RUN chown -R oncewise:oncewise /app

USER oncewise

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/api/health || exit 1

# Required: point DATABASE_URL at a pre-created PostgreSQL database. AUTH_MODE defaults to
# 'herald', so the four HERALD_* variables are required as well — or set AUTH_MODE=none
# explicitly to keep the pre-gate behavior.
ENV BIND_ADDR=0.0.0.0:8080

CMD ["./oncewise-ai-sync"]
