# Ensure cgroup v2 is available to the guest-local Docker daemon.
mkdir -p /sys/fs/cgroup
if ! grep -q " /sys/fs/cgroup " /proc/mounts; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup 2>/dev/null || true
fi

mkdir -p /var/run /var/lib/docker /run/docker
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

# Containers do not inherit the guest trust store. For `docker run`, mount the
# Gondolin-composed CA bundle and point common TLS clients at it. Compose tests
# use images that do not need outbound TLS.
if [ -x /usr/bin/docker ]; then
  cat > /usr/local/bin/docker <<'EOF'
#!/bin/sh
set -eu

DOCKER_BIN=/usr/bin/docker
CA_BUNDLE="${SSL_CERT_FILE:-/run/gondolin/ca-certificates.crt}"

if [ "$#" -gt 0 ] && [ "$1" = "run" ] && [ -r "$CA_BUNDLE" ]; then
  shift
  exec "$DOCKER_BIN" run \
    -e "SSL_CERT_FILE=$CA_BUNDLE" \
    -e "CURL_CA_BUNDLE=$CA_BUNDLE" \
    -e "REQUESTS_CA_BUNDLE=$CA_BUNDLE" \
    -v "$CA_BUNDLE:$CA_BUNDLE:ro" \
    "$@"
fi

exec "$DOCKER_BIN" "$@"
EOF
  chmod 0755 /usr/local/bin/docker
  log "[init] installed Docker CA wrapper"
fi

# Keep all daemon state inside the VM or the explicit /var/lib/docker VFS
# provider. Never connect to a host Docker socket. VFS is required because the
# persistent directory is shared by later VM instances for this workspace.
if command -v dockerd >/dev/null 2>&1; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --exec-root=/run/docker \
    --data-root=/var/lib/docker \
    --storage-driver=vfs \
    --iptables=true \
    --ip-forward=true \
    --ip-masq=true \
    --userland-proxy=false \
    > /var/log/dockerd.log 2>&1 &
  log "[init] started guest-local dockerd"
fi

if command -v docker >/dev/null 2>&1; then
  docker_ready=0
  for i in $(seq 1 200); do
    if docker info >/dev/null 2>&1; then
      docker_ready=1
      break
    fi
    sleep 0.1
  done
  if [ "$docker_ready" -eq 1 ]; then
    log "[init] Docker ready"
  else
    log "[init] Docker failed to become ready"
    if [ -r /var/log/dockerd.log ]; then
      log_cmd tail -n 100 /var/log/dockerd.log
    fi
  fi
fi
