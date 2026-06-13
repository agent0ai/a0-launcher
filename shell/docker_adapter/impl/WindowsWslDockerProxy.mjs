import { spawn } from 'node:child_process';
import net from 'node:net';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 23750;
const DEFAULT_SOCKET = '/var/run/docker.sock';

let proxyServer = null;
let proxyPromise = null;

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
    return { started: true, reused: true, dockerHost: `tcp://${host}:${port}` };
  }
  if (proxyPromise) return proxyPromise;

  proxyPromise = startProxy({ host, port, distro: options.distro, socketPath: options.socketPath || DEFAULT_SOCKET })
    .finally(() => {
      proxyPromise = null;
    });
  return proxyPromise;
}

async function startProxy({ host, port, distro, socketPath }) {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    client.setKeepAlive(true);

    const args = [];
    const selectedDistro = (distro || process.env.A0_WSL_DOCKER_DISTRO || '').trim();
    if (selectedDistro) args.push('-d', selectedDistro);
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
    if (proxyServer === server) proxyServer = null;
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, resolve);
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      return { started: false, reason: 'port_in_use', dockerHost: `tcp://${host}:${port}` };
    }
    throw error;
  }

  server.unref();
  proxyServer = server;
  return { started: true, reused: false, dockerHost: `tcp://${host}:${port}` };
}
