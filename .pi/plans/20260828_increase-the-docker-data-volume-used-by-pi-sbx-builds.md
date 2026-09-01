# Increase Pi Sandbox Docker Storage

## Context

The failure is in Pi's private Docker Sandboxes sidecar, not the host Docker Desktop engine. The current machine already gives Docker Desktop a 256 GiB disk image and has about 116 GiB of host free space, while the active Pi sidecar mounts `/var/lib/docker` on a separate 10 GiB volume. Pi launches `sbx` under the isolated app name `pi-srt`, so the setting must be changed in that app scope.

Docker Sandboxes v0.42.0-rc1 changed the nested Docker volume default from 50 GB to 10 GB and added `sandbox.disk.dockerVolume` / `DOCKER_SANDBOXES_DOCKER_SIZE` to override it. The setting affects only newly created sandboxes; existing volumes are never resized. This is documented in the [v0.42.0-rc1 release notes](https://github.com/docker/sbx-releases/releases/tag/v0.42.0-rc1) and [Docker Sandboxes troubleshooting guide](https://docs.docker.com/ai/sandboxes/troubleshooting/#sandbox-runs-out-of-disk-space).

Use 50 GiB as the new persistent default. This restores the prior default and leaves enough host headroom for the two currently recorded Pi sidecars. Resetting a sidecar deletes its private images, containers, volumes, and build cache, but does not delete the host workspace.

## Approach

Set the persistent Docker-volume default in Pi's `pi-srt` application scope, then recreate only the affected workspace sidecars so they receive a larger volume. Do not change the already sufficient Docker Desktop disk-image limit.

### Part A — Set the Pi-scoped Docker volume default
- **Ledger:** {"status":"completed","note":"Configured the pi-srt scoped nested-Docker volume default.","evidence":"`sbx --app-name pi-srt settings set sandbox.disk.dockerVolume 50g` succeeded; subsequent `settings get` returned `50g`."}

Run the host-side operator command:

```sh
sbx --app-name pi-srt settings set sandbox.disk.dockerVolume 50g
```

Confirm that the evaluated `pi-srt` setting reports `50g`. A Docker Desktop restart is not required for this setting, and changing Docker Desktop's disk-image limit would not enlarge the nested sidecar volume.

### Part B — Recreate affected workspace sidecars
- **Ledger:** {"status":"blocked","note":"Both stopped Pi sidecars were recreated and now have 49 GiB `/var/lib/docker` filesystems. The Visonic compose build completed without a storage error, but all five services subsequently exited with code 255 despite 34 GiB free in Docker data and 19 GiB free on `/`; this is not the plan's root-filesystem failure case.","evidence":"`pi-sbx reset /Users/dsuess/.dotfiles --force` succeeded. The Visonic reset encountered pre-existing sidecar-ownership metadata drift; after confirming the stopped sandbox name and workspace via `sbx --app-name pi-srt ls/inspect`, it was removed and recreated with the same reviewed controller metadata. `df -h /var/lib/docker` returned `/dev/vdd 49G` for both sidecars. `docker compose -f docker/docker-compose-dev.yaml up --build -d` completed without `no space left on device`; `docker ps -a` then showed manager, ui, conductor, processorcpu, and storybook all `Exited (255)`."}

Close Pi sessions using Docker in each affected repository so no broker traffic is active. From an ordinary host terminal, reset the affected workspace sidecar:

```sh
pi-sbx reset /path/to/repository --force
```

This deliberately discards that sidecar's Docker state. The next Docker operation from Pi lazily creates a replacement sidecar using the 50 GiB default. Repeat only for workspaces whose existing 10 GiB sidecar needs enlargement; changing the setting alone is sufficient for future workspaces.

## Verification

- Regression check: `sbx --app-name pi-srt settings get sandbox.disk.dockerVolume` prints `50g`.
- New-sidecar check: after reset and one Docker operation from Pi, `sbx --app-name pi-srt exec <sidecar-name> df -h /var/lib/docker` reports approximately 50 GiB rather than 10 GiB.
- Build scenario: rerun the image build and confirm it completes without `no space left on device`; then confirm the services remain running instead of all exiting with code 255.
- Failure signal: if `/var/lib/docker` is larger but `/` is full, that is the independent 20 GiB root filesystem; set `DOCKER_SANDBOXES_ROOT_SIZE` for newly created sandboxes instead of further increasing the Docker data volume.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Set the Pi-scoped Docker volume default
- ⛔ Recreate affected workspace sidecars
<!-- pi-plan-mode:progress:end -->
