import Dockerode from 'dockerode';
import { once } from 'node:events';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DockerInterface } from '../DockerInterface.mjs';
import { resolveDockerAuthConfigForImage } from './DockerAuthConfig.mjs';
import { DockerHubRegistry } from './DockerHubRegistry.mjs';
import {
  followContainerLogs as dockerodeFollowContainerLogs,
  readContainerLogs as dockerodeReadContainerLogs
} from './DockerodeLogProcessor.mjs';

function makeOpId() {
  const rand = Math.random().toString(16).slice(2, 8);
  return `pull_${Date.now()}_${rand}`;
}

function imageRepoFromRef(imageRef) {
  const ref = (imageRef || '').trim();
  if (!ref) return '';
  const at = ref.indexOf('@');
  const colon = ref.lastIndexOf(':');
  if (at !== -1) return ref.slice(0, at);
  if (colon !== -1 && colon > ref.indexOf('/')) return ref.slice(0, colon);
  return ref;
}

function tagFromRef(imageRef) {
  const ref = (imageRef || '').trim();
  if (!ref) return '';
  const at = ref.indexOf('@');
  const colon = ref.lastIndexOf(':');
  if (at !== -1) return '';
  if (colon !== -1 && colon > ref.indexOf('/')) return ref.slice(colon + 1);
  return '';
}

function splitTaggedImageRef(imageRef) {
  const ref = (imageRef || '').trim();
  const lastSlash = ref.lastIndexOf('/');
  const lastColon = ref.lastIndexOf(':');
  if (!ref || lastColon <= lastSlash || lastColon === ref.length - 1) {
    throw makeDockerInterfaceError('INVALID_IMAGE', 'imageRef must include a repository and tag');
  }
  return {
    repo: ref.slice(0, lastColon),
    tag: ref.slice(lastColon + 1)
  };
}

function bestUiPortFromList(ports) {
  const candidates = [];
  for (const port of Array.isArray(ports) ? ports : []) {
    const privatePort = Number(port?.PrivatePort);
    const publicPort = Number(port?.PublicPort);
    if (!Number.isFinite(privatePort) || privatePort <= 0 || privatePort > 65535) continue;
    if (!Number.isFinite(publicPort) || publicPort <= 0 || publicPort > 65535) continue;
    candidates.push({ privatePort, publicPort });
  }

  if (!candidates.length) return null;
  const preferredPrivatePorts = [80, 7860, 3000, 8080, 5000, 9000, 9001, 9002];
  for (const p of preferredPrivatePorts) {
    const match = candidates.find((candidate) => candidate.privatePort === p);
    if (match) return match;
  }

  candidates.sort((a, b) => a.publicPort - b.publicPort);
  return candidates.find((candidate) => candidate.privatePort !== 22) || candidates[0];
}

function safeIsoNow() {
  return new Date().toISOString();
}

function makeDockerInterfaceError(code, message, details = {}, cause = null) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.name = 'DockerInterfaceError';
  err.code = code;
  err.details = details;
  return err;
}

function normalizeDockerError(error, context = {}) {
  const code = error?.code || '';
  const statusCode = error?.statusCode;
  const message = typeof error?.message === 'string' ? error.message : '';

  const details = {
    ...context,
    code,
    errno: error?.errno,
    syscall: error?.syscall,
    address: error?.address,
    port: error?.port,
    statusCode
  };

  if (typeof statusCode === 'number' && statusCode === 429) {
    return makeDockerInterfaceError('DOCKER_PULL_RATE_LIMIT', 'Docker Hub pull rate limit exceeded', details, error);
  }
  if (message && /(?:pull\s+)?rate limit|too many requests/i.test(message)) {
    return makeDockerInterfaceError('DOCKER_PULL_RATE_LIMIT', 'Docker Hub pull rate limit exceeded', details, error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return makeDockerInterfaceError('PERMISSION_DENIED', 'Permission denied accessing Docker', details, error);
  }
  if (code === 'ENOENT') {
    return makeDockerInterfaceError('DOCKER_NOT_FOUND', 'Docker is not installed or not available', details, error);
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
    return makeDockerInterfaceError('DAEMON_UNAVAILABLE', 'Docker daemon is not reachable', details, error);
  }
  if (typeof statusCode === 'number' && statusCode === 404) {
    return makeDockerInterfaceError('NOT_FOUND', 'Docker resource not found', details, error);
  }
  if (typeof statusCode === 'number' && statusCode === 409) {
    return makeDockerInterfaceError('CONFLICT', 'Docker operation conflict', details, error);
  }

  return makeDockerInterfaceError('DOCKER_ERROR', error?.message || 'Docker operation failed', details, error);
}

function validateContainerFilePath(value) {
  const filePath = String(value || '').trim();
  if (!filePath || !filePath.startsWith('/')) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'filePath must be an absolute container path');
  }
  if (filePath.length > 4096 || /[\0\r\n]/.test(filePath)) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'filePath is invalid');
  }
  return filePath;
}

function clampReadBytes(value) {
  const fallback = 64 * 1024;
  const max = Number(value);
  if (!Number.isFinite(max)) return fallback;
  return Math.max(1, Math.min(1024 * 1024, Math.floor(max)));
}

function clampArchiveListBytes(value) {
  const fallback = 8 * 1024 * 1024;
  const max = Number(value);
  if (!Number.isFinite(max)) return fallback;
  return Math.max(1, Math.min(64 * 1024 * 1024, Math.floor(max)));
}

function textOrNull(value, maxLength = 240) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.slice(0, maxLength);
}

function finiteNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringList(value, limit = 12, maxLength = 180) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    const text = textOrNull(item, maxLength);
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function driverStatusList(value) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of source) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const label = textOrNull(item[0], 80);
    const detail = textOrNull(item[1], 180);
    if (label && detail) out.push({ label, detail });
    if (out.length >= 8) break;
  }
  return out;
}

function isZeroTarBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function tarHeaderSize(header) {
  const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
  if (!sizeText) return 0;
  const parsed = Number.parseInt(sizeText, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function tarHeaderName(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
  return `${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\/+/, '');
}

function tarPaddedSize(size) {
  return Math.ceil(size / 512) * 512;
}

function tarWriteString(header, value, offset, length) {
  const text = String(value || '').slice(0, length);
  header.write(text, offset, Math.min(Buffer.byteLength(text), length), 'utf8');
}

function tarWriteOctal(header, value, offset, length) {
  const text = Math.max(0, Number(value) || 0)
    .toString(8)
    .padStart(Math.max(0, length - 1), '0')
    .slice(-(length - 1));
  header.write(text, offset, length - 1, 'ascii');
  header[offset + length - 1] = 0;
}

function tarFinalizeChecksum(header) {
  for (let i = 148; i < 156; i += 1) header[i] = 32;
  let sum = 0;
  for (const byte of header) sum += byte;
  const text = sum.toString(8).padStart(6, '0').slice(-6);
  header.write(text, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 32;
}

function tarArchiveForEntry(name, data = Buffer.alloc(0), typeflag = '0') {
  const cleanName = String(name || '').replace(/^\/+/, '');
  if (!cleanName || cleanName.includes('\0')) {
    throw makeDockerInterfaceError('INVALID_INPUT', 'archive entry name is invalid');
  }
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const header = Buffer.alloc(512);
  tarWriteString(header, cleanName, 0, 100);
  tarWriteOctal(header, typeflag === '5' ? 0o755 : 0o644, 100, 8);
  tarWriteOctal(header, 0, 108, 8);
  tarWriteOctal(header, 0, 116, 8);
  tarWriteOctal(header, typeflag === '5' ? 0 : body.length, 124, 12);
  tarWriteOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header[156] = typeflag.charCodeAt(0);
  tarWriteString(header, 'ustar', 257, 6);
  tarWriteString(header, '00', 263, 2);
  tarFinalizeChecksum(header);

  const paddedSize = tarPaddedSize(body.length);
  return Buffer.concat([
    header,
    body,
    Buffer.alloc(paddedSize - body.length),
    Buffer.alloc(1024)
  ]);
}

function immediateChildrenFromTar(archive, directoryPath) {
  if (!Buffer.isBuffer(archive) || archive.length < 512) return [];
  const rootName = path.posix.basename(String(directoryPath || '').replace(/\/+$/u, ''));
  const entries = new Map();

  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroTarBlock(header)) break;

    const size = tarHeaderSize(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) break;

    const rawName = tarHeaderName(header).replace(/\/+$/u, '');
    let parts = rawName.split('/').filter(Boolean);
    if (parts[0] === rootName) parts = parts.slice(1);
    if (parts.length > 0) {
      const name = parts[0];
      if (name && name !== '.' && name !== '..' && !name.includes('/')) {
        const typeflag = header[156];
        const type = typeflag === 53 || parts.length > 1 ? 'directory' : 'file';
        const previous = entries.get(name);
        entries.set(name, {
          name,
          type: previous?.type === 'directory' || type === 'directory' ? 'directory' : 'file'
        });
      }
    }

    offset = dataStart + tarPaddedSize(size);
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractFirstRegularFileFromTar(archive, maxBytes) {
  if (!Buffer.isBuffer(archive) || archive.length < 512) return null;

  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (isZeroTarBlock(header)) return null;

    const size = tarHeaderSize(header);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) return null;

    const typeflag = header[156];
    if (typeflag === 0 || typeflag === 48) {
      return archive.subarray(dataStart, Math.min(dataEnd, dataStart + maxBytes));
    }

    offset = dataStart + tarPaddedSize(size);
  }

  return null;
}

async function streamToBuffer(stream, maxBytes) {
  if (!stream || typeof stream.on !== 'function') return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  stream.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const err = makeDockerInterfaceError('OUTPUT_TOO_LARGE', 'Container file archive exceeded the read limit');
      try {
        stream.destroy(err);
      } catch {
        // ignore
      }
      return;
    }
    chunks.push(buffer);
  });

  await once(stream, 'end');
  return Buffer.concat(chunks, total);
}

function dockerodeOptionsFromEnv(env) {
  const hostInfo = env?.dockerHost;
  const base = { timeout: 0 };
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

export class DockerodeDocker extends DockerInterface {
  /**
   * @param {Object=} options
   * @param {import('../DockerInterface.mjs').DockerEnvironmentInfo=} options.env
   * @param {string=} options.imageRepo
   */
  constructor(options = {}) {
    super({ imageRepo: options?.imageRepo });
    this.env = options?.env || null;

    this.docker = new Dockerode(dockerodeOptionsFromEnv(this.env));
    this.registry = new DockerHubRegistry({ userAgent: 'A0-Launcher' });

    /** @type {Map<string, any>} */
    this._pulls = new Map();
  }

  async getRuntimeDiagnostics() {
    try {
      const [version, info] = await Promise.all([
        Promise.resolve(this.docker.version()),
        Promise.resolve(this.docker.info())
      ]);
      const securityOptions = stringList(info?.SecurityOptions, 16, 180);
      return {
        checkedAt: safeIsoNow(),
        reachable: true,
        dockerHost: textOrNull(this.env?.dockerHost?.raw, 500),
        dockerHostKind: textOrNull(this.env?.dockerHost?.kind, 40),
        dockerFlavor: textOrNull(this.env?.dockerFlavor, 80),
        serverVersion: textOrNull(version?.Version || info?.ServerVersion, 120),
        apiVersion: textOrNull(version?.ApiVersion, 80),
        minApiVersion: textOrNull(version?.MinAPIVersion, 80),
        gitCommit: textOrNull(version?.GitCommit, 80),
        goVersion: textOrNull(version?.GoVersion, 120),
        os: textOrNull(version?.Os || info?.OSType, 80),
        arch: textOrNull(version?.Arch || info?.Architecture, 80),
        operatingSystem: textOrNull(info?.OperatingSystem, 180),
        kernelVersion: textOrNull(info?.KernelVersion, 180),
        dockerRootDir: textOrNull(info?.DockerRootDir, 500),
        storageDriver: textOrNull(info?.Driver, 120),
        loggingDriver: textOrNull(info?.LoggingDriver, 120),
        cgroupDriver: textOrNull(info?.CgroupDriver, 120),
        cgroupVersion: textOrNull(info?.CgroupVersion, 80),
        rootless: securityOptions.some((item) => /rootless/i.test(item)),
        securityOptions,
        containers: {
          total: finiteNumberOrNull(info?.Containers),
          running: finiteNumberOrNull(info?.ContainersRunning),
          paused: finiteNumberOrNull(info?.ContainersPaused),
          stopped: finiteNumberOrNull(info?.ContainersStopped)
        },
        images: finiteNumberOrNull(info?.Images),
        cpus: finiteNumberOrNull(info?.NCPU),
        memoryBytes: finiteNumberOrNull(info?.MemTotal),
        liveRestoreEnabled: typeof info?.LiveRestoreEnabled === 'boolean' ? info.LiveRestoreEnabled : null,
        swarmLocalNodeState: textOrNull(info?.Swarm?.LocalNodeState, 80),
        warnings: stringList(info?.Warnings, 8, 220),
        driverStatus: driverStatusList(info?.DriverStatus)
      };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'getRuntimeDiagnostics', env: this.#envSummary() });
    }
  }

  async listRemoteTags(imageRepo) {
    try {
      const { tags } = await this.registry.listTags((imageRepo || this.imageRepo).trim());
      return tags;
    } catch (error) {
      // Registry errors already carry structured codes; annotate with env context.
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async getRemoteDigest(imageRepo, tag) {
    try {
      const r = await this.registry.getDigest((imageRepo || this.imageRepo).trim(), tag);
      return {
        exists: !!r.exists,
        digest: r.digest || null,
        contentType: r.contentType || null,
        rateLimit: r.rateLimit || null
      };
    } catch (error) {
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async getRemoteLayerSizes(imageRepo, tag, options = {}) {
    try {
      const desiredArch = (options?.arch || this.env?.arch || process.arch || '').trim();
      const arch = desiredArch === 'x64' ? 'amd64' : desiredArch;
      const desiredOs = (options?.os || this.env?.platform || 'linux').trim() || 'linux';
      const variant = (options?.variant || '').trim() || null;
      const r = await this.registry.getLayerSizes((imageRepo || this.imageRepo).trim(), tag, { os: desiredOs, arch, variant });
      return r;
    } catch (error) {
      if (error && typeof error === 'object') {
        error.details = { ...(error.details || {}), env: this.#envSummary() };
      }
      throw error;
    }
  }

  async listLocalImages(imageRepo) {
    const repo = (imageRepo || this.imageRepo).trim();
    if (!repo) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRepo is required');

    try {
      const images = await Promise.resolve(this.docker.listImages({ all: true }));
      const results = [];

      for (const img of images || []) {
        const repoTags = Array.isArray(img?.RepoTags) ? img.RepoTags : [];
        const repoDigests = Array.isArray(img?.RepoDigests) ? img.RepoDigests : [];
        const id = typeof img?.Id === 'string' ? img.Id : null;
        const sizeBytes = Number.isFinite(Number(img?.Size)) ? Number(img.Size) : null;
        const createdAtMs = Number.isFinite(Number(img?.Created)) ? Number(img.Created) * 1000 : null;

        for (const rt of repoTags) {
          if (typeof rt !== 'string') continue;
          if (!rt.startsWith(`${repo}:`)) continue;
          results.push({
            imageRef: rt,
            tag: rt.slice(repo.length + 1),
            imageId: id,
            sizeBytes,
            createdAt: createdAtMs,
            repoDigests
          });
        }
      }

      return results;
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listLocalImages', repo, env: this.#envSummary() });
    }
  }

  async removeLocalImage(imageRef) {
    const ref = (imageRef || '').trim();
    if (!ref) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRef is required');

    try {
      const img = this.docker.getImage(ref);
      await new Promise((resolve, reject) => {
        img.remove({ force: true }, (err) => (err ? reject(err) : resolve()));
      });
    } catch (error) {
      throw normalizeDockerError(error, { op: 'removeLocalImage', imageRef: ref, env: this.#envSummary() });
    }
  }

  async pullImage(imageRef, options = {}) {
    const ref = (imageRef || '').trim();
    if (!ref) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRef is required');

    const opId = makeOpId();
    const startedAt = safeIsoNow();

    const pullState = {
      opId,
      imageRef: ref,
      status: 'running',
      progress: null,
      message: null,
      canCancel: true,
      startedAt,
      _layers: new Map(),
      _lastNewLayerAtMs: Date.now(),
      _dlDenomFrozen: 0,
      _xDenomFrozen: 0,
      _lastDlPercent: 0,
      _lastXPercent: 0,
      _stream: null,
      _abortListener: null
    };

    this._pulls.set(opId, pullState);

    const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
    const signal = options?.signal;
    let authconfig = null;

    try {
      if (signal) {
        const listener = () => {
          this.cancelPull(opId).catch(() => {});
        };
        pullState._abortListener = listener;

        if (signal.aborted) {
          await this.cancelPull(opId);
          return { opId, status: 'aborted_client' };
        }

        try {
          signal.addEventListener('abort', listener, { once: true });
        } catch {
          // ignore
        }
      }

      authconfig = await resolveDockerAuthConfigForImage(ref);
      if (pullState.status === 'aborted_client') return { opId, status: 'aborted_client' };

      const pullOptions = authconfig ? { authconfig } : {};
      const stream = await new Promise((resolve, reject) => {
        this.docker.pull(ref, pullOptions, (err, s) => (err ? reject(err) : resolve(s)));
      });

      pullState._stream = stream;
      const abortPullStream = () => {
        if (stream && typeof stream.destroy === 'function') {
          try {
            stream.destroy();
          } catch {
            // ignore
          }
        }
        pullState.status = 'aborted_client';
        pullState.canCancel = false;
        pullState.message = 'aborted_client';
        this._pulls.delete(opId);
      };

      if (pullState.status === 'aborted_client' || signal?.aborted) {
        abortPullStream();
        return { opId, status: 'aborted_client' };
      }

      // Best-effort manifest layer sizes to stabilize denominators and avoid 99% stalls.
      const repo = imageRepoFromRef(ref);
      const tag = tagFromRef(ref);
      /** @type {{layersById: Map<string, number>, totalBytes: number}|null} */
      let prefetched = null;
      if (repo && tag) {
        try {
          const r = await this.getRemoteLayerSizes(repo, tag, { os: 'linux' });
          if (r && r.exists && r.layersById && r.totalBytes > 0) {
            prefetched = { layersById: r.layersById, totalBytes: r.totalBytes };
          }
        } catch {
          // best-effort only
        }
      }
      if (pullState.status === 'aborted_client' || signal?.aborted) {
        abortPullStream();
        return { opId, status: 'aborted_client' };
      }

      if (prefetched) {
        pullState._dlDenomFrozen = prefetched.totalBytes;
        pullState._xDenomFrozen = prefetched.totalBytes;
        for (const [id, size] of prefetched.layersById.entries()) {
          if (!id || !Number.isFinite(Number(size)) || Number(size) <= 0) continue;
          pullState._layers.set(id, {
            id,
            dlCurrent: 0,
            dlTotal: Number(size),
            dlComplete: false,
            xCurrent: 0,
            xTotal: Number(size),
            xComplete: false,
            alreadyExists: false
          });
        }
      }

      await new Promise((resolve, reject) => {
        this.docker.modem.followProgress(
          stream,
          (err) => {
            if (pullState.status === 'aborted_client') return resolve();
            if (err) return reject(err);
            return resolve();
          },
          (evt) => {
            // Tolerate events without totals/ids.
            const status = typeof evt?.status === 'string' ? evt.status : null;
            const rawId = typeof evt?.id === 'string' ? evt.id : null;
            // Docker pull streams can emit non-layer ids (for example the tag name).
            // Only treat hex-like ids as layer ids for aggregation.
            const id = rawId && /^[a-f0-9]{12,}$/i.test(rawId) ? rawId.slice(0, 12) : null;
            const current = Number.isFinite(Number(evt?.progressDetail?.current))
              ? Number(evt.progressDetail.current)
              : null;
            const total = Number.isFinite(Number(evt?.progressDetail?.total))
              ? Number(evt.progressDetail.total)
              : null;

            let layerPercent = null;
            if (current !== null && total !== null && total > 0) {
              layerPercent = Math.max(0, Math.min(100, Math.floor((current / total) * 100)));
            }

            const clamp01 = (x) => {
              if (!Number.isFinite(x)) return 0;
              return Math.max(0, Math.min(1, x));
            };

            const statusNorm = (status || '').toLowerCase();
            const isDownloading = statusNorm === 'downloading' || statusNorm.includes('downloading');
            const isExtracting = statusNorm === 'extracting' || statusNorm.includes('extracting');
            const isDownloadComplete = statusNorm.includes('download complete');
            const isPullComplete = statusNorm.includes('pull complete');
            const isAlreadyExists = statusNorm.includes('already exists');
            const isPullingLayer = statusNorm.includes('pulling fs layer');

            // Track per-layer tuples (download + extract) and recompute both ratios each event.
            if (id && !pullState._layers.has(id)) {
              const prefSize = prefetched?.layersById?.get?.(id);
              const seedTotal = Number.isFinite(Number(prefSize)) && Number(prefSize) > 0 ? Number(prefSize) : 0;
              pullState._layers.set(id, {
                id,
                dlCurrent: 0,
                dlTotal: seedTotal,
                dlComplete: false,
                xCurrent: 0,
                xTotal: seedTotal,
                xComplete: false,
                alreadyExists: false
              });
              pullState._lastNewLayerAtMs = Date.now();
            }

            const layer = id ? pullState._layers.get(id) : null;
            if (layer) {
              if (isAlreadyExists) {
                layer.alreadyExists = true;
                layer.dlComplete = true;
                layer.xComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
                if (layer.xTotal > 0) layer.xCurrent = layer.xTotal;
              }

              if (isDownloading) {
                if (total !== null && total > 0) layer.dlTotal = Math.max(layer.dlTotal, total);
                if (current !== null) layer.dlCurrent = Math.max(layer.dlCurrent, current);
                if (layer.dlTotal > 0) layer.dlCurrent = Math.max(0, Math.min(layer.dlCurrent, layer.dlTotal));
                // Seed extract total from download total so Extract can show a stable denominator even before events.
                if (!layer.xTotal && layer.dlTotal > 0) layer.xTotal = layer.dlTotal;
              }

              if (isDownloadComplete) {
                layer.dlComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
              }

              if (isExtracting) {
                if (total !== null && total > 0) layer.xTotal = Math.max(layer.xTotal, total);
                if (current !== null) layer.xCurrent = Math.max(layer.xCurrent, current);
                if (layer.xTotal > 0) layer.xCurrent = Math.max(0, Math.min(layer.xCurrent, layer.xTotal));
              }

              if (isPullComplete) {
                layer.dlComplete = true;
                layer.xComplete = true;
                if (layer.dlTotal > 0) layer.dlCurrent = layer.dlTotal;
                if (layer.xTotal > 0) layer.xCurrent = layer.xTotal;
              }
            }
            const layerCount = pullState._layers.size;
            const nowMs = Date.now();

            const computeTotals = (kind) => {
              let doneBytes = 0;
              let totalBytes = 0;
              let doneLayers = 0;
              for (const st of pullState._layers.values()) {
                const isDone = kind === 'dl' ? (st.dlComplete || st.alreadyExists) : (st.xComplete || st.alreadyExists);
                const totRaw = kind === 'dl' ? st.dlTotal : st.xTotal;
                const curRaw = kind === 'dl' ? st.dlCurrent : st.xCurrent;

                let tot = Number.isFinite(Number(totRaw)) ? Number(totRaw) : 0;
                let cur = Number.isFinite(Number(curRaw)) ? Number(curRaw) : 0;

                if (tot <= 0) {
                  if (isDone) {
                    // Unknown size but finished (cached); treat as 1 unit so we still advance.
                    tot = 1;
                    cur = 1;
                  } else {
                    continue;
                  }
                }

                totalBytes += tot;
                doneBytes += isDone ? tot : Math.min(cur, tot);
                if (isDone || cur >= tot) doneLayers += 1;
              }

              const frozen = kind === 'dl' ? Number(pullState._dlDenomFrozen) || 0 : Number(pullState._xDenomFrozen) || 0;
              const denom = frozen > 0 ? frozen : totalBytes;
              const percent = denom > 0 ? Math.max(0, Math.min(100, Math.round((doneBytes / denom) * 100))) : null;
              return { doneBytes, totalBytes, doneLayers, denom, percent };
            };

            // Freeze denominators after 1.5s with no new layers (prevents jitter when totals appear late).
            const timeSinceNewLayer = Math.max(0, nowMs - (Number(pullState._lastNewLayerAtMs) || nowMs));
            const FREEZE_DELAY_MS = 1500;
            if (!prefetched && timeSinceNewLayer >= FREEZE_DELAY_MS) {
              if (!pullState._dlDenomFrozen) {
                const dlNow = computeTotals('dl');
                if (dlNow.totalBytes > 0) pullState._dlDenomFrozen = dlNow.totalBytes;
              }
              if (!pullState._xDenomFrozen) {
                const xNow = computeTotals('x');
                if (xNow.totalBytes > 0) pullState._xDenomFrozen = xNow.totalBytes;
              }
            }

            const dlAgg = computeTotals('dl');
            const xAgg = computeTotals('x');

            let downloadProgress = dlAgg.percent;
            let extractProgress = xAgg.percent;

            if (typeof downloadProgress === 'number') {
              downloadProgress = Math.max(Number(pullState._lastDlPercent) || 0, downloadProgress);
              pullState._lastDlPercent = downloadProgress;
            }
            if (typeof extractProgress === 'number') {
              extractProgress = Math.max(Number(pullState._lastXPercent) || 0, extractProgress);
              pullState._lastXPercent = extractProgress;
            }

            pullState.message = status;
            pullState.progress = downloadProgress;

            if (onProgress) {
              try {
                onProgress({
                  opId,
                  imageRef: ref,
                  status,
                  id,
                  current,
                  total,
                  layerProgress: layerPercent,
                  downloadProgress,
                  extractProgress,
                  downloadLayersTotal: layerCount,
                  downloadLayersDone: dlAgg.doneLayers,
                  extractLayersTotal: layerCount,
                  extractLayersDone: xAgg.doneLayers,
                  rawStatus: status,
                  pullingLayer: !!(isPullingLayer && id)
                });
              } catch {
                // do not let UI callback break the pull
              }
            }
          }
        );
      });

      if (pullState.status === 'aborted_client') {
        return { opId, status: 'aborted_client' };
      }

      pullState.status = 'completed';
      pullState.canCancel = false;
      pullState.progress = 100;
      return { opId, status: 'completed' };
    } catch (error) {
      if (pullState.status === 'aborted_client') {
        return { opId, status: 'aborted_client' };
      }
      pullState.status = 'failed';
      pullState.canCancel = false;
      throw normalizeDockerError(error, {
        op: 'pullImage',
        imageRef: ref,
        repo: imageRepoFromRef(ref),
        tag: tagFromRef(ref),
        registryAuth: authconfig ? 'present' : 'absent',
        env: this.#envSummary()
      });
    } finally {
      if (signal && pullState._abortListener) {
        try {
          signal.removeEventListener('abort', pullState._abortListener);
        } catch {
          // ignore
        }
      }
      // Keep completed/failed pulls out of the "in-flight" set.
      if (pullState.status !== 'running') {
        this._pulls.delete(opId);
      }
    }
  }

  async getPulls() {
    return Array.from(this._pulls.values()).map((p) => ({
      opId: p.opId,
      imageRef: p.imageRef,
      status: p.status,
      progress: p.progress,
      message: p.message,
      canCancel: !!p.canCancel,
      startedAt: p.startedAt
    }));
  }

  async cancelPull(opId) {
    const id = (opId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'opId is required');

    const p = this._pulls.get(id);
    if (!p) return { canceled: false };
    if (p.status !== 'running') return { canceled: false };

    const s = p._stream;
    if (s && typeof s.destroy === 'function') {
      // Best-effort client-side abort; daemon may continue briefly while the
      // Docker API request is torn down.
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }

    p.status = 'aborted_client';
    p.canCancel = false;
    p.message = 'aborted_client';
    if (s) this._pulls.delete(id);
    return { canceled: true };
  }

  async listContainers(imageRepo) {
    const repo = (imageRepo || this.imageRepo).trim();
    if (!repo) throw makeDockerInterfaceError('INVALID_INPUT', 'imageRepo is required');

    try {
      const containers = await Promise.resolve(this.docker.listContainers({ all: true }));
      const results = [];

      for (const c of containers || []) {
        const image = typeof c?.Image === 'string' ? c.Image : '';
        const names = Array.isArray(c?.Names) ? c.Names : [];
        const name = typeof names[0] === 'string' ? names[0].replace(/^\//, '') : null;
        const labels = c?.Labels && typeof c.Labels === 'object' ? c.Labels : {};
        const ports = Array.isArray(c?.Ports) ? c.Ports : [];
        const isRepoImage = image.startsWith(`${repo}:`);
        const isManagedContainer = labels['a0.launcher.managed'] === 'true';
        if (!isRepoImage && !isManagedContainer) continue;

        const uiPort = bestUiPortFromList(ports);
        const tag = isRepoImage
          ? image.slice(repo.length + 1)
          : labels['a0.launcher.versionTag'] || tagFromRef(image) || image;
        results.push({
          containerId: c?.Id || null,
          containerName: name,
          instanceName: typeof labels['a0.launcher.instanceName'] === 'string' ? labels['a0.launcher.instanceName'] : null,
          imageRef: image,
          tag,
          versionTag: tag,
          state: c?.State || null,
          status: c?.Status || null,
          createdAt: Number.isFinite(Number(c?.Created)) ? Number(c.Created) * 1000 : null,
          labels,
          ports: ports.map((p) => ({
            privatePort: Number.isFinite(Number(p?.PrivatePort)) ? Number(p.PrivatePort) : null,
            publicPort: Number.isFinite(Number(p?.PublicPort)) ? Number(p.PublicPort) : null,
            type: typeof p?.Type === 'string' ? p.Type : null,
            ip: typeof p?.IP === 'string' ? p.IP : null
          })),
          uiUrl: uiPort ? `http://127.0.0.1:${uiPort.publicPort}/` : null
        });
      }

      return results;
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listContainers', repo, env: this.#envSummary() });
    }
  }

  async listVolumes() {
    try {
      const res = await Promise.resolve(this.docker.listVolumes());
      const volumes = Array.isArray(res?.Volumes) ? res.Volumes : [];
      return volumes.map((v) => ({
        name: typeof v?.Name === 'string' ? v.Name : '',
        driver: typeof v?.Driver === 'string' ? v.Driver : '',
        mountpoint: typeof v?.Mountpoint === 'string' ? v.Mountpoint : '',
        scope: typeof v?.Scope === 'string' ? v.Scope : '',
        createdAt: typeof v?.CreatedAt === 'string' ? v.CreatedAt : null,
        labels: v?.Labels && typeof v.Labels === 'object' ? v.Labels : {}
      }));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listVolumes', env: this.#envSummary() });
    }
  }

  async removeVolume(volumeName) {
    const name = (volumeName || '').trim();
    if (!name) throw makeDockerInterfaceError('INVALID_INPUT', 'volumeName is required');
    try {
      const volume = this.docker.getVolume(name);
      await Promise.resolve(volume.remove());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'removeVolume', volumeName: name, env: this.#envSummary() });
    }
  }

  async pruneVolumes() {
    try {
      return await Promise.resolve(this.docker.pruneVolumes());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'pruneVolumes', env: this.#envSummary() });
    }
  }

  async createContainer(createOptions) {
    if (!createOptions || typeof createOptions !== 'object') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'createOptions must be an object');
    }

    try {
      const c = await Promise.resolve(this.docker.createContainer(createOptions));
      const containerId = typeof c?.id === 'string' ? c.id : typeof c?.Id === 'string' ? c.Id : null;
      if (!containerId) {
        throw makeDockerInterfaceError('DOCKER_ERROR', 'Docker did not return a container id', {
          op: 'createContainer',
          env: this.#envSummary()
        });
      }
      return { containerId };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'createContainer', env: this.#envSummary() });
    }
  }

  async renameContainer(containerId, newName) {
    const id = (containerId || '').trim();
    const name = (newName || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    if (!name) throw makeDockerInterfaceError('INVALID_INPUT', 'newName is required');

    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.rename({ name }));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'renameContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async inspectContainer(containerId) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      const c = this.docker.getContainer(id);
      return await Promise.resolve(c.inspect());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'inspectContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async readContainerTextFile(containerId, filePath, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(filePath);
    const maxBytes = clampReadBytes(options?.maxBytes);

    try {
      const c = this.docker.getContainer(id);
      const stream = await new Promise((resolve, reject) => {
        c.getArchive({ path: targetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      const archive = await streamToBuffer(stream, maxBytes + 8192);
      const fileBytes = extractFirstRegularFileFromTar(archive, maxBytes);
      return fileBytes ? fileBytes.toString('utf8') : null;
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return null;
      throw normalizeDockerError(error, { op: 'readContainerTextFile', containerId: id, filePath: targetPath, env: this.#envSummary() });
    }
  }

  async writeContainerTextFile(containerId, filePath, text) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(filePath);
    const parentPath = path.posix.dirname(targetPath);
    const fileName = path.posix.basename(targetPath);
    if (!fileName || fileName === '.' || fileName === '..') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'filePath must include a file name');
    }

    try {
      const c = this.docker.getContainer(id);
      const archive = tarArchiveForEntry(fileName, Buffer.from(String(text || ''), 'utf8'), '0');
      await new Promise((resolve, reject) => {
        c.putArchive(Readable.from(archive), { path: parentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { written: true };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'writeContainerTextFile',
        containerId: id,
        filePath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async ensureContainerDirectory(containerId, directoryPath) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(directoryPath).replace(/\/+$/u, '') || '/';
    if (targetPath === '/') return { created: false };
    const parentPath = path.posix.dirname(targetPath);
    const dirName = path.posix.basename(targetPath);
    if (!dirName || dirName === '.' || dirName === '..') {
      throw makeDockerInterfaceError('INVALID_INPUT', 'directoryPath must include a directory name');
    }

    try {
      const c = this.docker.getContainer(id);
      const archive = tarArchiveForEntry(`${dirName}/`, Buffer.alloc(0), '5');
      await new Promise((resolve, reject) => {
        c.putArchive(Readable.from(archive), { path: parentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { created: true };
    } catch (error) {
      throw normalizeDockerError(error, {
        op: 'ensureContainerDirectory',
        containerId: id,
        directoryPath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async listContainerDirectory(containerId, directoryPath, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const targetPath = validateContainerFilePath(directoryPath);
    const maxBytes = clampArchiveListBytes(options?.maxBytes);

    try {
      const c = this.docker.getContainer(id);
      const stream = await new Promise((resolve, reject) => {
        c.getArchive({ path: targetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      const archive = await streamToBuffer(stream, maxBytes);
      return immediateChildrenFromTar(archive, targetPath);
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return [];
      throw normalizeDockerError(error, {
        op: 'listContainerDirectory',
        containerId: id,
        directoryPath: targetPath,
        env: this.#envSummary()
      });
    }
  }

  async copyContainerPathToContainer(sourceContainerId, sourcePath, targetContainerId, targetPath) {
    const sourceId = (sourceContainerId || '').trim();
    const targetId = (targetContainerId || '').trim();
    if (!sourceId) throw makeDockerInterfaceError('INVALID_INPUT', 'sourceContainerId is required');
    if (!targetId) throw makeDockerInterfaceError('INVALID_INPUT', 'targetContainerId is required');

    const sourceTargetPath = validateContainerFilePath(sourcePath);
    const targetParentPath = validateContainerFilePath(targetPath);

    try {
      const source = this.docker.getContainer(sourceId);
      const target = this.docker.getContainer(targetId);
      const stream = await new Promise((resolve, reject) => {
        source.getArchive({ path: sourceTargetPath }, (err, archiveStream) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(archiveStream);
        });
      });
      await new Promise((resolve, reject) => {
        target.putArchive(stream, { path: targetParentPath }, (err, data) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(data);
        });
      });
      return { copied: true };
    } catch (error) {
      if (Number(error?.statusCode) === 404 || error?.code === 'NOT_FOUND') return { copied: false };
      throw normalizeDockerError(error, {
        op: 'copyContainerPathToContainer',
        sourceContainerId: sourceId,
        targetContainerId: targetId,
        sourcePath: sourceTargetPath,
        targetPath: targetParentPath,
        env: this.#envSummary()
      });
    }
  }

  async commitContainer(containerId, imageRef, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    const ref = (imageRef || '').trim();
    const { repo, tag } = splitTaggedImageRef(ref);

    try {
      const c = this.docker.getContainer(id);
      const result = await new Promise((resolve, reject) => {
        c.commit(
          {
            repo,
            tag,
            pause: options?.pause !== false,
            comment: typeof options?.comment === 'string' ? options.comment : '',
            author: typeof options?.author === 'string' ? options.author : ''
          },
          (err, image) => (err ? reject(err) : resolve(image))
        );
      });
      return {
        imageRef: ref,
        imageId: typeof result?.Id === 'string' ? result.Id : null
      };
    } catch (error) {
      throw normalizeDockerError(error, { op: 'commitContainer', containerId: id, imageRef: ref, env: this.#envSummary() });
    }
  }

  async readContainerLogs(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      return await dockerodeReadContainerLogs(this.docker, id, options);
    } catch (error) {
      throw normalizeDockerError(error, { op: 'readContainerLogs', containerId: id, env: this.#envSummary() });
    }
  }

  async followContainerLogs(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');

    try {
      return await dockerodeFollowContainerLogs(this.docker, id, options);
    } catch (error) {
      throw normalizeDockerError(error, { op: 'followContainerLogs', containerId: id, env: this.#envSummary() });
    }
  }

  async startContainer(containerId) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.start());
    } catch (error) {
      throw normalizeDockerError(error, { op: 'startContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async stopContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.stop(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'stopContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async restartContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.restart(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'restartContainer', containerId: id, env: this.#envSummary() });
    }
  }

  async deleteContainer(containerId, options = {}) {
    const id = (containerId || '').trim();
    if (!id) throw makeDockerInterfaceError('INVALID_INPUT', 'containerId is required');
    try {
      const c = this.docker.getContainer(id);
      await Promise.resolve(c.remove(options));
    } catch (error) {
      throw normalizeDockerError(error, { op: 'deleteContainer', containerId: id, env: this.#envSummary() });
    }
  }

  #envSummary() {
    return {
      platform: this.env?.platform || process.platform,
      arch: this.env?.arch || process.arch,
      dockerHostKind: this.env?.dockerHost?.kind || 'unknown',
      dockerAvailable: !!this.env?.dockerAvailable,
      dockerFlavor: this.env?.dockerFlavor || 'unknown',
      daemonVersion: this.env?.daemonVersion || null
    };
  }
}
