# Runtime Troubleshooting

The launcher talks to a Docker-compatible runtime through a local socket. It tries existing runtimes first, then offers automatic setup only when the platform supports it.

When more than one usable local runtime is already available, the setup flow can ask where Agent Zero should run. If there is only one usable runtime, the launcher chooses it automatically.

## Quick Checks

Run these from a terminal when the launcher says the runtime is unavailable:

```bash
docker info
docker context show
echo "$DOCKER_HOST"
```

If `DOCKER_HOST` points at an old or missing socket, unset it and refresh the launcher:

```bash
unset DOCKER_HOST
```

Docker contexts are also reused when they point to a reachable Docker-compatible endpoint. Tools such as OrbStack, Rancher Desktop, Colima, rootless Docker, and Podman can work when their Docker API endpoint is running. Portainer is a management UI for existing runtimes, so the launcher still needs the underlying Docker-compatible endpoint.

## Docker Desktop

On macOS or Windows, start Docker Desktop and wait until it reports that the engine is running. Then refresh the launcher.

On Linux, Docker Desktop uses a user socket such as:

```text
~/.docker/desktop/docker.sock
```

If Docker Desktop is running but the launcher still cannot connect, check that your shell or desktop session is not overriding `DOCKER_HOST` with a stale value.

## Native Docker Engine

On Debian or Ubuntu, the launcher and installer can use the host package manager to install Docker Engine. If Docker was just installed and the launcher says your user cannot access it yet, log out and back in once so group membership is applied.

Useful Linux checks:

```bash
systemctl status docker
docker info
groups
```

If the daemon is stopped, start it:

```bash
sudo systemctl start docker
```

On systems without `systemctl`, use the host service manager.

## Colima On macOS

When Docker Desktop is not installed, the launcher can use Colima with a dedicated profile named `a0`. The expected socket is:

```text
~/.colima/a0/docker.sock
```

Homebrew is not required for this launcher-managed path. When `colima`, `limactl`, or `docker` are missing, the launcher installs its own runtime components under its application data directory and starts Colima in user space. It should not ask for an administrator password just to create the `a0` profile.

If Colima was installed outside the launcher, make sure `colima`, `limactl`, and `docker` are available on `PATH`, then refresh the launcher. To inspect the profile:

```bash
colima list
colima start a0 --runtime docker
```

The launcher uses Colima's runtime defaults. Do not tune CPU, memory, or disk settings just to make the launcher detect the runtime.

## Rootless Docker On Linux

Rootless Docker usually exposes a user socket under:

```text
/run/user/<uid>/docker.sock
```

The launcher checks `XDG_RUNTIME_DIR` when looking for this socket. If rootless Docker is running but unavailable to the launcher, confirm the socket path:

```bash
echo "$XDG_RUNTIME_DIR"
ls -l "$XDG_RUNTIME_DIR/docker.sock"
docker info
```

Make sure the launcher is started from the same desktop session that owns the rootless Docker socket.
