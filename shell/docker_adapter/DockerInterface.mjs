/**
 * Docker Version Management - Stage 1
 * DockerInterface abstract base class (ESM).
 *
 * IMPORTANT:
 * - This module is ESM by requirement (DI-001).
 * - Concrete implementations live in `./impl/*` and are loaded on demand (DI-002).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCKER_CONTEXT_TIMEOUT_MS = 1200;

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
 * @property {"docker_desktop"|"docker_engine"|"colima"|"orbstack"|"rancher_desktop"|"podman"|"wsl_engine"|"unknown"} dockerFlavor
 * @property {string|null} daemonVersion
 * @property {string|null} diagnosticCode
 * @property {string|null} diagnosticMessage
 * @property {Object|null} diagnosticDetails
 * @property {RuntimeEndpointCandidate[]} runtimeCandidates
 * @property {string|null} selectedRuntimeEndpointId
 */

/**
 * @typedef {Object} RuntimeEndpointCandidate
 * @property {string} id
 * @property {string} label
 * @property {string} provider
 * @property {string} dockerHost
 * @property {string} source
 * @property {boolean} available
 * @property {boolean} isSelected
 * @property {string|null} diagnosticCode
 * @property {string|null} diagnosticMessage
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
 * @property {string=} dockerHost
 * @property {Object=} runtimePreference
 * @property {boolean=} forceRefresh
 */

/**
 * @typedef {Object} DetectEnvironmentOptions
 * @property {number=} timeoutMs
 * @property {string=} dockerHost
 * @property {boolean=} enableWindowsWslProxy
 * @property {Object=} runtimePreference
 * @property {Object=} env
 * @property {NodeJS.Platform=} platform
 * @property {string=} arch
 * @property {string=} homeDir
 * @property {string=} runtimeDir
 * @property {Array<Object|string>=} candidateHosts
 * @property {Array<Object>=} dockerContexts
 * @property {boolean=} discoverDockerContexts
 * @property {Function=} runCommand
 * @property {Function=} dockerodeClass
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

    const context = this.#detectionContext(options);
    const explicitDockerHostRaw = (options.dockerHost || context.env.DOCKER_HOST || '').trim();
    const candidates = await this.#runtimeEndpointCandidates({
      ...context,
      explicitDockerHostRaw,
      runtimePreference: options.runtimePreference
    });

    let Dockerode;
    try {
      if (typeof options.dockerodeClass === 'function') {
        Dockerode = options.dockerodeClass;
      } else {
        const imported = await import('dockerode');
        Dockerode = imported?.default || imported;
      }
    } catch (error) {
      const info = this.#baseEnvironmentInfo(this.#parseDockerHost(explicitDockerHostRaw), context);
      info.diagnosticCode = 'DOCKERODE_MISSING';
      info.diagnosticMessage = 'dockerode dependency is not available';
      info.diagnosticDetails = { message: error?.message || String(error) };
      info.runtimeCandidates = this.#publicRuntimeCandidates(candidates, '');
      return info;
    }

    const probed = await Promise.all(candidates.map((candidate) =>
      this.#probeRuntimeCandidate(candidate, Dockerode, timeoutMs, options, context)
    ));
    const selected = this.#selectRuntimeCandidate(probed);

    if (selected?.available) {
      const dockerHost = this.#parseDockerHost(selected.dockerHost);
      const info = this.#baseEnvironmentInfo(dockerHost, context, selected);
      info.dockerAvailable = true;
      info.daemonVersion = selected.daemonVersion || null;
      info.diagnosticCode = null;
      info.diagnosticMessage = null;
      info.diagnosticDetails = null;
      info.runtimeCandidates = this.#publicRuntimeCandidates(probed, selected.id);
      info.selectedRuntimeEndpointId = selected.id;
      return info;
    }

    let bestFailure = null;
    for (const candidate of probed) {
      const dockerHost = this.#parseDockerHost(candidate.dockerHost);
      const info = this.#baseEnvironmentInfo(dockerHost, context, candidate);
      info.diagnosticCode = candidate.diagnosticCode || null;
      info.diagnosticMessage = candidate.diagnosticMessage || null;
      info.diagnosticDetails = candidate.diagnosticDetails || null;
      bestFailure = this.#preferDiagnostic(bestFailure, info);
    }

    const fallback = bestFailure || this.#baseEnvironmentInfo(this.#parseDockerHost(explicitDockerHostRaw), context);
    fallback.runtimeCandidates = this.#publicRuntimeCandidates(probed, '');
    return fallback;
  }

  static async #probeRuntimeCandidate(candidate, Dockerode, timeoutMs, options, context) {
    const dockerHost = this.#parseDockerHost(candidate.dockerHost);
    const result = {
      ...candidate,
      available: false,
      daemonVersion: null,
      diagnosticCode: null,
      diagnosticMessage: null,
      diagnosticDetails: null
    };

    if (dockerHost.kind === 'invalid') {
      result.diagnosticCode = 'INVALID_DOCKER_HOST';
      result.diagnosticMessage = dockerHost.error || 'Invalid DOCKER_HOST';
      return result;
    }

    const candidateTimeoutMs = this.#isWindowsWslProxyHost(dockerHost, context.platform)
      ? Math.max(timeoutMs, 10000)
      : timeoutMs;

    const shouldPrepareHost = ['preference', 'env', 'active_context'].includes(candidate.source);
    if (options.enableWindowsWslProxy !== false && shouldPrepareHost) {
      await this.#prepareDockerHost(dockerHost, context.platform).catch(() => {});
    }

    const docker = new Dockerode(this.#dockerodeOptionsFromHost(dockerHost, candidateTimeoutMs));

    try {
      await this.#withTimeout(Promise.resolve(docker.ping()), candidateTimeoutMs);
      result.available = true;

      try {
        const v = await this.#withTimeout(Promise.resolve(docker.version()), candidateTimeoutMs);
        result.daemonVersion = typeof v?.Version === 'string' ? v.Version : null;
      } catch {
        // best-effort only
      }
    } catch (error) {
      const normalized = this.#normalizeDockerodeError(error);
      result.diagnosticCode = normalized.code;
      result.diagnosticMessage = normalized.message;
      result.diagnosticDetails = normalized.details;
    }

    return result;
  }

  /**
   * Retrieve a singleton DockerInterface implementation instance (DI-004).
   * @param {DockerInterfaceOptions=} options
   * @returns {Promise<DockerInterface>}
   */
  static async get(options = {}) {
    if (options?.forceRefresh) this.reset();
    if (this.#instance) return this.#instance;
    if (this.#instancePromise) return this.#instancePromise;

    this.#instancePromise = (async () => {
      const env = await this.detectEnvironment({
        dockerHost: options?.dockerHost,
        runtimePreference: options?.runtimePreference
      });
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

  static reset() {
    this.#instance = null;
    this.#instancePromise = null;
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
    if (this.env && Array.isArray(this.env.runtimeCandidates)) {
      return this.env;
    }
    const dockerHost = typeof this.env?.dockerHost?.raw === 'string' ? this.env.dockerHost.raw : '';
    return DockerInterface.detectEnvironment(this.env?.dockerAvailable && dockerHost ? { dockerHost } : {});
  }

  /**
   * Inspect the active Docker runtime using Docker Engine APIs.
   * @returns {Promise<Object>}
   */
  async getRuntimeDiagnostics() {
    throw new Error('DockerInterface.getRuntimeDiagnostics is abstract');
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
   * List Docker volumes.
   * @returns {Promise<Object[]>}
   */
  async listVolumes() {
    throw new Error('DockerInterface.listVolumes is abstract');
  }

  /**
   * Remove a Docker volume by name.
   * @param {string} _volumeName
   * @returns {Promise<void>}
   */
  async removeVolume(_volumeName) {
    throw new Error('DockerInterface.removeVolume is abstract');
  }

  /**
   * Prune dangling Docker volumes.
   * @returns {Promise<Object>}
   */
  async pruneVolumes() {
    throw new Error('DockerInterface.pruneVolumes is abstract');
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
   * Read a single text file from a container filesystem through Docker's archive API.
   * Returns null when the path is absent or not a regular file.
   *
   * @param {string} containerId
   * @param {string} filePath
   * @param {Object=} options
   * @param {number=} options.maxBytes
   * @returns {Promise<string|null>}
   */
  async readContainerTextFile(_containerId, _filePath, _options = {}) {
    throw new Error('DockerInterface.readContainerTextFile is abstract');
  }

  /**
   * Write a bounded UTF-8 text file into a container.
   * Intended for product workflows that need to materialize generated config
   * files; this is not exposed to the renderer as a file browser.
   *
   * @param {string} containerId
   * @param {string} filePath
   * @param {string} text
   * @returns {Promise<{written: boolean}>}
   */
  async writeContainerTextFile(_containerId, _filePath, _text) {
    throw new Error('DockerInterface.writeContainerTextFile is abstract');
  }

  /**
   * Ensure a container directory exists.
   *
   * @param {string} containerId
   * @param {string} directoryPath
   * @returns {Promise<{created: boolean}>}
   */
  async ensureContainerDirectory(_containerId, _directoryPath) {
    throw new Error('DockerInterface.ensureContainerDirectory is abstract');
  }

  /**
   * List immediate children of a container directory.
   *
   * @param {string} containerId
   * @param {string} directoryPath
   * @param {Object=} options
   * @param {number=} options.maxBytes
   * @returns {Promise<Array<{name: string, type: string}>>}
   */
  async listContainerDirectory(_containerId, _directoryPath, _options = {}) {
    throw new Error('DockerInterface.listContainerDirectory is abstract');
  }

  /**
   * Copy a container filesystem path into another container using Docker's archive API.
   * Intended for bounded product workflows such as workspace migration.
   *
   * @param {string} sourceContainerId
   * @param {string} sourcePath
   * @param {string} targetContainerId
   * @param {string} targetPath
   * @returns {Promise<{copied: boolean}>}
   */
  async copyContainerPathToContainer(_sourceContainerId, _sourcePath, _targetContainerId, _targetPath) {
    throw new Error('DockerInterface.copyContainerPathToContainer is abstract');
  }

  /**
   * Commit a container's writable layer to a local image reference.
   * Used by product-level clone workflows that need a real container snapshot.
   *
   * @param {string} containerId
   * @param {string} imageRef
   * @param {Object=} options
   * @param {boolean=} options.pause
   * @param {string=} options.comment
   * @param {string=} options.author
   * @returns {Promise<{imageRef: string, imageId: string|null}>}
   */
  async commitContainer(_containerId, _imageRef, _options = {}) {
    throw new Error('DockerInterface.commitContainer is abstract');
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

  static #detectionContext(options = {}) {
    const env = options.env && typeof options.env === 'object' ? options.env : process.env;
    const platform = options.platform || process.platform;
    const arch = options.arch || process.arch;
    const homeDir = typeof options.homeDir === 'string' ? options.homeDir : os.homedir();
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    const runtimeDir = typeof options.runtimeDir === 'string'
      ? options.runtimeDir
      : env.XDG_RUNTIME_DIR || (uid !== '' ? `/run/user/${uid}` : '');
    return { env, platform, arch, homeDir, runtimeDir, options };
  }

  static #baseEnvironmentInfo(dockerHost, context = {}, candidate = null) {
    return {
      platform: context.platform || process.platform,
      arch: context.arch || process.arch,
      dockerHost,
      dockerAvailable: false,
      dockerFlavor: this.#detectDockerFlavor(dockerHost, candidate, context.platform || process.platform),
      daemonVersion: null,
      diagnosticCode: null,
      diagnosticMessage: null,
      diagnosticDetails: null,
      runtimeCandidates: [],
      selectedRuntimeEndpointId: null
    };
  }

  static async #runtimeEndpointCandidates(context) {
    const out = [];
    const preference = this.#normalizeRuntimePreference(context.runtimePreference);
    if (preference?.dockerHost) {
      out.push(this.#makeCandidate({
        dockerHost: preference.dockerHost,
        provider: preference.provider || this.#providerForHost(preference.dockerHost, preference.label),
        label: preference.label || '',
        source: 'preference',
        id: preference.id || '',
        priority: 0
      }));
    }

    if (context.explicitDockerHostRaw) {
      out.push(this.#makeCandidate({
        dockerHost: context.explicitDockerHostRaw,
        provider: this.#providerForHost(context.explicitDockerHostRaw, 'Environment'),
        label: 'Environment runtime',
        source: 'env',
        priority: 10
      }));
    }

    for (const candidate of await this.#dockerContextCandidates(context)) {
      out.push(candidate);
    }

    const fallbackHosts = Array.isArray(context.options?.candidateHosts)
      ? context.options.candidateHosts
      : this.#platformRuntimeCandidates(context);
    let priority = 50;
    for (const item of fallbackHosts) {
      if (!item) continue;
      if (typeof item === 'string') {
        out.push(this.#makeCandidate({
          dockerHost: item,
          provider: this.#providerForHost(item, ''),
          source: 'known_socket',
          priority: priority++
        }));
      } else if (typeof item === 'object') {
        out.push(this.#makeCandidate({
          ...item,
          priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : priority++
        }));
      }
    }

    return this.#dedupeRuntimeCandidates(out);
  }

  static #platformRuntimeCandidates(context) {
    const home = context.homeDir || os.homedir();
    const runtimeDir = context.runtimeDir || '';

    if (context.platform === 'darwin') {
      return [
        { provider: 'orbstack', label: 'OrbStack', dockerHost: `unix://${home}/.orbstack/run/docker.sock`, source: 'known_socket' },
        { provider: 'colima', label: 'Colima', dockerHost: `unix://${home}/.colima/a0/docker.sock`, source: 'known_socket' },
        { provider: 'colima', label: 'Colima default', dockerHost: `unix://${home}/.colima/default/docker.sock`, source: 'known_socket' },
        { provider: 'docker_desktop', label: 'Docker Desktop', dockerHost: `unix://${home}/.docker/run/docker.sock`, source: 'known_socket' },
        { provider: 'rancher_desktop', label: 'Rancher Desktop', dockerHost: `unix://${home}/.rd/docker.sock`, source: 'known_socket' },
        { provider: 'podman', label: 'Podman', dockerHost: `unix://${home}/.local/share/containers/podman/machine/podman-machine-default/podman.sock`, source: 'known_socket' },
        { provider: 'podman', label: 'Podman', dockerHost: `unix://${home}/.local/share/containers/podman/machine/qemu/podman.sock`, source: 'known_socket' },
        { provider: 'docker_engine', label: 'Docker Engine', dockerHost: 'unix:///var/run/docker.sock', source: 'known_socket' }
      ];
    }

    if (context.platform === 'win32') {
      return [
        { provider: 'docker_desktop', label: 'Docker Desktop', dockerHost: 'npipe:////./pipe/docker_engine', source: 'known_socket' },
        { provider: 'wsl_engine', label: 'Agent Zero local runtime', dockerHost: 'tcp://127.0.0.1:23750', source: 'known_socket' }
      ];
    }

    if (context.platform === 'linux') {
      return [
        { provider: 'docker_engine', label: 'Docker Engine', dockerHost: 'unix:///var/run/docker.sock', source: 'known_socket' },
        { provider: 'docker_desktop', label: 'Docker Desktop', dockerHost: `unix://${home}/.docker/desktop/docker.sock`, source: 'known_socket' },
        runtimeDir ? { provider: 'docker_engine', label: 'Rootless Docker', dockerHost: `unix://${runtimeDir}/docker.sock`, source: 'known_socket' } : null,
        runtimeDir ? { provider: 'podman', label: 'Podman', dockerHost: `unix://${runtimeDir}/podman/podman.sock`, source: 'known_socket' } : null,
        { provider: 'rancher_desktop', label: 'Rancher Desktop', dockerHost: `unix://${home}/.rd/docker.sock`, source: 'known_socket' }
      ].filter(Boolean);
    }

    return [''];
  }

  static async #dockerContextCandidates(context) {
    const contexts = Array.isArray(context.options?.dockerContexts)
      ? context.options.dockerContexts
      : context.options?.discoverDockerContexts === false
        ? []
        : await this.#discoverDockerContexts(context);
    const out = [];
    let priority = 20;

    for (const entry of contexts) {
      const name = typeof entry?.Name === 'string' ? entry.Name : typeof entry?.name === 'string' ? entry.name : '';
      const dockerHost = entry?.Endpoints?.docker?.Host || entry?.endpoints?.docker?.host || entry?.dockerHost || '';
      if (!dockerHost) continue;
      const active = entry?.Current === true || entry?.current === true || entry?.active === true;
      const label = active ? `${name || 'Docker context'} (current)` : name || 'Docker context';
      out.push(this.#makeCandidate({
        dockerHost,
        provider: this.#providerForHost(dockerHost, name),
        label,
        source: active ? 'active_context' : 'docker_context',
        priority: active ? priority++ : priority + 20
      }));
    }

    return out;
  }

  static async #discoverDockerContexts(context) {
    const runCommand = typeof context.options?.runCommand === 'function'
      ? context.options.runCommand
      : (cmd, args, options = {}) => execFileAsync(cmd, args, options);

    let current = '';
    try {
      const result = await runCommand('docker', ['context', 'show'], { timeout: DOCKER_CONTEXT_TIMEOUT_MS });
      current = String(result?.stdout || '').trim();
    } catch {
      return [];
    }

    let names = [];
    try {
      const result = await runCommand('docker', ['context', 'ls', '--format', '{{.Name}}'], { timeout: DOCKER_CONTEXT_TIMEOUT_MS });
      names = String(result?.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^\*\s*/, ''))
        .filter(Boolean);
    } catch {
      names = current ? [current] : [];
    }

    if (current && !names.includes(current)) names.unshift(current);
    const uniqueNames = [...new Set(names)].slice(0, 24);
    const contexts = [];

    for (const name of uniqueNames) {
      try {
        const result = await runCommand('docker', ['context', 'inspect', name], { timeout: DOCKER_CONTEXT_TIMEOUT_MS });
        const parsed = JSON.parse(String(result?.stdout || '[]'));
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            contexts.push({ ...entry, Current: entry.Current === true || entry.Name === current });
          }
        }
      } catch {
        // Context discovery is advisory; ignore unreadable contexts.
      }
    }

    return contexts;
  }

  static #normalizeRuntimePreference(value) {
    if (!value || typeof value !== 'object') return null;
    const dockerHost = typeof value.dockerHost === 'string' ? value.dockerHost.trim() : '';
    if (!dockerHost) return null;
    return {
      id: typeof value.id === 'string' ? value.id.trim() : '',
      label: typeof value.label === 'string' ? value.label.trim() : '',
      provider: typeof value.provider === 'string' ? value.provider.trim() : '',
      dockerHost
    };
  }

  static #makeCandidate(input = {}) {
    const dockerHost = String(input.dockerHost || '').trim();
    const provider = String(input.provider || this.#providerForHost(dockerHost, input.label || '') || 'unknown').trim();
    const label = String(input.label || this.#labelForProvider(provider)).trim() || 'Container runtime';
    const id = String(input.id || this.#candidateId(provider, dockerHost)).trim();
    return {
      id,
      label,
      provider,
      dockerHost,
      source: String(input.source || 'known_socket').trim(),
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100,
      available: false,
      isSelected: false,
      diagnosticCode: null,
      diagnosticMessage: null
    };
  }

  static #dedupeRuntimeCandidates(candidates) {
    const byKey = new Map();
    for (const candidate of candidates) {
      if (!candidate?.dockerHost) continue;
      const key = this.#hostKey(this.#parseDockerHost(candidate.dockerHost));
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing || Number(candidate.priority) < Number(existing.priority)) {
        byKey.set(key, candidate);
      }
    }
    return [...byKey.values()].sort((a, b) => Number(a.priority) - Number(b.priority));
  }

  static #selectRuntimeCandidate(candidates) {
    return candidates
      .filter((candidate) => candidate?.available)
      .sort((a, b) => Number(a.priority) - Number(b.priority))[0] || null;
  }

  static #publicRuntimeCandidates(candidates, selectedId) {
    return candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      provider: candidate.provider,
      dockerHost: candidate.dockerHost,
      source: candidate.source,
      available: candidate.available === true,
      isSelected: !!selectedId && candidate.id === selectedId,
      diagnosticCode: candidate.diagnosticCode || null,
      diagnosticMessage: candidate.diagnosticMessage || null
    }));
  }

  static #candidateId(provider, dockerHost) {
    const basis = `${provider || 'runtime'}-${dockerHost || 'default'}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96);
    return `runtime-${basis || 'default'}`;
  }

  static #hostKey(hostInfo) {
    if (!hostInfo || hostInfo.kind === 'invalid') return '';
    if (hostInfo.kind === 'default') return 'default';
    if (hostInfo.kind === 'unix' || hostInfo.kind === 'npipe') return `${hostInfo.kind}:${hostInfo.socketPath}`;
    if (hostInfo.kind === 'tcp' || hostInfo.kind === 'http' || hostInfo.kind === 'https') {
      return `${hostInfo.kind}:${hostInfo.protocol}:${hostInfo.host}:${hostInfo.port}`;
    }
    return `${hostInfo.kind}:${hostInfo.raw}`;
  }

  static #providerForHost(dockerHost, hint = '') {
    const raw = `${dockerHost || ''} ${hint || ''}`.toLowerCase();
    if (raw.includes('orbstack')) return 'orbstack';
    if (raw.includes('rancher') || raw.includes('/.rd/')) return 'rancher_desktop';
    if (raw.includes('podman')) return 'podman';
    if (raw.includes('colima')) return 'colima';
    if (raw.includes('desktop') || raw.includes('/.docker/run/docker.sock') || raw.includes('/.docker/desktop/')) return 'docker_desktop';
    if (raw.includes('127.0.0.1:23750')) return 'wsl_engine';
    if (raw.includes('npipe:')) return 'docker_desktop';
    if (raw.includes('rootless')) return 'docker_engine';
    return 'docker_engine';
  }

  static #labelForProvider(provider) {
    switch (provider) {
      case 'orbstack':
        return 'OrbStack';
      case 'rancher_desktop':
        return 'Rancher Desktop';
      case 'podman':
        return 'Podman';
      case 'colima':
        return 'Colima';
      case 'docker_desktop':
        return 'Docker Desktop';
      case 'wsl_engine':
        return 'Agent Zero local runtime';
      case 'docker_engine':
        return 'Docker Engine';
      default:
        return 'Container runtime';
    }
  }

  static #detectDockerFlavor(hostInfo = null, candidate = null, platform = process.platform) {
    if (candidate?.provider) return candidate.provider;
    const raw = `${hostInfo?.raw || ''} ${hostInfo?.socketPath || ''}`.toLowerCase();
    if (raw.includes('/.orbstack/')) return 'orbstack';
    if (raw.includes('/.rd/')) return 'rancher_desktop';
    if (raw.includes('podman')) return 'podman';
    if (raw.includes('/.colima/')) return 'colima';
    if (raw.includes('/.docker/desktop/') || raw.includes('/.docker/run/docker.sock')) return 'docker_desktop';
    if (hostInfo?.kind === 'npipe') return 'docker_desktop';
    if (hostInfo?.kind === 'tcp' && hostInfo.host === '127.0.0.1' && Number(hostInfo.port) === 23750) return 'wsl_engine';
    if (platform === 'darwin' || platform === 'win32') return 'docker_desktop';
    if (platform === 'linux') return 'docker_engine';
    return 'unknown';
  }

  static #isWindowsWslProxyHost(hostInfo, platform = process.platform) {
    return platform === 'win32' && hostInfo?.kind === 'tcp' && hostInfo.host === '127.0.0.1' && Number(hostInfo.port) === 23750;
  }

  static async #prepareDockerHost(hostInfo, platform = process.platform) {
    if (platform !== 'win32') return;
    if (!this.#isWindowsWslProxyHost(hostInfo, platform)) return;
    const { ensureWindowsWslDockerProxy } = await import('./impl/WindowsWslDockerProxy.mjs');
    await ensureWindowsWslDockerProxy();
  }

  static #preferDiagnostic(current, candidate) {
    if (!current) return candidate;
    if (!candidate) return current;
    return this.#diagnosticRank(candidate) > this.#diagnosticRank(current) ? candidate : current;
  }

  static #diagnosticRank(info) {
    switch (info?.diagnosticCode) {
      case 'INVALID_DOCKER_HOST':
        return 60;
      case 'PERMISSION_DENIED':
        return 50;
      case 'DAEMON_UNAVAILABLE':
        return 40;
      case 'UNAUTHORIZED':
        return 35;
      case 'DOCKER_ERROR':
        return 25;
      case 'DOCKER_NOT_FOUND':
        return 15;
      default:
        return 0;
    }
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

    const canonicalNpipe = raw.match(/^npipe:(?:\/\/\/\/\.|\/\/\.)\/(.*)$/i);
    if (canonicalNpipe) {
      const pipePath = decodeURIComponent(canonicalNpipe[1] || '').replace(/^\/+/, '');
      if (!pipePath) return { raw, kind: 'invalid', error: 'Missing npipe path in DOCKER_HOST' };
      return { raw, kind: 'npipe', socketPath: `//./${pipePath}` };
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
        if (u.hostname) {
          p = `//${u.hostname}/${p.replace(/^\/+/, '')}`;
        }
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
