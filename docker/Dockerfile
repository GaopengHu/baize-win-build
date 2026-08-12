# 今点通 Windows 7/8 交叉编译环境
#
# 使用中国镜像加速 (APT / Node.js / npm / Electron)
#
# 构建:
#   docker build -t baize-winbuilder -f docker/Dockerfile .
#   docker compose -f docker/docker-compose.yml build
#
# 使用 (一键构建):
#   docker compose -f docker/docker-compose.yml run --rm build
#
# 使用 (交互式):
#   docker run -it --rm \
#     -v /path/to/baize:/app \
#     -v baize-npm-cache:/home/builder/.npm \
#     -v baize-electron-cache:/home/builder/.cache/electron \
#     -v baize-builder-cache:/home/builder/.cache/electron-builder \
#     baize-winbuilder bash

FROM ubuntu:22.04

LABEL maintainer="Baize Team <dev@baize.app>"
LABEL description="Cross-compilation environment for Baize Windows 7/8 installer"

ENV DEBIAN_FRONTEND=noninteractive

ARG UID=1000
ARG GID=1000

# Step 1: Install ca-certificates first (uses default HTTP repos, no TLS issue)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Step 2: Switch to TUNA mirror (now certs are in place for HTTPS)
RUN sed -i 's|http://archive.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list \
    && sed -i 's|http://security.ubuntu.com/ubuntu|https://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list

# Step 3: System dependencies (from TUNA, fast in China)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    git \
    curl \
    wget \
    xz-utils \
    wine \
    wine64 \
    && rm -rf /var/lib/apt/lists/*

# ===== Node.js 22 (binary from npmmirror, avoid nodesource) =====
RUN curl -fsSL https://npmmirror.com/mirrors/node/v22.22.0/node-v22.22.0-linux-x64.tar.xz \
    | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g npm@11.11.1 --registry=https://registry.npmmirror.com \
    && npm config set registry https://registry.npmmirror.com

# ===== Non-root builder user (matching host UID/GID) =====
RUN groupadd -g ${GID} builder \
    && useradd -m -u ${UID} -g ${GID} -s /bin/bash builder

# ===== Wine configuration (headless, under builder home) =====
ENV WINEDEBUG=-all
ENV WINEPREFIX=/home/builder/.wine
ENV WINEARCH=win64
RUN mkdir -p /home/builder/.wine && chown -R builder:builder /home/builder/.wine
RUN wine wineboot --init 2>/dev/null || true
RUN wine wineboot --end 2>/dev/null || true

# ===== Electron-builder caches (under builder home) =====
RUN mkdir -p /home/builder/.cache/electron \
    /home/builder/.cache/electron-builder \
    /home/builder/.npm/_prebuilds \
    && chown -R builder:builder /home/builder

# ===== NPMMIRROR (Electron downloads) =====
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# ===== Working directory =====
WORKDIR /app

# ===== Run as non-root builder =====
USER builder

# ===== Default command: build Windows 7/8 installer =====
CMD ["npm", "run", "build:win7"]
