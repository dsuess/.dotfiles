# QEMU's RTC continues while the host sleeps. Set the guest clock before any
# network-facing service starts, then keep long-lived processes close to that RTC.
sync_rtc_clock() {
  hwclock_bin="$(command -v hwclock || true)"
  if [ -z "$hwclock_bin" ]; then
    log "[init] hwclock is unavailable; cannot synchronize guest time"
    return 1
  fi
  "$hwclock_bin" --hctosys --utc
}

if ! sync_rtc_clock; then
  # The controller retries before every requested workload and fails closed.
  # Do not make diagnostics or recovery impossible when a kernel exposes RTC
  # support later in its boot sequence.
  log "[init] initial RTC synchronization failed; controller retry is required"
fi
(
  while sleep 30; do
    sync_rtc_clock || log "[init] background RTC synchronization failed"
  done
) &
log "[init] RTC clock synchronization enabled"

# Ensure cgroup v2 is available to the guest-local Docker daemon.
mkdir -p /sys/fs/cgroup
if ! grep -q " /sys/fs/cgroup " /proc/mounts; then
  mount -t cgroup2 cgroup2 /sys/fs/cgroup 2>/dev/null || true
fi

mkdir -p /var/run /var/lib/docker /run/docker
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true

# Keep all daemon state in the guest-native filesystem. Never connect to a host
# Docker socket. The vfs driver is intentional; Docker storage is ephemeral
# because the VM root filesystem is replaced with the VM.
if command -v dockerd >/dev/null 2>&1; then
  dockerd \
    --host=unix:///var/run/docker.sock \
    --exec-root=/run/docker \
    --data-root=/var/lib/docker \
    --storage-driver=vfs \
    --userland-proxy=false \
    > /var/log/dockerd.log 2>&1 &
  log "[init] started guest-local dockerd"
fi

if command -v docker >/dev/null 2>&1; then
  docker_ready=0
  for i in $(seq 1 100); do
    if timeout 1 docker info >/dev/null 2>&1; then
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
