/**
 * Runtime provisioning base for launcher-managed Docker setup.
 *
 * This adapter layer owns runtime mechanics only. Product flow, operation ids,
 * acknowledgements, and renderer-facing language stay in docker_manager.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} AssessResult
 * @property {"ready"|"engine_stopped"|"needs_relogin"|"needs_group_membership"|"not_provisioned"|"manual_install"|"unsupported"} state
 * @property {string} detail
 * @property {string=} packageManager
 * @property {string[]=} manualPackages
 * @property {string=} manualCommand
 */

export class RuntimeProvisioner {
  /**
   * @param {Object} options
   * @param {string} options.managedDir Writable launcher-owned directory.
   */
  constructor(options = {}) {
    if (!options.managedDir) throw makeError('INVALID_ARGS', 'managedDir is required');
    this.managedDir = options.managedDir;
  }

  /**
   * @param {{managedDir: string, platform?: NodeJS.Platform}} options
   * @returns {Promise<RuntimeProvisioner|null>}
   */
  static async forPlatform(options) {
    const platform = options?.platform || process.platform;
    if (platform === 'darwin') {
      const { ColimaRuntime } = await import('./impl/ColimaRuntime.mjs');
      return new ColimaRuntime(options);
    }
    if (platform !== 'linux') return null;
    const { LinuxEngineRuntime } = await import('./impl/LinuxEngineRuntime.mjs');
    return new LinuxEngineRuntime(options);
  }

  /** @returns {Promise<AssessResult>} */
  async assess() { throw makeError('NOT_IMPLEMENTED', 'assess is abstract'); }

  async provision(_options = {}) { throw makeError('NOT_IMPLEMENTED', 'provision is abstract'); }

  async start(_options = {}) { throw makeError('NOT_IMPLEMENTED', 'start is abstract'); }

  async status() { throw makeError('NOT_IMPLEMENTED', 'status is abstract'); }

  endpoint() { throw makeError('NOT_IMPLEMENTED', 'endpoint is abstract'); }
}

export function makeError(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object=} options
 * @param {number=} options.timeoutMs
 * @param {AbortSignal=} options.signal
 * @param {(line: string) => void=} options.onLine
 * @param {Object=} options.env
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(cmd, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(100, Number(options.timeoutMs)) : 120000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: options.env || process.env, windowsHide: true });
    } catch (error) {
      reject(makeError('SPAWN_FAILED', `Failed to run ${cmd}`, { message: error?.message || String(error) }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let lineRest = '';
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal && abortListener) {
        try {
          options.signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
      fn(value);
    };

    const feedLines = (chunk) => {
      if (typeof options.onLine !== 'function') return;
      const parts = (lineRest + chunk.toString('utf8')).split(/\r?\n/);
      lineRest = parts.pop() || '';
      for (const line of parts) {
        const clean = line.trim();
        if (clean) options.onLine(clean);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      feedLines(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk);
      feedLines(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      settle(reject, makeError('TIMEOUT', `${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const abortListener = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      settle(reject, makeError('ABORTED', `${cmd} aborted`));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        abortListener();
        return;
      }
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    child.on('error', (error) => {
      settle(reject, makeError('SPAWN_FAILED', error?.message || String(error), { code: error?.code }));
    });

    child.on('close', (code) => {
      settle(resolve, {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

export async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    headers: {
      'Accept': 'application/vnd.github+json, application/json',
      'User-Agent': 'A0-Launcher'
    }
  });
  if (!response.ok) {
    throw makeError('DOWNLOAD_FAILED', `Request failed: ${response.status} ${response.statusText}`, { url });
  }
  return await response.json();
}

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    headers: {
      'Accept': 'text/plain, */*',
      'User-Agent': 'A0-Launcher'
    }
  });
  if (!response.ok) {
    throw makeError('DOWNLOAD_FAILED', `Request failed: ${response.status} ${response.statusText}`, { url });
  }
  return await response.text();
}

export async function downloadVerified(url, destPath, sha256 = '', options = {}) {
  const response = await fetch(url, {
    signal: options.signal,
    redirect: 'follow',
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });
  if (!response.ok) {
    throw makeError('DOWNLOAD_FAILED', `Download failed: ${response.status} ${response.statusText}`, { url });
  }

  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  const hash = crypto.createHash('sha256');
  let file = null;

  try {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const buffer = Buffer.from(await response.arrayBuffer());
      hash.update(buffer);
      await fsp.writeFile(tempPath, buffer);
    } else {
      file = fs.createWriteStream(tempPath, { mode: 0o644 });
      const reader = response.body.getReader();
      const total = Number(response.headers.get('content-length')) || 0;
      let received = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        hash.update(chunk);
        received += chunk.length;
        if (total && typeof options.onProgress === 'function') {
          options.onProgress(null, Math.max(0, Math.min(100, Math.round((received / total) * 100))));
        }
        await new Promise((resolve, reject) => file.write(chunk, (error) => (error ? reject(error) : resolve())));
      }

      await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
    }

    const actual = hash.digest('hex');
    const expected = String(sha256 || '').trim().toLowerCase();
    if (expected && actual.toLowerCase() !== expected) {
      throw makeError('CHECKSUM_MISMATCH', 'Downloaded component failed verification', { url, expected, actual });
    }

    await fsp.rename(tempPath, destPath);
  } catch (error) {
    if (file) {
      try {
        file.destroy();
      } catch {
        // ignore
      }
    }
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function sha256FromSumText(text, assetName) {
  const wanted = String(assetName || '').trim();
  if (!wanted) return '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*([a-fA-F0-9]{64})\s+[* ]?(.+?)\s*$/.exec(line);
    if (!match) continue;
    const name = path.basename(match[2].trim());
    if (name === wanted) return match[1].toLowerCase();
  }
  return '';
}
