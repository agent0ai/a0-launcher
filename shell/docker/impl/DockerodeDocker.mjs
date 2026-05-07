import Dockerode from 'dockerode';
import { DockerInterface } from '../DockerInterface.mjs';
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

  const details = {
    ...context,
    code,
    errno: error?.errno,
    syscall: error?.syscall,
    address: error?.address,
    port: error?.port,
    statusCode
  };

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

    try {
      const stream = await new Promise((resolve, reject) => {
        this.docker.pull(ref, (err, s) => (err ? reject(err) : resolve(s)));
      });

      pullState._stream = stream;

      if (signal) {
        if (signal.aborted) {
          await this.cancelPull(opId);
          return { opId, status: 'aborted_client' };
        }

        const listener = () => {
          this.cancelPull(opId).catch(() => {});
        };
        pullState._abortListener = listener;
        try {
          signal.addEventListener('abort', listener, { once: true });
        } catch {
          // ignore
        }
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
    if (!s || typeof s.destroy !== 'function') return { canceled: false };

    // Best-effort client-side abort; daemon may continue (DI-009).
    try {
      s.destroy();
    } catch {
      // ignore
    }

    p.status = 'aborted_client';
    p.canCancel = false;
    p.message = 'aborted_client';
    this._pulls.delete(id);
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
        if (!image.startsWith(`${repo}:`)) continue;

        const names = Array.isArray(c?.Names) ? c.Names : [];
        const name = typeof names[0] === 'string' ? names[0].replace(/^\//, '') : null;
        results.push({
          containerId: c?.Id || null,
          containerName: name,
          imageRef: image,
          tag: image.slice(repo.length + 1),
          state: c?.State || null,
          status: c?.Status || null
        });
      }

      return results;
    } catch (error) {
      throw normalizeDockerError(error, { op: 'listContainers', repo, env: this.#envSummary() });
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
