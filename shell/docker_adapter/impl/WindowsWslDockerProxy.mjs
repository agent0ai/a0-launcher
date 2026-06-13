import { spawn } from 'node:child_process';
import net from 'node:net';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 23750;
const DEFAULT_SOCKET = '/var/run/docker.sock';
const WSL_KEEPALIVE_MARKER = 'a0-launcher-wsl-keepalive';
const WSL_KEEPALIVE_PKILL_PATTERN = 'a0-launcher-wsl-[k]eepalive';

let proxyServer = null;
let proxyPromise = null;
let proxyDistro = '';
let keepAliveProcess = null;
let keepAliveDistro = '';
let keepAliveSpawnCommand = null;
let cleanupRegistered = false;

const PYTHON_UNIX_SOCKET_BRIDGE = String.raw`
import os
import socket
import sys
import threading

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ.get("A0_DOCKER_SOCKET", "/var/run/docker.sock"))

def stdin_to_socket():
    try:
        while True:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            sock.sendall(data)
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def socket_to_stdout():
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
    finally:
        try:
            sock.close()
        except OSError:
            pass

threading.Thread(target=stdin_to_socket, daemon=True).start()
socket_to_stdout()
`;

const WSL_KEEPALIVE_SCRIPT = String.raw`
sleep_pid=''
cleanup() {
  if [ -n "$sleep_pid" ]; then
    kill "$sleep_pid" >/dev/null 2>&1 || true
    wait "$sleep_pid" >/dev/null 2>&1 || true
  fi
  exit 0
}
trap cleanup TERM INT
while :; do
  sleep 2147483647 &
  sleep_pid=$!
  wait "$sleep_pid" >/dev/null 2>&1 || true
  sleep_pid=''
done
`;

const WSL_KEEPALIVE_CLEANUP_SCRIPT = `pkill -TERM -f '${WSL_KEEPALIVE_PKILL_PATTERN}' >/dev/null 2>&1 || true`;

export function isWindowsWslProxyEndpoint(hostInfo) {
  return (
    process.platform === 'win32' &&
    hostInfo?.kind === 'tcp' &&
    hostInfo.host === DEFAULT_HOST &&
    Number(hostInfo.port) === DEFAULT_PORT
  );
}

export async function ensureWindowsWslDockerProxy(options = {}) {
  if (process.platform !== 'win32') {
    return { started: false, reason: 'unsupported_platform' };
  }

  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port || DEFAULT_PORT);
  if (host !== DEFAULT_HOST || port !== DEFAULT_PORT) {
    return { started: false, reason: 'unsupported_endpoint' };
  }

  if (proxyServer?.listening) {
    const keepAlive = ensureWindowsWslKeepAlive({ distro: proxyDistro || options.distro, spawnCommand: options.spawnCommand });
    return { started: true, reused: true, keepAlive, dockerHost: `tcp://${host}:${port}` };
  }
  if (proxyPromise) return proxyPromise;

  proxyPromise = startProxy({
    host,
    port,
    distro: options.distro,
    socketPath: options.socketPath || DEFAULT_SOCKET,
    spawnCommand: options.spawnCommand
  })
    .finally(() => {
      proxyPromise = null;
    });
  return proxyPromise;
}

async function startProxy({ host, port, distro, socketPath, spawnCommand }) {
  const selectedDistro = (distro || process.env.A0_WSL_DOCKER_DISTRO || '').trim();
  const keepAlive = ensureWindowsWslKeepAlive({ distro: selectedDistro, spawnCommand });
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    client.setKeepAlive(true);

    const args = [];
    if (selectedDistro) args.push('-d', selectedDistro);
    args.push('-u', 'root');
    args.push('--exec', 'python3', '-c', PYTHON_UNIX_SOCKET_BRIDGE);

    const child = spawn('wsl.exe', args, {
      env: { ...process.env, A0_DOCKER_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });
    child.unref();

    const closeClient = () => {
      if (!client.destroyed) client.destroy();
    };
    const closeChild = () => {
      if (!child.killed) child.kill();
    };

    client.pipe(child.stdin);
    child.stdout.pipe(client);

    client.on('error', closeChild);
    client.on('close', closeChild);
    child.stdin.on('error', closeClient);
    child.stdout.on('error', closeClient);
    child.on('error', closeClient);
    child.on('close', () => {
      if (!client.destroyed) client.end();
    });
  });

  server.on('close', () => {
    if (proxyServer === server) {
      proxyServer = null;
      proxyDistro = '';
    }
    stopWindowsWslKeepAlive();
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, resolve);
    });
  } catch (error) {
    stopWindowsWslKeepAlive();
    if (error?.code === 'EADDRINUSE') {
      return { started: false, reason: 'port_in_use', dockerHost: `tcp://${host}:${port}` };
    }
    throw error;
  }

  server.unref();
  proxyServer = server;
  proxyDistro = selectedDistro;
  return { started: true, reused: false, keepAlive, dockerHost: `tcp://${host}:${port}` };
}

export function ensureWindowsWslKeepAlive(options = {}) {
  if (process.platform !== 'win32') {
    return { started: false, reason: 'unsupported_platform' };
  }

  const selectedDistro = (options.distro || process.env.A0_WSL_DOCKER_DISTRO || '').trim();
  if (keepAliveProcess && !keepAliveProcess.killed && keepAliveDistro === selectedDistro) {
    return { started: true, reused: true, distro: selectedDistro || null };
  }

  stopWindowsWslKeepAlive();

  const args = [];
  if (selectedDistro) args.push('-d', selectedDistro);
  args.push('-u', 'root', '--exec', 'sh', '-lc', WSL_KEEPALIVE_SCRIPT, WSL_KEEPALIVE_MARKER);

  const spawnCommand = typeof options.spawnCommand === 'function' ? options.spawnCommand : spawn;
  const child = spawnCommand('wsl.exe', args, {
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref?.();

  keepAliveProcess = child;
  keepAliveDistro = selectedDistro;
  keepAliveSpawnCommand = spawnCommand;
  registerProcessCleanup();

  child.on?.('close', () => {
    if (keepAliveProcess === child) {
      keepAliveProcess = null;
      keepAliveDistro = '';
      keepAliveSpawnCommand = null;
    }
  });
  child.on?.('error', () => {
    if (keepAliveProcess === child) {
      keepAliveProcess = null;
      keepAliveDistro = '';
      keepAliveSpawnCommand = null;
    }
  });

  return { started: true, reused: false, distro: selectedDistro || null };
}

export function stopWindowsWslKeepAlive(options = {}) {
  const child = keepAliveProcess;
  const selectedDistro = keepAliveDistro;
  const spawnCommand = typeof options.spawnCommand === 'function'
    ? options.spawnCommand
    : keepAliveSpawnCommand;
  keepAliveProcess = null;
  keepAliveDistro = '';
  keepAliveSpawnCommand = null;
  if (!child && !selectedDistro) {
    return { stopped: false, cleanup: { started: false, reason: 'not_running' } };
  }
  if (child && !child.killed) {
    child.kill();
  }
  const cleanup = cleanupWindowsWslKeepAlive({ distro: selectedDistro, spawnCommand });
  return { stopped: !!child, cleanup };
}

function cleanupWindowsWslKeepAlive({ distro = '', spawnCommand = spawn } = {}) {
  if (process.platform !== 'win32') {
    return { started: false, reason: 'unsupported_platform' };
  }

  const selectedDistro = String(distro || '').trim();
  const args = [];
  if (selectedDistro) args.push('-d', selectedDistro);
  args.push('-u', 'root', '--exec', 'sh', '-lc', WSL_KEEPALIVE_CLEANUP_SCRIPT);

  try {
    const child = (typeof spawnCommand === 'function' ? spawnCommand : spawn)('wsl.exe', args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: true
    });
    child.unref?.();
    return { started: true, distro: selectedDistro || null };
  } catch (error) {
    return { started: false, reason: 'spawn_failed', message: error?.message || String(error) };
  }
}

function registerProcessCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    stopWindowsWslKeepAlive();
  });
}
