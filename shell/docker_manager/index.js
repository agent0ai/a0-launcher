const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app } = require('electron');

const { getDocker, resetDocker } = require('../docker_adapter/getDocker');
const releasesClient = require('./releases_client');
const stateStore = require('./state_store');
const retention = require('./retention');
const { toErrorResponse, mapDockerInterfaceErrorToUiMessage } = require('./errors');
const { isSemverReleaseTag } = require('./release_tags');

const DEFAULT_IMAGE_REPO = 'agent0ai/agent-zero';
const DEFAULT_GITHUB_REPO = 'agent0ai/agent-zero';

const IMAGE_REPO_ENV_VAR = 'A0_BACKEND_IMAGE_REPO';
const GITHUB_REPO_ENV_VAR = 'A0_BACKEND_GITHUB_REPO';
const UI_READY_TIMEOUT_MS = 5 * 60_000;
const RUNTIME_SETUP_RESUME_ARG = '--a0-resume-runtime-setup';
const RUNTIME_SETUP_RUNONCE_VALUE = 'AgentZeroLauncherResumeRuntimeSetup';
const execFileAsync = promisify(execFile);

const CANONICAL_LOCAL_TAGS = Object.freeze(['local', 'development', 'main']);

function logDockerManagerError(op, error, details = {}) {
  const payload = { ...details };
  if (error && typeof error === 'object') {
    if (error.code) payload.code = String(error.code);
    if (typeof error.message === 'string') payload.message = error.message;
    if (error.details && typeof error.details === 'object') payload.details = error.details;
    if (error.cause && typeof error.cause === 'object') payload.cause = error.cause;
  }
  try {
    console.error(`[docker-manager] ${op} failed`, payload);
  } catch {
    try {
      console.error(`[docker-manager] ${op} failed`);
    } catch {
      // ignore
    }
  }
}

function quoteWindowsCommandArg(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function runtimeResumeLaunchCommand() {
  const parts = [quoteWindowsCommandArg(process.execPath)];
  if (process.defaultApp && process.argv[1]) {
    parts.push(quoteWindowsCommandArg(process.argv[1]));
  }
  parts.push(RUNTIME_SETUP_RESUME_ARG);
  return parts.join(' ');
}

async function registerRuntimeSetupRunOnce() {
  if (process.platform !== 'win32') return;
  await execFileAsync('reg.exe', [
    'add',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
    '/v',
    RUNTIME_SETUP_RUNONCE_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    runtimeResumeLaunchCommand(),
    '/f'
  ]).catch((error) => {
    logDockerManagerError('runtimeSetup.registerRunOnce', error);
  });
}

async function clearRuntimeSetupRunOnce() {
  if (process.platform !== 'win32') return;
  await execFileAsync('reg.exe', [
    'delete',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
    '/v',
    RUNTIME_SETUP_RUNONCE_VALUE,
    '/f'
  ]).catch(() => {});
}

async function markRuntimeSetupResume(assessment = null) {
  await stateStore.writeRuntimeSetupResume({
    reason: typeof assessment?.mode === 'string' ? assessment.mode : ''
  });
  if (assessment?.requiresRestart === true) {
    await registerRuntimeSetupRunOnce();
  }
}

async function clearRuntimeSetupResume() {
  await stateStore.clearRuntimeSetupResume().catch(() => false);
  await clearRuntimeSetupRunOnce();
}

function normalizeRepo(value) {
  const v = (value || '').trim();
  if (!v) return '';
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return v;
  return '';
}

function getBackendImageRepo() {
  const fromEnv = normalizeRepo(process.env[IMAGE_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;
  return DEFAULT_IMAGE_REPO;
}

function getBackendGithubRepo() {
  const fromEnv = normalizeRepo(process.env[GITHUB_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;
  return DEFAULT_GITHUB_REPO;
}

function isSafeTag(tag) {
  const t = (tag || '').trim();
  if (!t) return false;
  if (t.length > 128) return false;
  // Avoid separators that could form repo refs or paths.
  if (t.includes(':') || t.includes('/') || /\s/.test(t)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(t);
}

function isTestingTag(tag) {
  return (tag || '').trim() === 'testing';
}

function isCanonicalLocalTag(tag) {
  const t = (tag || '').trim();
  return CANONICAL_LOCAL_TAGS.includes(t);
}

function assertTagAllowedForInstall(tag) {
  const t = (tag || '').trim();
  if (!isSafeTag(t)) {
    const err = new Error('Invalid tag');
    err.code = 'INVALID_TAG';
    throw err;
  }
  if (!isTestingTag(t) && !isSemverReleaseTag(t) && !isCanonicalLocalTag(t)) {
    const err = new Error('Tag not allowed for install');
    err.code = 'TAG_NOT_ALLOWED';
    throw err;
  }
  return t;
}

function assertTagAllowedForActivate(tag) {
  const t = (tag || '').trim();
  if (!isSafeTag(t)) {
    const err = new Error('Invalid tag');
    err.code = 'INVALID_TAG';
    throw err;
  }
  // Activate may target installed local builds; keep validation lightweight here.
  return t;
}

function imageRefForTag(imageRepo, tag) {
  return `${imageRepo}:${tag}`;
}

function nowIso() {
  return new Date().toISOString();
}

function isoToMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : NaN;
}

function extractLocalDigest(repoDigests) {
  for (const d of Array.isArray(repoDigests) ? repoDigests : []) {
    if (typeof d !== 'string') continue;
    const idx = d.indexOf('@');
    if (idx === -1) continue;
    const digest = d.slice(idx + 1).trim();
    if (digest.startsWith('sha256:') && digest.length > 15) return digest;
  }
  return null;
}

function shortDigest(digest) {
  const d = (digest || '').trim();
  if (!d) return '';
  if (d.startsWith('sha256:') && d.length > 15) return d.slice('sha256:'.length, 'sha256:'.length + 12);
  return d.length > 12 ? d.slice(0, 12) : d;
}

function buildDigestHint(publishedDigest, localDigest) {
  const pub = shortDigest(publishedDigest);
  const loc = shortDigest(localDigest);
  if (!pub || !loc) return null;
  return `Published: ${pub} / Local: ${loc}`;
}

function emptyDerivedState(runtime = null) {
  return {
    versions: [],
    retainedInstances: [],
    remoteInstances: [],
    retentionPolicy: { keepCount: 1 },
    portPreferences: { ui: 8880, ssh: 55022 },
    uiUrl: null,
    lastSyncedAt: null,
    offline: false,
    storage: {
      dockerRootDir: null,
      freeBytes: null,
      usedBytes: null,
      estimateAfterUpdateBytes: null
    },
    runtime
  };
}

function normalizeRuntimeAssessment(assessment, env = null) {
  let state = typeof assessment?.state === 'string' ? assessment.state : 'unsupported';
  const detail = typeof assessment?.detail === 'string' ? assessment.detail : 'Automatic runtime setup is not available.';
  if (state === 'unsupported' && /user needs Docker access|not in the docker group/i.test(detail)) {
    state = 'needs_group_membership';
  }
  const actionByState = {
    not_provisioned: 'install',
    needs_group_membership: 'install',
    engine_stopped: 'start',
    manual_install: 'manual',
    unsupported: 'manual',
    needs_relogin: 'refresh',
    ready: ''
  };

  const runtime = {
    platform: process.platform,
    state,
    detail,
    dockerFlavor: typeof env?.dockerFlavor === 'string' ? env.dockerFlavor : null,
    dockerHost: typeof env?.dockerHost?.raw === 'string' ? env.dockerHost.raw : null,
    canProvision: assessment?.canProvision === true || state === 'not_provisioned' || state === 'needs_group_membership' || state === 'engine_stopped',
    action: actionByState[state] || ''
  };

  if (typeof assessment?.mode === 'string') runtime.mode = assessment.mode;
  if (typeof assessment?.distro === 'string') runtime.distro = assessment.distro;
  if (typeof assessment?.requiresAdmin === 'boolean') runtime.requiresAdmin = assessment.requiresAdmin;
  if (typeof assessment?.requiresRestart === 'boolean') runtime.requiresRestart = assessment.requiresRestart;
  if (typeof assessment?.setupActionLabel === 'string') runtime.setupActionLabel = assessment.setupActionLabel;
  if (typeof assessment?.packageManager === 'string') runtime.packageManager = assessment.packageManager;
  if (Array.isArray(assessment?.manualPackages)) {
    runtime.manualPackages = assessment.manualPackages.filter((item) => typeof item === 'string');
  }
  if (typeof assessment?.manualCommand === 'string') runtime.manualCommand = assessment.manualCommand;
  if (typeof assessment?.manualUrl === 'string') runtime.manualUrl = assessment.manualUrl;

  return runtime;
}

async function getRuntimeProvisioner() {
  const { RuntimeProvisioner } = await import('../docker_adapter/RuntimeProvisioner.mjs');
  return await RuntimeProvisioner.forPlatform({
    managedDir: path.join(app.getPath('userData'), 'runtime')
  });
}

async function assessRuntime(env = null) {
  if (env?.dockerAvailable) {
    return normalizeRuntimeAssessment({ state: 'ready', detail: 'Runtime is ready.' }, env);
  }

  const provisioner = await getRuntimeProvisioner();
  if (!provisioner) {
    return normalizeRuntimeAssessment({
      state: 'unsupported',
      detail: 'Automatic runtime setup is not available on this system. Install Docker Desktop or Docker Engine, then refresh.'
    }, env);
  }

  try {
    const assessment = await provisioner.assess();
    return normalizeRuntimeAssessment(assessment, env);
  } catch (error) {
    return normalizeRuntimeAssessment({
      state: 'unsupported',
      detail: error?.message || 'Automatic runtime setup is not available on this system.'
    }, env);
  }
}

async function buildUnavailableState(runtime) {
  const [retentionPolicy, portPreferences, remoteInstances] = await Promise.all([
    stateStore.readRetentionPolicy().catch(() => ({ keepCount: 1 })),
    stateStore.readPortPreferences().catch(() => ({ ui: 8880, ssh: 55022 })),
    stateStore.readRemoteInstances().catch(() => [])
  ]);
  return {
    ...emptyDerivedState(runtime),
    retentionPolicy,
    portPreferences,
    remoteInstances
  };
}

function bestEffortUiUrlFromInspect(inspect) {
  const ports = inspect?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return null;

  /** @type {{containerPort: number, hostPort: number}[]} */
  const candidates = [];
  for (const [containerPortSpec, bindings] of Object.entries(ports)) {
    const containerPort = Number(String(containerPortSpec || '').split('/')[0]);
    if (!Number.isFinite(containerPort) || containerPort <= 0 || containerPort > 65535) continue;
    for (const b of Array.isArray(bindings) ? bindings : []) {
      const hostPort = Number(b?.HostPort);
      if (!Number.isFinite(hostPort) || hostPort <= 0 || hostPort > 65535) continue;
      candidates.push({ containerPort, hostPort });
    }
  }

  if (!candidates.length) return null;

  // Prefer typical HTTP ports first. Agent Zero currently exposes 80/tcp.
  const preferredContainerPorts = [80, 7860, 3000, 8080, 5000, 9000, 9001, 9002];
  for (const p of preferredContainerPorts) {
    const match = candidates.find((c) => c.containerPort === p);
    if (match) return `http://127.0.0.1:${match.hostPort}/`;
  }

  // Avoid SSH (22) as a UI target.
  candidates.sort((a, b) => a.hostPort - b.hostPort);
  const fallback = candidates.find((c) => c.containerPort !== 22) || candidates[0];
  return `http://127.0.0.1:${fallback.hostPort}/`;
}

function parseHostPortFromLocalUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = String(u.hostname || '').trim();
    if (!host) return null;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
    const port = Number(u.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host: host === 'localhost' ? '127.0.0.1' : host, port };
  } catch {
    return null;
  }
}

function isHttpPortReachable(host, port, timeoutMs) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) return Promise.resolve(false);

  const hRaw = String(host || '').trim();
  const h = hRaw === 'localhost' || hRaw === '::1' ? '127.0.0.1' : hRaw;
  if (!h) return Promise.resolve(false);

  return new Promise((resolve) => {
    const req = http.request(
      {
        method: 'GET',
        hostname: h,
        port: p,
        path: '/',
        headers: {
          'User-Agent': 'A0-Launcher',
          'Accept': '*/*'
        }
      },
      (res) => {
        try {
          res.resume();
        } catch {
          // ignore
        }
        const status = Number(res.statusCode);
        resolve(Number.isFinite(status) && status > 0 && status < 500);
      }
    );
    req.once('error', () => resolve(false));
    req.setTimeout(Math.max(80, Math.floor(timeoutMs || 350)), () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      resolve(false);
    });
    req.end();
  });
}

async function waitForHttpPort(host, port, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 60_000;
  const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 450;
  const attemptTimeoutMs =
    Number.isFinite(Number(options.attemptTimeoutMs)) ? Number(options.attemptTimeoutMs) : 350;
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;

  const startedAt = Date.now();
  let lastTickSeconds = -1;

  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isHttpPortReachable(host, port, attemptTimeoutMs);
    if (ok) return true;

    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (onTick && seconds !== lastTickSeconds) {
      lastTickSeconds = seconds;
      try {
        onTick(seconds);
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  if (onTick) {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    try {
      onTick(seconds);
    } catch {
      // ignore
    }
  }

  return false;
}

async function waitForUiReachable(docker, containerId, options = {}) {
  try {
    const inspect = await docker.inspectContainer(containerId);
    const uiUrl = bestEffortUiUrlFromInspect(inspect);
    const hp = parseHostPortFromLocalUrl(uiUrl);
    if (!hp) return { uiUrl: null, ok: false };
    const ok = await waitForHttpPort(hp.host, hp.port, options);
    return { uiUrl, ok };
  } catch {
    return { uiUrl: null, ok: false };
  }
}

function computeImageBytesStats(localImages) {
  const byId = new Map();
  let maxImageBytes = 0;

  for (const img of localImages || []) {
    const id = typeof img?.imageId === 'string' ? img.imageId : '';
    const size = Number(img?.sizeBytes);
    if (!id) continue;
    if (!Number.isFinite(size) || size <= 0) continue;
    const prev = byId.get(id) || 0;
    const next = size > prev ? size : prev;
    byId.set(id, next);
    if (next > maxImageBytes) maxImageBytes = next;
  }

  if (!byId.size) return { usedBytes: null, maxImageBytes: null };

  let usedBytes = 0;
  for (const v of byId.values()) usedBytes += v;
  return {
    usedBytes: Number.isFinite(usedBytes) ? Math.floor(usedBytes) : null,
    maxImageBytes: Number.isFinite(maxImageBytes) && maxImageBytes > 0 ? Math.floor(maxImageBytes) : null
  };
}

async function bestEffortFreeBytesForUserData() {
  try {
    if (typeof fs.statfs !== 'function') return null;
    const dir = app.getPath('userData');
    const s = await fs.statfs(dir);
    const bsize = Number(s?.bsize);
    const bavail = Number(s?.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail)) return null;
    const freeBytes = bsize * bavail;
    return Number.isFinite(freeBytes) ? Math.max(0, Math.floor(freeBytes)) : null;
  } catch {
    return null;
  }
}

function estimateAfterUpdateBytes(freeBytes, latestReleaseTag, localByTag, imageStats) {
  if (!Number.isFinite(Number(freeBytes))) return null;
  if (!latestReleaseTag) return null;
  if (localByTag && localByTag.has(latestReleaseTag)) return Math.max(0, Math.floor(Number(freeBytes)));

  const maxImageBytes = imageStats?.maxImageBytes;
  if (!Number.isFinite(Number(maxImageBytes))) return null;
  const estimate = Number(freeBytes) - Number(maxImageBytes);
  return Number.isFinite(estimate) ? Math.max(0, Math.floor(estimate)) : null;
}

const events = new EventEmitter();
events.setMaxListeners(50);

let _cachedState = null;
let _currentOperation = null;
const _abortControllers = new Map();
const _warmLayerSizes = { running: false, lastImageRepo: '', lastStartedAtMs: 0 };

function scheduleLayerSizesWarmup(docker, imageRepo, tags) {
  const repo = (imageRepo || '').trim();
  if (!repo) return;

  if (_warmLayerSizes.running) return;
  const nowMs = Date.now();
  if (_warmLayerSizes.lastImageRepo === repo && Number.isFinite(_warmLayerSizes.lastStartedAtMs) && nowMs - _warmLayerSizes.lastStartedAtMs < 10 * 60 * 1000) {
    return;
  }

  _warmLayerSizes.running = true;
  _warmLayerSizes.lastImageRepo = repo;
  _warmLayerSizes.lastStartedAtMs = nowMs;

  setTimeout(() => {
    (async () => {
      if (_currentOperation && _currentOperation.status === 'running') return;

      const seen = new Set();
      const ordered = [];
      for (const t of tags || []) {
        const s = (t || '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        ordered.push(s);
      }

      const limit = Math.min(25, ordered.length);
      for (let i = 0; i < limit; i += 1) {
        const tag = ordered[i];
        try {
          await docker.getRemoteLayerSizes(repo, tag, { os: 'linux' });
        } catch (error) {
          const code = error?.code || error?.details?.code || '';
          if (code === 'REGISTRY_RATE_LIMIT') break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    })().catch(() => {}).finally(() => {
      _warmLayerSizes.running = false;
    });
  }, 0);
}

function getCurrentOperation() {
  return _currentOperation;
}

function requireNoRunningOperation() {
  if (_currentOperation && _currentOperation.status === 'running') {
    const err = new Error('Another operation is already running');
    err.code = 'OP_IN_PROGRESS';
    throw err;
  }
}

function beginOperation(type, targetTag) {
  requireNoRunningOperation();
  const opId = `op_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  _currentOperation = {
    opId,
    type,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    targetTag: targetTag || null,
    progress: null,
    downloadProgress: null,
    extractProgress: null,
    message: null,
    error: null
  };
  events.emit('progress', { ..._currentOperation });
  return opId;
}

function updateOperationProgress(patch) {
  if (!_currentOperation) return;
  _currentOperation = { ..._currentOperation, ...(patch || {}) };
  events.emit('progress', { ..._currentOperation });
}

function finishOperation(status, errorMessage) {
  if (!_currentOperation) return;
  _currentOperation = {
    ..._currentOperation,
    status,
    finishedAt: nowIso(),
    error: errorMessage || null
  };
  events.emit('progress', { ..._currentOperation });
}

async function buildDerivedState(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const imageRepo = getBackendImageRepo();
  const githubRepo = getBackendGithubRepo();

  const docker = await getDocker({ imageRepo });

  const env = await docker.getEnvironment();
  const runtime = await assessRuntime(env);
  if (!env?.dockerAvailable) {
    return await buildUnavailableState(runtime);
  }

  const [retentionPolicy, portPreferences, remoteInstances, installabilityCache, releasesResult, localImages, containers, freeBytes, remoteTags] =
    await Promise.all([
      stateStore.readRetentionPolicy(),
      stateStore.readPortPreferences(),
      stateStore.readRemoteInstances(),
      stateStore.readInstallabilityCache(),
      releasesClient.listOfficialReleases({ githubRepo, forceRefresh }),
      docker.listLocalImages(imageRepo),
      docker.listContainers(imageRepo),
      bestEffortFreeBytesForUserData(),
      docker.listRemoteTags(imageRepo).catch(() => null)
    ]);

  const releases = Array.isArray(releasesResult?.releases) ? releasesResult.releases : [];
  const offline = !!releasesResult?.offline;
  const lastSyncedAt = releasesResult?.lastSyncedAt || null;

  // Trim dead official releases: allow gaps, but once we see 2 missing in a row,
  // assume we've reached the tail where older tags are no longer available on Docker Hub.
  const remoteTagList = Array.isArray(remoteTags) ? remoteTags : [];
  const remoteTagSet = remoteTagList.length ? new Set(remoteTagList) : null;
  let releasesForUi = releases;
  if (remoteTagSet) {
    const trimmed = [];
    let missingStreak = 0;
    for (const r of releases) {
      const t = (r?.tag || '').trim();
      if (!t) continue;
      if (remoteTagSet.has(t)) {
        trimmed.push(r);
        missingStreak = 0;
        continue;
      }
      missingStreak += 1;
      if (missingStreak >= 2) break;
    }
    releasesForUi = trimmed;
  }

  const activeName = retention.getActiveContainerName(imageRepo);
  const activeContainer = (containers || []).find((c) => c && c.containerName === activeName) || null;
  const activeTag = activeContainer?.tag || null;
  const activeState = typeof activeContainer?.state === 'string' ? activeContainer.state : null;

  let uiUrl = null;
  if (activeContainer && activeContainer.containerId && String(activeState || '').toLowerCase() === 'running') {
    try {
      const inspect = await docker.inspectContainer(activeContainer.containerId);
      const candidate = bestEffortUiUrlFromInspect(inspect);
      if (candidate) {
        const hp = parseHostPortFromLocalUrl(candidate);
        if (hp) {
          const ok = await isHttpPortReachable(hp.host, hp.port, 350);
          uiUrl = ok ? candidate : null;
        }
      }
    } catch {
      // best-effort only
    }
  }

  const retainedInstances = [];
  for (const c of containers || []) {
    const name = c?.containerName || '';
    const parsed = retention.parseRetainedContainerName(name);
    if (!parsed) continue;
    retainedInstances.push({
      containerId: c?.containerId || '',
      containerName: name,
      versionTag: parsed.tag,
      retainedAt: parsed.retainedAt
    });
  }
  retainedInstances.sort((a, b) => {
    const ams = isoToMs(a.retainedAt);
    const bms = isoToMs(b.retainedAt);
    if (Number.isFinite(bms) && Number.isFinite(ams)) return bms - ams;
    return String(b.retainedAt).localeCompare(String(a.retainedAt));
  });

  const localByTag = new Map();
  for (const img of localImages || []) {
    const tag = (img?.tag || '').trim();
    if (!tag) continue;
    if (!localByTag.has(tag)) localByTag.set(tag, img);
  }

  const latestReleaseTag = releasesForUi.length ? releasesForUi[0].tag : null;
  const imageStats = computeImageBytesStats(localImages);
  const tagsToProbe = new Set();
  tagsToProbe.add('testing');
  tagsToProbe.add('latest');
  if (latestReleaseTag) tagsToProbe.add(latestReleaseTag);
  if (activeTag && (isTestingTag(activeTag) || isSemverReleaseTag(activeTag))) tagsToProbe.add(activeTag);
  for (const inst of retainedInstances) {
    if (inst.versionTag && (isTestingTag(inst.versionTag) || isSemverReleaseTag(inst.versionTag))) {
      tagsToProbe.add(inst.versionTag);
    }
  }
  for (const tag of localByTag.keys()) {
    if (isSemverReleaseTag(tag)) tagsToProbe.add(tag);
  }
  for (const t of CANONICAL_LOCAL_TAGS) {
    if (localByTag.has(t)) tagsToProbe.add(t);
  }

  const nowMs = Date.now();
  const cache = installabilityCache && typeof installabilityCache === 'object' ? installabilityCache : { entries: {} };
  const entries = cache.entries && typeof cache.entries === 'object' ? cache.entries : {};
  let cacheChanged = false;

  const shouldProbeRemote = !offline || forceRefresh;
  if (shouldProbeRemote) {
    for (const tag of tagsToProbe) {
      const existing = entries[tag];
      const existingStatus = existing?.status || 'unknown';
      const checkedAtMs = isoToMs(existing?.checkedAt);
      const recheckAfterMs = isoToMs(existing?.recheckAfter);

      let fresh = false;
      if (!forceRefresh) {
        if (existingStatus === 'installable' && Number.isFinite(checkedAtMs) && nowMs - checkedAtMs < 24 * 60 * 60 * 1000) {
          fresh = true;
        }
        if (existingStatus === 'not_yet_available' && Number.isFinite(recheckAfterMs) && nowMs < recheckAfterMs) {
          fresh = true;
        }
      }

      if (fresh) continue;

      try {
        const digestInfo = await docker.getRemoteDigest(imageRepo, tag);
        const exists = !!digestInfo?.exists;
        if (exists) {
          entries[tag] = {
            status: 'installable',
            checkedAt: nowIso(),
            recheckAfter: null,
            digest: digestInfo?.digest || null,
            contentType: digestInfo?.contentType || null
          };
        } else {
          entries[tag] = {
            status: 'not_yet_available',
            checkedAt: nowIso(),
            recheckAfter: new Date(nowMs + 15 * 60 * 1000).toISOString(),
            digest: null,
            contentType: null
          };
        }
        cacheChanged = true;
      } catch {
        // Best-effort: leave cache entry unchanged on registry failures.
      }
    }
  }

  if (cacheChanged) {
    await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
  }

  const releaseEntries = [];

  // First-class preview/testing entry (not derived from GitHub Releases).
  {
    const tag = 'testing';
    const img = localByTag.get(tag) || null;
    const cacheEntry = entries[tag] || null;
    const isActive = activeTag === tag;
    const localDigest = extractLocalDigest(img?.repoDigests);
    const publishedDigest = cacheEntry && typeof cacheEntry.digest === 'string' && cacheEntry.digest ? cacheEntry.digest : null;
    const differsFromPublished = !!(localDigest && publishedDigest && localDigest !== publishedDigest);
    const matchHint = differsFromPublished ? 'Differs from published preview' : null;
    const digestHint = differsFromPublished ? buildDigestHint(publishedDigest, localDigest) : null;
    releaseEntries.push({
      id: tag,
      displayVersion: 'Testing',
      channelBadges: ['testing'],
      category: 'official_release',
      availability: img ? 'installed' : 'available',
      installability: cacheEntry?.status === 'installable' ? 'installable' : cacheEntry?.status === 'not_yet_available' ? 'not_yet_available' : 'unknown',
      matchHint,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: null,
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Official semver releases (sorted descending by releases_client).
  for (const r of releasesForUi) {
    const tag = (r?.tag || '').trim();
    if (!isSemverReleaseTag(tag)) continue;

    const img = localByTag.get(tag) || null;
    const cacheEntry = entries[tag] || null;
    const isActive = activeTag === tag;
    const localDigest = extractLocalDigest(img?.repoDigests);
    const publishedDigest = cacheEntry && typeof cacheEntry.digest === 'string' && cacheEntry.digest ? cacheEntry.digest : null;
    const differsFromPublished = !!(localDigest && publishedDigest && localDigest !== publishedDigest);
    const matchHint = differsFromPublished ? 'Differs from published version' : null;
    const digestHint = differsFromPublished ? buildDigestHint(publishedDigest, localDigest) : null;

    const availabilityBase = img ? 'installed' : 'available';
    let availability = availabilityBase;
    if (isActive && latestReleaseTag && tag !== latestReleaseTag) {
      availability = 'update_available';
    }

    const badges = [];
    if (latestReleaseTag && tag === latestReleaseTag) badges.push('latest');

    releaseEntries.push({
      id: tag,
      displayVersion: tag.startsWith('v') ? tag.slice(1) : tag,
      channelBadges: badges.length ? badges : undefined,
      category: 'official_release',
      availability,
      installability: cacheEntry?.status === 'installable' ? 'installable' : cacheEntry?.status === 'not_yet_available' ? 'not_yet_available' : 'unknown',
      matchHint,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: r?.publishedAt || null,
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Local builds (canonical + custom) derived from local images not represented above.
  const officialTagSet = new Set();
  officialTagSet.add('testing');
  for (const r of releasesForUi) {
    if (isSemverReleaseTag(r?.tag)) officialTagSet.add(r.tag);
  }

  const localBuildTags = [];
  for (const [tag] of localByTag.entries()) {
    if (officialTagSet.has(tag)) continue;
    localBuildTags.push(tag);
  }

  localBuildTags.sort((a, b) => {
    const ac = isCanonicalLocalTag(a) ? 0 : 1;
    const bc = isCanonicalLocalTag(b) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    if (ac === 0 && bc === 0) return CANONICAL_LOCAL_TAGS.indexOf(a) - CANONICAL_LOCAL_TAGS.indexOf(b);
    return a.localeCompare(b);
  });

  const knownRemoteDigests = [];
  for (const t of Object.keys(entries)) {
    const e = entries[t];
    if (e && e.status === 'installable' && typeof e.digest === 'string' && e.digest) {
      knownRemoteDigests.push({ tag: t, digest: e.digest });
    }
  }

  for (const tag of localBuildTags) {
    const img = localByTag.get(tag) || null;
    const isActive = activeTag === tag;

    const cacheEntry = entries[tag] || null;
    const localDigest = extractLocalDigest(img?.repoDigests);

    let installability = null;
    let matchHint = null;
    let differsFromPublished = null;
    let digestHint = null;

    if (isCanonicalLocalTag(tag)) {
      if (cacheEntry?.status === 'installable') {
        installability = 'installable';
        if (localDigest && typeof cacheEntry.digest === 'string' && cacheEntry.digest) {
          if (localDigest === cacheEntry.digest) {
            matchHint = 'Matches published version';
            differsFromPublished = false;
          } else {
            matchHint = 'Differs from published version';
            differsFromPublished = true;
            digestHint = buildDigestHint(cacheEntry.digest, localDigest);
          }
        }
      } else if (cacheEntry?.status === 'not_yet_available') {
        installability = 'not_yet_available';
      } else {
        installability = 'unknown';
      }
    }

    if (!matchHint && localDigest) {
      const match = knownRemoteDigests.find((d) => d.digest === localDigest);
      if (match && isSemverReleaseTag(match.tag)) {
        matchHint = `Matches published version ${match.tag.startsWith('v') ? match.tag.slice(1) : match.tag}`;
      } else if (match && match.tag === 'latest' && latestReleaseTag) {
        matchHint = `Matches latest release ${latestReleaseTag.startsWith('v') ? latestReleaseTag.slice(1) : latestReleaseTag}`;
      } else if (match && match.tag === 'testing') {
        matchHint = 'Matches published preview';
      }
    }

    releaseEntries.push({
      id: tag,
      displayVersion: tag,
      category: 'local_build',
      availability: 'installed',
      installability,
      matchHint,
      digestHint,
      differsFromPublished,
      isActive,
      activeState: isActive ? activeState : null,
      publishedAt: null,
      sizeBytes: img?.sizeBytes || null
    });
  }

  // Warm layer size manifests for visible tags in the background (best-effort).
  if (!offline && releasesForUi.length) {
    const warmTags = ['testing', latestReleaseTag, ...releasesForUi.map((r) => r?.tag || '')].filter(Boolean);
    scheduleLayerSizesWarmup(docker, imageRepo, warmTags);
  }

  // If an operation is running, reflect it on the target row as "installing".
  if (_currentOperation && _currentOperation.status === 'running' && _currentOperation.targetTag) {
    const target = _currentOperation.targetTag;
    for (const v of releaseEntries) {
      if (v.id === target) {
        v.availability = 'installing';
      }
    }
  }

  const storage = {
    dockerRootDir: null,
    freeBytes: Number.isFinite(Number(freeBytes)) ? Math.floor(Number(freeBytes)) : null,
    usedBytes: imageStats.usedBytes,
    estimateAfterUpdateBytes: estimateAfterUpdateBytes(freeBytes, latestReleaseTag, localByTag, imageStats)
  };

  return {
    versions: releaseEntries,
    retainedInstances,
    remoteInstances,
    retentionPolicy,
    portPreferences,
    uiUrl,
    lastSyncedAt,
    offline,
    storage,
    runtime
  };
}

async function refreshDockerManager(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const state = await buildDerivedState({ forceRefresh });
  _cachedState = state;
  events.emit('state', state);
  return state;
}

async function getDockerManagerState() {
  if (_cachedState) return _cachedState;
  return await refreshDockerManager({ forceRefresh: false });
}

function assertKeepCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error('Invalid retention policy');
    err.code = 'INVALID_RETENTION_POLICY';
    throw err;
  }
  const keepCount = Math.max(0, Math.min(20, Math.floor(n)));
  return keepCount;
}

function assertContainerId(value) {
  const v = (value || '').trim();
  if (!v || v.length > 128) {
    const err = new Error('Invalid container id');
    err.code = 'INVALID_CONTAINER_ID';
    throw err;
  }
  if (!/^[a-f0-9]+$/i.test(v)) {
    const err = new Error('Invalid container id');
    err.code = 'INVALID_CONTAINER_ID';
    throw err;
  }
  return v;
}

function assertDataLossAck(value) {
  const v = (value || '').trim();
  if (v !== 'has_backup' && v !== 'proceed_without_backup') {
    const err = new Error('Invalid data loss acknowledgement');
    err.code = 'INVALID_DATA_LOSS_ACK';
    throw err;
  }
  return v;
}

function sanitizeInstanceName(value, fallback = 'agent-zero') {
  const v = (value || '').trim();
  const cleaned = v
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return cleaned || fallback;
}

function parsePortMappings(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const source = raw || '0:80';
  const tokens = source
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!tokens.length) tokens.push('0:80');
  if (tokens.length > 12) {
    const err = new Error('Too many port mappings');
    err.code = 'INVALID_PORT_MAPPINGS';
    throw err;
  }

  const mappings = [];
  const seen = new Set();

  for (const token of tokens) {
    const parts = token.split(':');
    if (parts.length !== 2) {
      const err = new Error(`Invalid port mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }

    const hostPort = Number(parts[0]);
    const containerPart = String(parts[1] || '').replace(/\/tcp$/i, '');
    const containerPort = Number(containerPart);

    if (!Number.isInteger(hostPort) || hostPort < 0 || hostPort > 65535) {
      const err = new Error(`Invalid host port in mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
      const err = new Error(`Invalid container port in mapping: ${token}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }

    const key = `${containerPort}/tcp`;
    if (seen.has(key)) {
      const err = new Error(`Duplicate container port mapping: ${containerPort}`);
      err.code = 'INVALID_PORT_MAPPINGS';
      throw err;
    }
    seen.add(key);
    mappings.push({ hostPort, containerPort, key });
  }

  return mappings;
}

function parseEnvText(value) {
  const raw = typeof value === 'string' ? value : '';
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 80) {
    const err = new Error('Too many environment variables');
    err.code = 'INVALID_ENV_VARS';
    throw err;
  }

  const env = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) {
      const err = new Error(`Invalid environment variable: ${line}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      const err = new Error(`Invalid environment variable name: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    if (seen.has(key)) {
      const err = new Error(`Duplicate environment variable: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    if (line.length > 4096) {
      const err = new Error(`Environment variable is too long: ${key}`);
      err.code = 'INVALID_ENV_VARS';
      throw err;
    }
    seen.add(key);
    env.push(`${key}=${val}`);
  }
  return env;
}

function normalizeActivationOptions(options = {}, tag = '') {
  const raw = options && typeof options === 'object' ? options : {};
  const fallbackName = sanitizeInstanceName(`agent-zero-${tag || 'instance'}`);
  const hasPortMappings = typeof raw.portMappings === 'string' && raw.portMappings.trim();
  return {
    instanceName: sanitizeInstanceName(raw.instanceName, fallbackName),
    portMappings: hasPortMappings ? parsePortMappings(raw.portMappings) : null,
    env: parseEnvText(raw.envText)
  };
}

function effectiveRetentionCount(policy) {
  const keepCount = Number.isFinite(Number(policy?.keepCount)) ? Number(policy.keepCount) : 1;
  // Safety baseline: keep at least one previous instance for rollback.
  return Math.max(1, Math.min(20, Math.floor(keepCount)));
}

async function setRetentionPolicy(keepCount) {
  requireNoRunningOperation();
  const kc = assertKeepCount(keepCount);
  const policy = await stateStore.writeRetentionPolicy({ keepCount: kc });
  await refreshDockerManager({ forceRefresh: false });
  return policy;
}

async function setPortPreferences(portPreferences) {
  requireNoRunningOperation();
  const prefs = await stateStore.writePortPreferences(portPreferences);
  await refreshDockerManager({ forceRefresh: false });
  return prefs;
}

async function provisionRuntime() {
  requireNoRunningOperation();
  const opId = beginOperation('runtime_setup', null);
  const finishRuntimeFollowup = async (result, assessment) => {
    if (!result || typeof result !== 'object' || typeof result.detail !== 'string') return false;
    await markRuntimeSetupResume(assessment);
    resetDocker();
    updateOperationProgress({ message: result.detail, progress: 100 });
    finishOperation('completed', null);
    return true;
  };

  (async () => {
    const controller = new AbortController();
    _abortControllers.set(opId, controller);

    try {
      const provisioner = await getRuntimeProvisioner();
      if (!provisioner) {
        const err = new Error('Automatic runtime setup is not available on this system.');
        err.code = 'RUNTIME_UNSUPPORTED';
        throw err;
      }

      updateOperationProgress({ message: 'Checking runtime', progress: null });
      const assessment = await provisioner.assess();

      if (assessment?.state === 'ready') {
        await clearRuntimeSetupResume();
        updateOperationProgress({ message: 'Runtime ready', progress: 100 });
        finishOperation('completed', null);
        resetDocker();
        return;
      }

      if (assessment?.state === 'engine_stopped') {
        const result = await provisioner.start({
          signal: controller.signal,
          onProgress: (message, progress = null) => updateOperationProgress({ message, progress })
        });
        if (await finishRuntimeFollowup(result, assessment)) return;
      } else if (assessment?.state === 'not_provisioned' || assessment?.state === 'needs_group_membership') {
        const result = await provisioner.provision({
          signal: controller.signal,
          onProgress: (message, progress = null) => updateOperationProgress({ message, progress })
        });
        if (await finishRuntimeFollowup(result, assessment)) return;
      } else if (assessment?.state === 'needs_relogin') {
        const err = new Error(assessment.detail || 'Log out and back in once, then return here.');
        err.code = 'RUNTIME_NEEDS_RELOGIN';
        throw err;
      } else if (assessment?.state === 'manual_install') {
        const err = new Error(assessment.detail || 'Manual Docker installation is required.');
        err.code = 'RUNTIME_MANUAL_INSTALL';
        err.details = {
          packageManager: assessment.packageManager,
          packages: assessment.manualPackages,
          manualCommand: assessment.manualCommand
        };
        throw err;
      } else {
        const err = new Error(assessment?.detail || 'Automatic runtime setup is not available on this system.');
        err.code = 'RUNTIME_UNSUPPORTED';
        throw err;
      }

      resetDocker();
      await clearRuntimeSetupResume();
      updateOperationProgress({ message: 'Runtime ready', progress: 100 });
      finishOperation('completed', null);
    } catch (error) {
      const message = mapDockerInterfaceErrorToUiMessage(error) || error?.message || 'Runtime setup failed';
      finishOperation('failed', message);
    } finally {
      _abortControllers.delete(opId);
      resetDocker();
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('provisionRuntime.unhandled', error, { opId });
  });

  return { opId };
}

async function resumeRuntimeSetupIfPending() {
  const marker = await stateStore.readRuntimeSetupResume().catch(() => null);
  if (!marker?.pending) return { resumed: false, reason: 'not_pending' };
  if (_currentOperation?.status === 'running') return { resumed: false, reason: 'operation_running' };

  const state = await refreshDockerManager({ forceRefresh: true });
  const runtime = state?.runtime;
  if (!runtime || runtime.state === 'ready') {
    await clearRuntimeSetupResume();
    return { resumed: false, reason: 'runtime_ready' };
  }

  if (!runtime.canProvision || runtime.requiresAdmin === true || !['install', 'start'].includes(runtime.action)) {
    return { resumed: false, reason: 'waiting_for_user', runtime };
  }

  return { resumed: true, ...(await provisionRuntime()) };
}

async function addRemoteInstance(remoteInstance) {
  const saved = await stateStore.writeRemoteInstance(remoteInstance);
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances };
    events.emit('state', _cachedState);
  }
  return saved;
}

async function deleteRemoteInstance(id) {
  const result = await stateStore.deleteRemoteInstance(id);
  if (_cachedState) {
    const remoteInstances = await stateStore.readRemoteInstances();
    _cachedState = { ..._cachedState, remoteInstances };
    events.emit('state', _cachedState);
  }
  return result;
}

async function getRemoteInstance(id) {
  const cleanId = String(id || '').trim();
  const remoteInstances = await stateStore.readRemoteInstances();
  const found = remoteInstances.find((item) => item.id === cleanId) || null;
  if (!found) {
    const err = new Error('Remote instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }
  return found;
}

async function createAndStartActiveContainer(docker, imageRepo, tag, portPreferences, activationOptions = null) {
  const activeName = retention.getActiveContainerName(imageRepo);
  const imageRef = imageRefForTag(imageRepo, tag);

  const prefs = portPreferences && typeof portPreferences === 'object'
    ? portPreferences
    : await stateStore.readPortPreferences();

  const toPort = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const p = Math.floor(n);
    if (p <= 0 || p > 65535) return fallback;
    return p;
  };

  const hostPortUi = toPort(prefs?.ui, 8880);
  const hostPortSsh = toPort(prefs?.ssh, 55022);

  const mappings = Array.isArray(activationOptions?.portMappings) && activationOptions.portMappings.length
    ? activationOptions.portMappings
    : [
        { hostPort: hostPortUi, containerPort: 80, key: '80/tcp' },
        { hostPort: hostPortSsh, containerPort: 22, key: '22/tcp' }
      ];

  const exposedPorts = {};
  const portBindings = {};
  for (const mapping of mappings) {
    const key = mapping.key || `${mapping.containerPort}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostIp: '127.0.0.1', HostPort: String(mapping.hostPort) }];
  }

  const instanceName = sanitizeInstanceName(activationOptions?.instanceName, sanitizeInstanceName(`agent-zero-${tag}`));
  const portMapLabel = mappings.map((m) => `${m.hostPort}:${m.containerPort}`).join(',');

  const createOptions = {
    name: activeName,
    Image: imageRef,
    ExposedPorts: exposedPorts,
    Labels: {
      'a0.launcher.managed': 'true',
      'a0.launcher.role': 'active',
      'a0.launcher.versionTag': tag,
      'a0.launcher.instanceName': instanceName,
      'a0.launcher.port.map': portMapLabel,
      'a0.launcher.port.ui': String(mappings.find((m) => Number(m.containerPort) === 80)?.hostPort ?? hostPortUi),
      'a0.launcher.port.ssh': String(mappings.find((m) => Number(m.containerPort) === 22)?.hostPort ?? '')
    },
    HostConfig: {
      PortBindings: portBindings
    }
  };

  if (Array.isArray(activationOptions?.env) && activationOptions.env.length) {
    createOptions.Env = activationOptions.env;
  }

  const created = await docker.createContainer(createOptions);
  const containerId = created?.containerId;
  if (!containerId) {
    const err = new Error('Failed to create container');
    err.code = 'CREATE_FAILED';
    throw err;
  }

  await docker.startContainer(containerId);
  return { containerId, name: activeName };
}

async function enforceRetention(docker, imageRepo, policy) {
  const keep = effectiveRetentionCount(policy);
  const containers = await docker.listContainers(imageRepo);

  const retained = [];
  for (const c of containers || []) {
    const name = c?.containerName || '';
    const parsed = retention.parseRetainedContainerName(name);
    if (!parsed) continue;
    retained.push({ containerId: c?.containerId || '', retainedAt: parsed.retainedAt });
  }

  retained.sort((a, b) => {
    const ams = isoToMs(a.retainedAt);
    const bms = isoToMs(b.retainedAt);
    if (Number.isFinite(bms) && Number.isFinite(ams)) return bms - ams;
    return String(b.retainedAt).localeCompare(String(a.retainedAt));
  });

  const toDelete = retained.slice(keep);
  for (const r of toDelete) {
    if (!r.containerId) continue;
    try {
      await docker.deleteContainer(r.containerId, { force: true });
    } catch {
      // best-effort retention cleanup
    }
  }
}

async function installOrSync(tag) {
  const imageRepo = getBackendImageRepo();
  const t = assertTagAllowedForInstall(tag);

  requireNoRunningOperation();
  const opId = beginOperation('install', t);

  (async () => {
    let docker;
    try {
      updateOperationProgress({ message: 'Checking availability', progress: null });

      docker = await getDocker({ imageRepo });
      const cache = await stateStore.readInstallabilityCache();
      const entries = cache?.entries && typeof cache.entries === 'object' ? cache.entries : {};

      const nowMs = Date.now();
      const existing = entries[t];
      const status = existing?.status || 'unknown';
      const checkedAtMs = isoToMs(existing?.checkedAt);
      const recheckAfterMs = isoToMs(existing?.recheckAfter);

      let needCheck = true;
      if (status === 'installable' && Number.isFinite(checkedAtMs) && nowMs - checkedAtMs < 24 * 60 * 60 * 1000) {
        needCheck = false;
      }
      if (status === 'not_yet_available' && Number.isFinite(recheckAfterMs) && nowMs < recheckAfterMs) {
        const err = new Error('Not yet available');
        err.code = 'NOT_YET_AVAILABLE';
        throw err;
      }

      if (needCheck) {
        const digestInfo = await docker.getRemoteDigest(imageRepo, t);
        const exists = !!digestInfo?.exists;
        if (!exists) {
          entries[t] = {
            status: 'not_yet_available',
            checkedAt: nowIso(),
            recheckAfter: new Date(nowMs + 15 * 60 * 1000).toISOString(),
            digest: null,
            contentType: null
          };
          await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
          const err = new Error('Not yet available');
          err.code = 'NOT_YET_AVAILABLE';
          throw err;
        }

        entries[t] = {
          status: 'installable',
          checkedAt: nowIso(),
          recheckAfter: null,
          digest: digestInfo?.digest || null,
          contentType: digestInfo?.contentType || null
        };
        await stateStore.writeInstallabilityCache({ ...cache, entries, updatedAt: nowIso() });
      }

      updateOperationProgress({ message: 'Downloading', progress: null, downloadProgress: 0, extractProgress: 0 });

      const controller = new AbortController();
      _abortControllers.set(opId, controller);

      const imageRef = imageRefForTag(imageRepo, t);
      const result = await docker.pullImage(imageRef, {
        signal: controller.signal,
        onProgress: (evt) => {
          const dl =
            typeof evt?.downloadProgress === 'number' && Number.isFinite(evt.downloadProgress) ? evt.downloadProgress : null;
          const ex =
            typeof evt?.extractProgress === 'number' && Number.isFinite(evt.extractProgress) ? evt.extractProgress : null;

          const message =
            typeof dl === 'number' && dl < 100 ? 'Downloading' : typeof ex === 'number' && ex < 100 ? 'Extracting' : 'Downloading';

          updateOperationProgress({ progress: dl, downloadProgress: dl, extractProgress: ex, message });
        }
      });

      if (result?.status === 'aborted_client') {
        finishOperation('canceled', 'Canceled');
      } else {
        finishOperation('completed', null);
        updateOperationProgress({ progress: 100, downloadProgress: 100, extractProgress: 100, message: 'Completed' });
      }
    } catch (error) {
      const message =
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_YET_AVAILABLE'
          ? 'This version is not available yet. Please try again later.'
          : '') ||
        'Install failed';
      finishOperation('failed', message);
    } finally {
      _abortControllers.delete(opId);
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function stopActiveInstance() {
  const imageRepo = getBackendImageRepo();

  requireNoRunningOperation();
  const opId = beginOperation('stop', null);

  (async () => {
    try {
      updateOperationProgress({ message: 'Stopping', progress: null });
      const docker = await getDocker({ imageRepo });
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (!active || !active.containerId) {
        const err = new Error('No active instance');
        err.code = 'NO_ACTIVE_INSTANCE';
        throw err;
      }

      const state = (active.state || '').toLowerCase();
      if (state === 'running') {
        await docker.stopContainer(active.containerId, { t: 10 });
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Stopped' });
    } catch (error) {
      const message = mapDockerInterfaceErrorToUiMessage(error) || 'Stop failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function startActiveInstance() {
  const imageRepo = getBackendImageRepo();

  requireNoRunningOperation();
  const opId = beginOperation('start', null);

  (async () => {
    try {
      updateOperationProgress({ message: 'Starting', progress: null });
      const docker = await getDocker({ imageRepo });
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (!active || !active.containerId) {
        const err = new Error('No active instance');
        err.code = 'NO_ACTIVE_INSTANCE';
        throw err;
      }

      const state = (active.state || '').toLowerCase();
      if (state !== 'running') {
        await docker.startContainer(active.containerId);
      }

      updateOperationProgress({ message: 'Starting (waiting for UI)', progress: null });
      const waitRes = await waitForUiReachable(docker, active.containerId, {
        timeoutMs: UI_READY_TIMEOUT_MS,
        intervalMs: 450,
        attemptTimeoutMs: 350,
        onTick: (seconds) => {
          const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
          updateOperationProgress({ message: `Starting (waiting for UI${s})`, progress: null });
        }
      });
      if (!waitRes.ok) {
        const err = new Error('Agent Zero UI is not reachable yet. Please wait and try Refresh.');
        err.code = 'UI_NOT_READY';
        throw err;
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Started' });
    } catch (error) {
      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        'Start failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function deleteRetainedInstance(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);

  requireNoRunningOperation();
  const opId = beginOperation('delete_instance', null);

  (async () => {
    try {
      const docker = await getDocker({ imageRepo });
      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (active && active.containerId === id) {
        const err = new Error('Cannot delete active instance');
        err.code = 'CANNOT_DELETE_ACTIVE';
        throw err;
      }

      const target = (containers || []).find((c) => c && c.containerId === id) || null;
      if (!target || !retention.parseRetainedContainerName(target.containerName || '')) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      await docker.deleteContainer(id, { force: true });
      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Deleted' });
    } catch (error) {
      const message =
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'CANNOT_DELETE_ACTIVE'
          ? 'You cannot delete the active instance.'
          : '') ||
        'Delete failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch(() => {});

  return { opId };
}

async function updateToLatest(dataLossAck) {
  const imageRepo = getBackendImageRepo();
  const githubRepo = getBackendGithubRepo();
  const ack = assertDataLossAck(dataLossAck);

  requireNoRunningOperation();
  const opId = beginOperation('update', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let policy = null;
    let keep = 0;
    let portPreferences = null;

    let retainedFromActive = null;
    let createdNew = null;

    try {
      docker = await getDocker({ imageRepo });
      policy = await stateStore.readRetentionPolicy();
      keep = effectiveRetentionCount(policy);
      portPreferences = await stateStore.readPortPreferences();

      updateOperationProgress({ message: 'Checking for updates', progress: null });

      const releasesResult = await releasesClient.listOfficialReleases({ githubRepo, forceRefresh: false });
      const releases = Array.isArray(releasesResult?.releases) ? releasesResult.releases : [];
      const latest = releases.length ? releases[0].tag : '';
      if (!latest) {
        const err = new Error('No official releases available');
        err.code = 'NO_RELEASES';
        throw err;
      }

      _currentOperation = { ..._currentOperation, targetTag: latest };
      events.emit('progress', { ..._currentOperation });

      // Verify installability before any destructive step.
      updateOperationProgress({ message: 'Verifying availability', progress: null });
      const digestInfo = await docker.getRemoteDigest(imageRepo, latest);
      if (!digestInfo?.exists) {
        const err = new Error('Not yet available');
        err.code = 'NOT_YET_AVAILABLE';
        throw err;
      }

      // Pull image first (fail-safe ordering).
      updateOperationProgress({ message: 'Downloading', progress: null, downloadProgress: 0, extractProgress: 0 });
      const controller = new AbortController();
      _abortControllers.set(opId, controller);
      const pullResult = await docker.pullImage(imageRefForTag(imageRepo, latest), {
        signal: controller.signal,
        onProgress: (evt) => {
          const dl =
            typeof evt?.downloadProgress === 'number' && Number.isFinite(evt.downloadProgress) ? evt.downloadProgress : null;
          const ex =
            typeof evt?.extractProgress === 'number' && Number.isFinite(evt.extractProgress) ? evt.extractProgress : null;

          const message =
            typeof dl === 'number' && dl < 100 ? 'Downloading' : typeof ex === 'number' && ex < 100 ? 'Extracting' : 'Downloading';

          updateOperationProgress({ progress: dl, downloadProgress: dl, extractProgress: ex, message });
        }
      });
      _abortControllers.delete(opId);

      if (pullResult?.status === 'aborted_client') {
        finishOperation('canceled', 'Canceled');
        return;
      }

      updateOperationProgress({ message: 'Switching versions', progress: null });

      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (active && active.containerId) {
        // Stop and retain current active.
        updateOperationProgress({ message: 'Stopping current version', progress: null });
        const state = (active.state || '').toLowerCase();
        if (!state || state === 'running') {
          try {
            await docker.stopContainer(active.containerId, { t: 10 });
          } catch (e) {
            const m = typeof e?.message === 'string' ? e.message : '';
            if (!m || !/is not running/i.test(m)) throw e;
          }
        }

        const retainedAt = nowIso();
        const retainedName = retention.makeRetainedContainerName(imageRepo, active.tag || 'unknown', retainedAt);
        await docker.renameContainer(active.containerId, retainedName);
        retainedFromActive = { containerId: active.containerId, name: retainedName, retainedAt };
      }

      // Create and start new active.
      updateOperationProgress({ message: 'Starting new version', progress: null });
      createdNew = await createAndStartActiveContainer(docker, imageRepo, latest, portPreferences);

      updateOperationProgress({ message: 'Starting new version (waiting for UI)', progress: null });
      if (createdNew && createdNew.containerId) {
        const waitRes = await waitForUiReachable(docker, createdNew.containerId, {
          timeoutMs: UI_READY_TIMEOUT_MS,
          intervalMs: 450,
          attemptTimeoutMs: 350,
          onTick: (seconds) => {
            const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
            updateOperationProgress({ message: `Starting new version (waiting for UI${s})`, progress: null });
          }
        });
        if (!waitRes.ok) {
          const err = new Error('Agent Zero UI is not reachable yet after switching versions.');
          err.code = 'UI_NOT_READY';
          throw err;
        }
      }

      // Enforce retention after success.
      if (keep > 0) {
        await enforceRetention(docker, imageRepo, policy);
      }

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed' });
    } catch (error) {
      logDockerManagerError('updateToLatest', error, { opId });
      // Best-effort rollback if a previous active was retained and new start failed.
      try {
        if (createdNew && createdNew.containerId) {
          await docker.deleteContainer(createdNew.containerId, { force: true });
        }
      } catch {
        // ignore
      }

      try {
        if (retainedFromActive && retainedFromActive.containerId) {
          const activeName = retention.getActiveContainerName(imageRepo);
          await docker.renameContainer(retainedFromActive.containerId, activeName);
          await docker.startContainer(retainedFromActive.containerId);
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_YET_AVAILABLE'
          ? 'The newest version is not available yet. Please try again later.'
          : '') ||
        'Update failed';
      finishOperation('failed', message);
    } finally {
      _abortControllers.delete(opId);
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('updateToLatest.unhandled', error, { opId });
  });

  return { opId, ack };
}

async function activateRetainedInstance(containerId, dataLossAck) {
  const imageRepo = getBackendImageRepo();
  const ack = assertDataLossAck(dataLossAck);
  const id = assertContainerId(containerId);

  requireNoRunningOperation();
  const opId = beginOperation('rollback', null);

  (async () => {
    /** @type {any} */
    let docker = null;
    let policy = null;
    let retainedFromActive = null;
    let target = null;

    try {
      docker = await getDocker({ imageRepo });
      policy = await stateStore.readRetentionPolicy();

      updateOperationProgress({ message: 'Preparing rollback', progress: null });

      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;
      target = (containers || []).find((c) => c && c.containerId === id) || null;

      if (!target || !retention.parseRetainedContainerName(target.containerName || '')) {
        const err = new Error('Instance not found');
        err.code = 'INSTANCE_NOT_FOUND';
        throw err;
      }

      _currentOperation = { ..._currentOperation, targetTag: target.tag || null };
      events.emit('progress', { ..._currentOperation });

      if (active && active.containerId) {
        updateOperationProgress({ message: 'Stopping current version', progress: null });
        const state = (active.state || '').toLowerCase();
        if (!state || state === 'running') {
          try {
            await docker.stopContainer(active.containerId, { t: 10 });
          } catch (e) {
            const m = typeof e?.message === 'string' ? e.message : '';
            if (!m || !/is not running/i.test(m)) throw e;
          }
        }

        const retainedAt = nowIso();
        const retainedName = retention.makeRetainedContainerName(imageRepo, active.tag || 'unknown', retainedAt);
        await docker.renameContainer(active.containerId, retainedName);
        retainedFromActive = { containerId: active.containerId };
      }

      updateOperationProgress({ message: 'Starting selected version', progress: null });
      await docker.renameContainer(id, activeName);
      await docker.startContainer(id);

      updateOperationProgress({ message: 'Starting selected version (waiting for UI)', progress: null });
      const waitRes = await waitForUiReachable(docker, id, {
        timeoutMs: UI_READY_TIMEOUT_MS,
        intervalMs: 450,
        attemptTimeoutMs: 350,
        onTick: (seconds) => {
          const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
          updateOperationProgress({ message: `Starting selected version (waiting for UI${s})`, progress: null });
        }
      });
      if (!waitRes.ok) {
        const err = new Error('Agent Zero UI is not reachable yet after starting this version.');
        err.code = 'UI_NOT_READY';
        throw err;
      }

      await enforceRetention(docker, imageRepo, policy);

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed' });
    } catch (error) {
      logDockerManagerError('activateRetainedInstance', error, { opId, containerId: id });
      // Best-effort revert: if we stopped/retained active, try to restore it.
      try {
        if (retainedFromActive && retainedFromActive.containerId) {
          const activeName = retention.getActiveContainerName(imageRepo);
          await docker.renameContainer(retainedFromActive.containerId, activeName);
          await docker.startContainer(retainedFromActive.containerId);
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'INSTANCE_NOT_FOUND' ? 'Instance not found.' : '') ||
        'Rollback failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('activateRetainedInstance.unhandled', error, { opId, containerId: id });
  });

  return { opId, ack };
}

async function activateTag(tag, dataLossAck, options = {}) {
  const imageRepo = getBackendImageRepo();
  const t = assertTagAllowedForActivate(tag);
  const ack = assertDataLossAck(dataLossAck);
  const activationOptions = normalizeActivationOptions(options, t);

  requireNoRunningOperation();
  const opId = beginOperation('activate', t);

  (async () => {
    /** @type {any} */
    let docker = null;
    let policy = null;
    let portPreferences = null;

    let retainedFromActive = null;
    let createdNew = null;

    try {
      docker = await getDocker({ imageRepo });
      policy = await stateStore.readRetentionPolicy();
      portPreferences = await stateStore.readPortPreferences();

      updateOperationProgress({ message: 'Preparing switch', progress: null });

      const localImages = await docker.listLocalImages(imageRepo);
      const hasTag = (localImages || []).some((img) => img && typeof img.tag === 'string' && img.tag === t);
      if (!hasTag) {
        const err = new Error('Version is not installed');
        err.code = 'NOT_INSTALLED';
        throw err;
      }

      const containers = await docker.listContainers(imageRepo);
      const activeName = retention.getActiveContainerName(imageRepo);
      const active = (containers || []).find((c) => c && c.containerName === activeName) || null;

      if (active && active.containerId) {
        updateOperationProgress({ message: 'Stopping current version', progress: null });
        const state = (active.state || '').toLowerCase();
        if (!state || state === 'running') {
          try {
            await docker.stopContainer(active.containerId, { t: 10 });
          } catch (e) {
            const m = typeof e?.message === 'string' ? e.message : '';
            if (!m || !/is not running/i.test(m)) throw e;
          }
        }

        const retainedAt = nowIso();
        const retainedName = retention.makeRetainedContainerName(imageRepo, active.tag || 'unknown', retainedAt);
        await docker.renameContainer(active.containerId, retainedName);
        retainedFromActive = { containerId: active.containerId };
      }

      updateOperationProgress({ message: 'Starting selected version', progress: null });
      createdNew = await createAndStartActiveContainer(docker, imageRepo, t, portPreferences, activationOptions);

      updateOperationProgress({ message: 'Starting selected version (waiting for UI)', progress: null });
      if (createdNew && createdNew.containerId) {
        const waitRes = await waitForUiReachable(docker, createdNew.containerId, {
          timeoutMs: UI_READY_TIMEOUT_MS,
          intervalMs: 450,
          attemptTimeoutMs: 350,
          onTick: (seconds) => {
            const s = Number.isFinite(Number(seconds)) && seconds > 0 ? ` - ${Math.floor(seconds)}s` : '';
            updateOperationProgress({ message: `Starting selected version (waiting for UI${s})`, progress: null });
          }
        });
        if (!waitRes.ok) {
          const err = new Error('Agent Zero UI is not reachable yet after switching versions.');
          err.code = 'UI_NOT_READY';
          throw err;
        }
      }

      await enforceRetention(docker, imageRepo, policy);

      finishOperation('completed', null);
      updateOperationProgress({ progress: 100, message: 'Completed' });
    } catch (error) {
      logDockerManagerError('activateTag', error, { opId, tag: t });
      try {
        if (createdNew && createdNew.containerId) {
          await docker.deleteContainer(createdNew.containerId, { force: true });
        }
      } catch {
        // ignore
      }

      try {
        if (retainedFromActive && retainedFromActive.containerId) {
          const activeName = retention.getActiveContainerName(imageRepo);
          await docker.renameContainer(retainedFromActive.containerId, activeName);
          await docker.startContainer(retainedFromActive.containerId);
        }
      } catch {
        // ignore
      }

      const message =
        (error && typeof error === 'object' && error.code === 'UI_NOT_READY' && error.message) ||
        mapDockerInterfaceErrorToUiMessage(error) ||
        (error && typeof error === 'object' && error.code === 'NOT_INSTALLED'
          ? 'This version is not installed yet.'
          : '') ||
        'Switch failed';
      finishOperation('failed', message);
    } finally {
      await refreshDockerManager({ forceRefresh: false }).catch(() => {});
    }
  })().catch((error) => {
    logDockerManagerError('activateTag.unhandled', error, { opId, tag: t });
  });

  return { opId, ack };
}

async function cancelOperation(opId) {
  const id = (opId || '').trim();
  if (!id) {
    const err = new Error('Invalid opId');
    err.code = 'INVALID_OP_ID';
    throw err;
  }

  if (!_currentOperation || _currentOperation.opId !== id) {
    const err = new Error('Operation not found');
    err.code = 'OP_NOT_FOUND';
    throw err;
  }

  if (_currentOperation.status !== 'running') {
    return { canceled: false };
  }

  const controller = _abortControllers.get(id);
  if (!controller) return { canceled: false };

  try {
    controller.abort();
  } catch {
    // ignore
  }

  return { canceled: true };
}

async function getDockerInventory() {
  const imageRepo = getBackendImageRepo();
  const remoteInstances = await stateStore.readRemoteInstances();
  const docker = await getDocker({ imageRepo });
  const env = await docker.getEnvironment();
  const runtime = await assessRuntime(env);

  // Even when the ping-based env detection reports unavailable, attempt listing
  // so that Docker setups where ping fails but operations work are not blocked.
  let images = [];
  let containers = [];
  let volumes = [];
  let listingSucceeded = false;

  try {
    const results = await Promise.all([
      docker.listLocalImages(imageRepo),
      docker.listContainers(imageRepo),
      docker.listVolumes()
    ]);
    images = Array.isArray(results[0]) ? results[0] : [];
    containers = Array.isArray(results[1]) ? results[1] : [];
    volumes = Array.isArray(results[2]) ? results[2] : [];
    listingSucceeded = images.length > 0 || containers.length > 0 || volumes.length > 0;
  } catch {
    // Listing failed - Docker is genuinely unavailable.
  }

  const dockerAvailable = !!(env?.dockerAvailable || listingSucceeded);

  return {
    dockerAvailable,
    environment: env || null,
    runtime,
    images,
    containers,
    volumes,
    remoteInstances
  };
}

async function removeVolume(volumeName) {
  const name = (volumeName || '').trim();
  if (!name) {
    const err = new Error('Invalid volumeName');
    err.code = 'INVALID_VOLUME_NAME';
    throw err;
  }
  const imageRepo = getBackendImageRepo();
  const docker = await getDocker({ imageRepo });
  await docker.removeVolume(name);
  return { removed: true };
}

async function pruneVolumes() {
  const imageRepo = getBackendImageRepo();
  const docker = await getDocker({ imageRepo });
  const result = await docker.pruneVolumes();
  return result && typeof result === 'object' ? result : {};
}

async function getContainerUiUrl(containerId) {
  const imageRepo = getBackendImageRepo();
  const id = assertContainerId(containerId);
  const docker = await getDocker({ imageRepo });
  const inspect = await docker.inspectContainer(id);
  const candidate = bestEffortUiUrlFromInspect(inspect);
  if (!candidate) return null;

  const hp = parseHostPortFromLocalUrl(candidate);
  if (!hp) return null;

  const ok = await isHttpPortReachable(hp.host, hp.port, 500);
  return ok ? candidate : null;
}

module.exports = {
  // Config
  getBackendImageRepo,
  getBackendGithubRepo,
  imageRefForTag,

  // Tag allowlist helpers (used by IPC boundary)
  isSafeTag,
  isSemverReleaseTag,
  isTestingTag,
  isCanonicalLocalTag,
  assertTagAllowedForInstall,
  assertTagAllowedForActivate,

  // State + events
  getDockerManagerState,
  refreshDockerManager,
  getCurrentOperation,
  events,

  // Operations (implemented in later tasks)
  installOrSync,
  startActiveInstance,
  stopActiveInstance,
  setRetentionPolicy,
  setPortPreferences,
  provisionRuntime,
  resumeRuntimeSetupIfPending,
  addRemoteInstance,
  deleteRemoteInstance,
  getRemoteInstance,
  deleteRetainedInstance,
  updateToLatest,
  activateRetainedInstance,
  activateTag,
  cancelOperation,
  getDockerInventory,
  removeVolume,
  pruneVolumes,
  getContainerUiUrl,

  // Error helpers for IPC handlers
  toErrorResponse
};
