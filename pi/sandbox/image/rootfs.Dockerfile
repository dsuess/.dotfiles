# syntax=docker/dockerfile:1
# Node's multi-architecture index is pinned; Debian packages intentionally receive
# security updates whenever this reviewed rootfs is explicitly rebuilt.
FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d

ARG TARGETARCH

# Standalone release inputs. Update a URL and its SHA256 together after reviewing
# the upstream release checksum. Debian owns the remaining system packages.
ARG UV_VERSION=0.9.18
ARG UV_AARCH64_SHA256=f8e23ec786b18660ade6b033b6191b7e9c283c872eeb8c4531d56a873decf160
ARG UV_X86_64_SHA256=c2def3db178ade63933fa15ffc96e882c196ce53e06173dcee05b36c5f6f68f5
ARG GCLOUD_VERSION=580.0.0
ARG GCLOUD_AARCH64_SHA256=a02b7c478f94c070d7cb1ec1c595d3a0c9ae84601c17d93946b89a33d3155d71
ARG GCLOUD_X86_64_SHA256=e580c04b45dfa2e537b8dc0cf7c828e46a65bc77ef61de69161e1f3a124d7480
ARG DIRENV_VERSION=2.37.1
ARG DIRENV_AARCH64_SHA256=2a9cef8d73521d6a3ec3f2871c4b747b8c4cc038628c1b57a7efa42b393a2d82
ARG DIRENV_X86_64_SHA256=1f1b93dd6f38523fde26dfac96151ef9d31a374e3005cd3345fb93555ae0c9b5
ARG RTK_VERSION=0.44.0
ARG RTK_AARCH64_SHA256=48be2ebe6332ceb67301909125ea20a3f557b07a7c6614defed29f9bf8e1d074
ARG RTK_X86_64_SHA256=3c3316cfc068e372432b415faeab73d46f8047750d488dd94d01d8d9f016a2a1

RUN set -eux; \
    case "$TARGETARCH" in \
      arm64) \
        kernel_package="linux-image-arm64"; \
        uv_asset="uv-aarch64-unknown-linux-gnu.tar.gz"; uv_sha="$UV_AARCH64_SHA256"; \
        gcloud_asset="google-cloud-cli-${GCLOUD_VERSION}-linux-arm.tar.gz"; gcloud_sha="$GCLOUD_AARCH64_SHA256"; \
        direnv_asset="direnv.linux-arm64"; direnv_sha="$DIRENV_AARCH64_SHA256"; \
        rtk_asset="rtk-aarch64-unknown-linux-gnu.tar.gz"; rtk_sha="$RTK_AARCH64_SHA256" ;; \
      amd64) \
        kernel_package="linux-image-amd64"; \
        uv_asset="uv-x86_64-unknown-linux-gnu.tar.gz"; uv_sha="$UV_X86_64_SHA256"; \
        gcloud_asset="google-cloud-cli-${GCLOUD_VERSION}-linux-x86_64.tar.gz"; gcloud_sha="$GCLOUD_X86_64_SHA256"; \
        direnv_asset="direnv.linux-amd64"; direnv_sha="$DIRENV_X86_64_SHA256"; \
        rtk_asset="rtk-x86_64-unknown-linux-musl.tar.gz"; rtk_sha="$RTK_X86_64_SHA256" ;; \
      *) echo "unsupported Docker target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client \
      ripgrep fd-find \
      python3 python3-dev \
      build-essential libc6-dev linux-libc-dev "$kernel_package" \
      chromium fontconfig fonts-dejavu-core fonts-liberation \
      docker.io docker-cli docker-buildx docker-compose containerd runc \
      iptables kmod e2fsprogs util-linux util-linux-extra tar xz-utils cpio lz4; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_asset}" -o /tmp/uv.tar.gz; \
    echo "${uv_sha}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 "$(find /tmp -type f -name uv -print -quit)" /usr/local/bin/uv; \
    curl -fsSL "https://storage.googleapis.com/cloud-sdk-release/${gcloud_asset}" -o /tmp/gcloud.tar.gz; \
    echo "${gcloud_sha}  /tmp/gcloud.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gcloud.tar.gz -C /opt; \
    ln -s /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud; \
    curl -fsSL "https://github.com/direnv/direnv/releases/download/v${DIRENV_VERSION}/${direnv_asset}" -o /usr/local/bin/direnv; \
    echo "${direnv_sha}  /usr/local/bin/direnv" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/direnv; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${rtk_asset}" -o /tmp/rtk.tar.gz; \
    echo "${rtk_sha}  /tmp/rtk.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/rtk.tar.gz -C /tmp; \
    install -m 0755 "$(find /tmp -type f -name rtk -print -quit)" /usr/local/bin/rtk; \
    ln -s /usr/bin/fdfind /usr/local/bin/fd; \
    ln -s /usr/bin/fdfind /usr/bin/fd; \
    rm -rf /tmp/*
