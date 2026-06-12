/**
 * Runtime provisioning base for launcher-managed Docker setup.
 *
 * This adapter layer owns runtime mechanics only. Product flow, operation ids,
 * acknowledgements, and renderer-facing language stay in docker_manager.
 */

import { spawn } from 'node:child_process';

/**
 * @typedef {Object} AssessResult
 * @property {"ready"|"engine_stopped"|"needs_relogin"|"not_provisioned"|"manual_install"|"unsupported"} state
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
   * @param {{managedDir: string}} options
   * @returns {Promise<RuntimeProvisioner|null>}
   */
  static async forPlatform(options) {
    if (process.platform !== 'linux') return null;
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
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(cmd, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(100, Number(options.timeoutMs)) : 120000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: process.env, windowsHide: true });
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
