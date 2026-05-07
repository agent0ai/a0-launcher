/**
 * Docker Version Management - Stage 1
 * DockerInterface abstract base class (ESM).
 *
 * IMPORTANT:
 * - This module is ESM by requirement (DI-001).
 * - Concrete implementations live in `./impl/*` and are loaded on demand (DI-002).
 */

/**
 * @typedef {Object} DockerHostInfo
 * @property {string} raw
 * @property {"default"|"unix"|"npipe"|"tcp"|"http"|"https"|"invalid"} kind
 * @property {string=} socketPath
 * @property {string=} host
 * @property {number=} port
 * @property {string=} protocol
 * @property {string=} error
 */

/**
 * @typedef {Object} DockerEnvironmentInfo
 * @property {string} platform
 * @property {string} arch
 * @property {DockerHostInfo} dockerHost
 * @property {boolean} dockerAvailable
 * @property {"docker_desktop"|"docker_engine"|"unknown"} dockerFlavor
 * @property {string|null} daemonVersion
 * @property {string|null} diagnosticCode
 * @property {string|null} diagnosticMessage
 * @property {Object|null} diagnosticDetails
 */

/**
 * @typedef {Object} RemoteDigestInfo
 * @property {boolean} exists
 * @property {string|null} digest
 * @property {string|null} contentType
 * @property {Object|null} rateLimit
 */

/**
 * @typedef {Object} PullState
 * @property {string} opId
 * @property {string} imageRef
 * @property {"running"|"completed"|"failed"|"aborted_client"} status
 * @property {number|null} progress
 * @property {string|null} message
 * @property {boolean} canCancel
 * @property {string} startedAt
 */

/**
 * @typedef {Object} LogLineEvent
 * @property {'stdout'|'stderr'} stream
 * @property {string} line
 * @property {boolean=} partial
 */

/**
 * @typedef {Object} DockerInterfaceOptions
 * @property {string=} imageRepo
 */

/**
 * @typedef {Object} DetectEnvironmentOptions
 * @property {number=} timeoutMs
 * @property {string=} dockerHost
 */

export class DockerInterface {
  static #instance = null;
  static #instancePromise = null;

  /**
   * Detect OS + Docker availability.
   * Best-effort and tolerant of failures: returns structured diagnostics instead of throwing.
   *
   * @param {DetectEnvironmentOptions=} options
   * @returns {Promise<DockerEnvironmentInfo>}
   */
  static async detectEnvironment(options = {}) {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(250, Math.floor(options.timeoutMs))
        : 1500;

    const dockerHostRaw = (options.dockerHost || process.env.DOCKER_HOST || '').trim();
    const dockerHost = this.#parseDockerHost(dockerHostRaw);

    /** @type {DockerEnvironmentInfo} */
    const info = {
      platform: process.platform,
      arch: process.arch,
      dockerHost,
      dockerAvailable: false,
      dockerFlavor: this.#detectDockerFlavor(),
      daemonVersion: null,
      diagnosticCode: null,
      diagnosticMessage: null,
      diagnosticDetails: null
    };

    if (dockerHost.kind === 'invalid') {
      info.diagnosticCode = 'INVALID_DOCKER_HOST';
      info.diagnosticMessage = dockerHost.error || 'Invalid DOCKER_HOST';
      return info;
    }

    let Dockerode;
    try {
      const imported = await import('dockerode');
      Dockerode = imported?.default || imported;
    } catch (error) {
      info.diagnosticCode = 'DOCKERODE_MISSING';
      info.diagnosticMessage = 'dockerode dependency is not available';
      info.diagnosticDetails = { message: error?.message || String(error) };
      return info;
    }

    const docker = new Dockerode(this.#dockerodeOptionsFromHost(dockerHost, timeoutMs));

    try {
      await this.#withTimeout(Promise.resolve(docker.ping()), timeoutMs);
      info.dockerAvailable = true;

      try {
        const v = await this.#withTimeout(Promise.resolve(docker.version()), timeoutMs);
        info.daemonVersion = typeof v?.Version === 'string' ? v.Version : null;
      } catch {
        // best-effort only
      }

      return info;
    } catch (error) {
      const normalized = this.#normalizeDockerodeError(error);
      info.diagnosticCode = normalized.code;
      info.diagnosticMessage = normalized.message;
      info.diagnosticDetails = normalized.details;
      return info;
    }
  }

  /**
   * Retrieve a singleton DockerInterface implementation instance (DI-004).
   * @param {DockerInterfaceOptions=} options
   * @returns {Promise<DockerInterface>}
   */
  static async get(options = {}) {
    if (this.#instance) return this.#instance;
    if (this.#instancePromise) return this.#instancePromise;

    this.#instancePromise = (async () => {
      const env = await this.detectEnvironment();
      const { DockerodeDocker } = await import('./impl/DockerodeDocker.mjs');
      const instance = new DockerodeDocker({
        env,
        imageRepo: options?.imageRepo
      });
      this.#instance = instance;
      return instance;
    })().catch((error) => {
      this.#instance = null;
      throw error;
    }).finally(() => {
      // Allow retry if construction failed; otherwise keep #instance.
      this.#instancePromise = null;
    });

    return this.#instancePromise;
  }

  /**
   * @param {DockerInterfaceOptions=} options
   */
  constructor(options = {}) {
    this.imageRepo = (options?.imageRepo || 'agent0ai/agent-zero').trim();
  }

  /**
   * @returns {Promise<DockerEnvironmentInfo>}
   */
  async getEnvironment() {
    return DockerInterface.detectEnvironment();
  }

  /**
   * List remote tags for an image repo (DI-005).
   * @param {string} imageRepo
   * @returns {Promise<string[]>}
   */
  async listRemoteTags(_imageRepo) {
    throw new Error('DockerInterface.listRemoteTags is abstract');
  }

  /**
   * Retrieve the remote digest for a tag (DI-006).
   * @param {string} imageRepo
   * @param {string} tag
   * @returns {Promise<RemoteDigestInfo>}
   */
  async getRemoteDigest(_imageRepo, _tag) {
    throw new Error('DockerInterface.getRemoteDigest is abstract');
  }

  /**
   * Best-effort remote manifest layer size prefetch (DI-008).
   * Used to stabilize pull progress denominators without invoking the Docker CLI.
   *
   * @param {string} imageRepo
   * @param {string} tag
   * @param {Object=} options
   * @returns {Promise<{exists: boolean, layersById: Map<string, number>, totalBytes: number, contentType: string|null, digest: string|null, rateLimit: Object|null}>}
   */
  async getRemoteLayerSizes(_imageRepo, _tag, _options = {}) {
    throw new Error('DockerInterface.getRemoteLayerSizes is abstract');
  }

  /**
   * List local images for an image repo (DI-007).
   * @param {string} imageRepo
   * @returns {Promise<Object[]>}
   */
  async listLocalImages(_imageRepo) {
    throw new Error('DockerInterface.listLocalImages is abstract');
  }

  /**
   * Delete a local image reference (DI-010).
   * @param {string} imageRef
   * @returns {Promise<void>}
   */
  async removeLocalImage(_imageRef) {
    throw new Error('DockerInterface.removeLocalImage is abstract');
  }

  /**
   * Pull an image reference with progress reporting (DI-008).
   * The caller may optionally provide an `onProgress` callback.
   *
   * @param {string} imageRef
   * @param {Object=} options
   * @param {(progress: Object) => void=} options.onProgress
   * @param {AbortSignal=} options.signal
   * @returns {Promise<{opId: string, status: "completed"|"aborted_client"}>}
   */
  async pullImage(_imageRef, _options = {}) {
    throw new Error('DockerInterface.pullImage is abstract');
  }

  /**
   * List in-flight pulls with best-effort progress state (DI-008).
   * @returns {Promise<PullState[]>}
   */
  async getPulls() {
    throw new Error('DockerInterface.getPulls is abstract');
  }

  /**
   * Best-effort cancel a pull by opId (DI-009).
   * @param {string} opId
   * @returns {Promise<{canceled: boolean}>}
   */
  async cancelPull(_opId) {
    throw new Error('DockerInterface.cancelPull is abstract');
  }

  /**
   * List containers for an image repo (DI-011).
   * @param {string} imageRepo
   * @returns {Promise<Object[]>}
   */
  async listContainers(_imageRepo) {
    throw new Error('DockerInterface.listContainers is abstract');
  }

  /**
   * Create a container from parameters (DI-012).
   * @param {Object} createOptions
   * @returns {Promise<{containerId: string}>}
   */
  async createContainer(_createOptions) {
    throw new Error('DockerInterface.createContainer is abstract');
  }

  /**
   * Rename a container (used for retention naming).
   * @param {string} containerId
   * @param {string} newName
   * @returns {Promise<void>}
   */
  async renameContainer(_containerId, _newName) {
    throw new Error('DockerInterface.renameContainer is abstract');
  }

  /**
   * Inspect container details (DI-012).
   * @param {string} containerId
   * @returns {Promise<Object>}
   */
  async inspectContainer(_containerId) {
    throw new Error('DockerInterface.inspectContainer is abstract');
  }

  /**
   * Read container logs once (bounded). Intended for diagnostics and snapshot viewing.
   *
   * @param {string} containerId
   * @param {Object=} options
   * @param {number=} options.maxLines
   * @param {boolean=} options.timestamps
   * @param {boolean=} options.includeStderr
   * @param {AbortSignal=} options.signal
   * @returns {Promise<{mode: 'snapshot', lines: LogLineEvent[], aborted: boolean}>}
   */
  async readContainerLogs(_containerId, _options = {}) {
    throw new Error('DockerInterface.readContainerLogs is abstract');
  }

  /**
   * Follow container logs with an initial burst of last N lines, then stream live lines.
   * Intended for UI log viewers (bounded internal buffering; caller owns display buffering).
   *
   * @param {string} containerId
   * @param {Object} options
   * @param {number=} options.maxLines
   * @param {boolean=} options.timestamps
   * @param {boolean=} options.includeStderr
   * @param {{onLine?:(evt:LogLineEvent)=>void,onError?:(err:Error)=>void,onEnd?:()=>void}=} options.callbacks
   * @param {(evt:LogLineEvent)=>void} options.onLine
   * @param {(err:Error)=>void=} options.onError
   * @param {()=>void=} options.onEnd
   * @param {AbortSignal=} options.signal
   * @returns {Promise<{mode:'follow', stop: ()=>void, done: Promise<void>, control: {pause: ()=>void, resume: ()=>void, isPaused: ()=>boolean}}>}
   */
  async followContainerLogs(_containerId, _options) {
    throw new Error('DockerInterface.followContainerLogs is abstract');
  }

  /**
   * Start a container (DI-012).
   * @param {string} containerId
   * @returns {Promise<void>}
   */
  async startContainer(_containerId) {
    throw new Error('DockerInterface.startContainer is abstract');
  }

  /**
   * Stop a container (DI-012).
   * @param {string} containerId
   * @param {Object=} options
   * @returns {Promise<void>}
   */
  async stopContainer(_containerId, _options = {}) {
    throw new Error('DockerInterface.stopContainer is abstract');
  }

  /**
   * Restart a container (DI-012).
   * @param {string} containerId
   * @param {Object=} options
   * @returns {Promise<void>}
   */
  async restartContainer(_containerId, _options = {}) {
    throw new Error('DockerInterface.restartContainer is abstract');
  }

  /**
   * Delete a container (DI-012).
   * @param {string} containerId
   * @param {Object=} options
   * @returns {Promise<void>}
   */
  async deleteContainer(_containerId, _options = {}) {
    throw new Error('DockerInterface.deleteContainer is abstract');
  }

  static #detectDockerFlavor() {
    if (process.platform === 'darwin' || process.platform === 'win32') return 'docker_desktop';
    if (process.platform === 'linux') return 'docker_engine';
    return 'unknown';
  }

  /**
   * @param {DockerHostInfo} hostInfo
   * @param {number} timeoutMs
   * @returns {Object}
   */
  static #dockerodeOptionsFromHost(hostInfo, timeoutMs) {
    const base = { timeout: timeoutMs };
    if (!hostInfo || hostInfo.kind === 'default') return base;

    if (hostInfo.kind === 'unix' || hostInfo.kind === 'npipe') {
      return { ...base, socketPath: hostInfo.socketPath };
    }

    if (hostInfo.kind === 'tcp' || hostInfo.kind === 'http' || hostInfo.kind === 'https') {
      return {
        ...base,
        host: hostInfo.host,
        port: hostInfo.port,
        protocol: hostInfo.protocol
      };
    }

    return base;
  }

  /**
   * @param {string} value
   * @returns {DockerHostInfo}
   */
  static #parseDockerHost(value) {
    const raw = (value || '').trim();
    if (!raw) return { raw: '', kind: 'default' };

    // Common shorthand: DOCKER_HOST as a unix socket path.
    if (raw.startsWith('/')) {
      return { raw, kind: 'unix', socketPath: raw };
    }

    // `unix://`, `npipe://`, `tcp://`, `http(s)://`
    try {
      const u = new URL(raw);
      const protocol = (u.protocol || '').toLowerCase();

      if (protocol === 'unix:') {
        const socketPath = decodeURIComponent(u.pathname || '');
        if (!socketPath) return { raw, kind: 'invalid', error: 'Missing unix socket path in DOCKER_HOST' };
        return { raw, kind: 'unix', socketPath };
      }

      if (protocol === 'npipe:') {
        // Example: npipe:////./pipe/docker_engine
        let p = decodeURIComponent(u.pathname || '');
        if (!p) return { raw, kind: 'invalid', error: 'Missing npipe path in DOCKER_HOST' };
        if (p.startsWith('////')) p = `//${p.slice(4)}`;
        return { raw, kind: 'npipe', socketPath: p };
      }

      if (protocol === 'tcp:' || protocol === 'http:' || protocol === 'https:') {
        const host = u.hostname || '';
        const port = u.port ? Number(u.port) : NaN;
        const numericPort = Number.isFinite(port) ? port : 2375;
        if (!host) return { raw, kind: 'invalid', error: 'Missing host in DOCKER_HOST' };
        return {
          raw,
          kind: protocol === 'tcp:' ? 'tcp' : protocol.slice(0, -1),
          host,
          port: numericPort,
          protocol: protocol === 'tcp:' ? 'http' : protocol.slice(0, -1)
        };
      }

      return { raw, kind: 'invalid', error: `Unsupported DOCKER_HOST protocol: ${protocol || '(none)'}` };
    } catch (error) {
      return { raw, kind: 'invalid', error: `Failed to parse DOCKER_HOST: ${error?.message || String(error)}` };
    }
  }

  static #withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timeout while querying Docker daemon')), timeoutMs)
      )
    ]);
  }

  /**
   * @param {any} error
   * @returns {{code: string, message: string, details: Object}}
   */
  static #normalizeDockerodeError(error) {
    const code = error?.code || '';
    const message = error?.message || String(error);
    const details = {
      code,
      errno: error?.errno,
      syscall: error?.syscall,
      address: error?.address,
      port: error?.port
    };

    if (code === 'EACCES' || code === 'EPERM') {
      return { code: 'PERMISSION_DENIED', message: 'Permission denied accessing Docker', details };
    }

    if (code === 'ENOENT') {
      return { code: 'DOCKER_NOT_FOUND', message: 'Docker is not installed or not available', details };
    }

    if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
      return { code: 'DAEMON_UNAVAILABLE', message: 'Docker daemon is not reachable', details };
    }

    // Some dockerode errors come from HTTP responses and include statusCode.
    const statusCode = error?.statusCode;
    if (typeof statusCode === 'number' && statusCode === 401) {
      return { code: 'UNAUTHORIZED', message: 'Unauthorized to access Docker daemon', details: { ...details, statusCode } };
    }

    return { code: 'DOCKER_ERROR', message, details };
  }
}
