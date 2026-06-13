const path = require('node:path');
const fs = require('node:fs/promises');
const { app } = require('electron');

function baseDir() {
  return path.join(app.getPath('userData'), 'docker_manager');
}

function cacheDir() {
  return path.join(baseDir(), 'cache');
}

function stateFile() {
  return path.join(baseDir(), 'state.json');
}

function releasesCacheFile() {
  return path.join(cacheDir(), 'releases.json');
}

function installabilityCacheFile() {
  return path.join(cacheDir(), 'installability.json');
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, json, 'utf8');
}

async function readRetentionPolicy() {
  const state = await readJson(stateFile(), {});
  const keepCount = Number.isFinite(Number(state?.retentionPolicy?.keepCount))
    ? Number(state.retentionPolicy.keepCount)
    : 1;
  return { keepCount: Math.max(0, Math.min(20, Math.floor(keepCount))) };
}

async function writeRetentionPolicy(retentionPolicy) {
  const keepCount = Number.isFinite(Number(retentionPolicy?.keepCount))
    ? Number(retentionPolicy.keepCount)
    : 1;
  const policy = { keepCount: Math.max(0, Math.min(20, Math.floor(keepCount))) };
  const state = await readJson(stateFile(), {});
  await writeJson(stateFile(), { ...state, retentionPolicy: policy, updatedAt: new Date().toISOString() });
  return policy;
}

async function readInstallabilityCache() {
  const cache = await readJson(installabilityCacheFile(), { entries: {} });
  const entries = cache && typeof cache.entries === 'object' ? cache.entries : {};
  return { ...cache, entries };
}

async function writeInstallabilityCache(cache) {
  const payload = cache && typeof cache === 'object' ? cache : { entries: {} };
  const entries = payload && typeof payload.entries === 'object' ? payload.entries : {};
  await writeJson(installabilityCacheFile(), { ...payload, entries });
}

const DEFAULT_PORT_PREFERENCES = Object.freeze({
  ui: 8880,
  ssh: 55022
});

const MAX_REMOTE_INSTANCES = 64;

function normalizePort(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const p = Math.floor(n);
  if (p <= 0 || p > 65535) return fallback;
  return p;
}

function isDistinctPorts(prefs) {
  const a = prefs.ui;
  const b = prefs.ssh;
  return a !== b;
}

async function readPortPreferences() {
  const state = await readJson(stateFile(), {});
  const pp = state?.portPreferences && typeof state.portPreferences === 'object' ? state.portPreferences : {};

  const prefs = {
    ui: normalizePort(pp.ui, DEFAULT_PORT_PREFERENCES.ui),
    ssh: normalizePort(pp.ssh, DEFAULT_PORT_PREFERENCES.ssh)
  };

  if (!isDistinctPorts(prefs)) {
    return { ...DEFAULT_PORT_PREFERENCES };
  }
  return prefs;
}

async function writePortPreferences(portPreferences) {
  const prefsIn = portPreferences && typeof portPreferences === 'object' ? portPreferences : {};
  const prefs = {
    ui: normalizePort(prefsIn.ui, DEFAULT_PORT_PREFERENCES.ui),
    ssh: normalizePort(prefsIn.ssh, DEFAULT_PORT_PREFERENCES.ssh)
  };

  if (!isDistinctPorts(prefs)) {
    const err = new Error('Invalid port preferences');
    err.code = 'INVALID_PORT_PREFERENCES';
    throw err;
  }

  const state = await readJson(stateFile(), {});
  await writeJson(stateFile(), { ...state, portPreferences: prefs, updatedAt: new Date().toISOString() });
  return prefs;
}

function normalizeRuntimeSetupResume(value) {
  if (!value || typeof value !== 'object' || value.pending !== true) return null;
  return {
    pending: true,
    reason: typeof value.reason === 'string' ? value.reason : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : ''
  };
}

async function readRuntimeSetupResume() {
  const state = await readJson(stateFile(), {});
  return normalizeRuntimeSetupResume(state?.runtimeSetupResume);
}

async function writeRuntimeSetupResume(runtimeSetupResume) {
  const now = new Date().toISOString();
  const state = await readJson(stateFile(), {});
  const current = normalizeRuntimeSetupResume(state?.runtimeSetupResume);
  const reason = typeof runtimeSetupResume?.reason === 'string' ? runtimeSetupResume.reason : '';
  const marker = {
    pending: true,
    reason,
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
  await writeJson(stateFile(), { ...state, runtimeSetupResume: marker, updatedAt: now });
  return marker;
}

async function clearRuntimeSetupResume() {
  const state = await readJson(stateFile(), {});
  if (!state || typeof state !== 'object' || !('runtimeSetupResume' in state)) return false;
  const next = { ...state };
  delete next.runtimeSetupResume;
  next.updatedAt = new Date().toISOString();
  await writeJson(stateFile(), next);
  return true;
}

function remoteInstanceError(message = 'Invalid remote instance') {
  const err = new Error(message);
  err.code = 'INVALID_REMOTE_INSTANCE';
  return err;
}

function normalizeRemoteInstanceId(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length > 96) return '';
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? v : '';
}

function createRemoteInstanceId() {
  return `remote_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeRemoteInstanceUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) throw remoteInstanceError('Missing remote instance URL');
  if (raw.length > 2048) throw remoteInstanceError('Remote instance URL is too long');

  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    raw = `http://${raw}`;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw remoteInstanceError('Invalid remote instance URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw remoteInstanceError('Unsupported remote instance URL');
  }
  if (!parsed.hostname) throw remoteInstanceError('Invalid remote instance URL');
  if (parsed.username || parsed.password) throw remoteInstanceError('Invalid remote instance URL');

  return parsed.href;
}

function normalizeRemoteInstanceName(value, url) {
  const raw = String(value || '').trim();
  let fallback = 'Remote instance';
  try {
    const parsed = new URL(url);
    fallback = parsed.hostname || fallback;
  } catch {
    // ignore
  }

  const cleaned = raw
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return cleaned || fallback;
}

function normalizeRemoteInstance(value, existing = null, options = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const url = normalizeRemoteInstanceUrl(input.url);
  const existingId = normalizeRemoteInstanceId(existing?.id);
  const inputId = normalizeRemoteInstanceId(input.id);
  const id = existingId || inputId || createRemoteInstanceId();
  const createdAt = typeof existing?.createdAt === 'string' ? existing.createdAt : new Date().toISOString();
  const shouldTouch = options?.touch !== false;
  const updatedAt = shouldTouch
    ? new Date().toISOString()
    : (typeof existing?.updatedAt === 'string' ? existing.updatedAt : createdAt);

  return {
    id,
    name: normalizeRemoteInstanceName(input.name ?? existing?.name, url),
    url,
    createdAt,
    updatedAt
  };
}

function normalizeRemoteInstanceForRead(value) {
  try {
    return normalizeRemoteInstance(value, value, { touch: false });
  } catch {
    return null;
  }
}

async function readRemoteInstances() {
  const state = await readJson(stateFile(), {});
  const raw = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  return raw
    .map((item) => normalizeRemoteInstanceForRead(item))
    .filter(Boolean)
    .slice(0, MAX_REMOTE_INSTANCES);
}

async function writeRemoteInstance(remoteInstance) {
  const state = await readJson(stateFile(), {});
  const current = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  const list = current.map((item) => normalizeRemoteInstanceForRead(item)).filter(Boolean).slice(0, MAX_REMOTE_INSTANCES);
  const input = remoteInstance && typeof remoteInstance === 'object' ? remoteInstance : {};
  const requestedId = normalizeRemoteInstanceId(input.id);
  const normalizedUrl = normalizeRemoteInstanceUrl(input.url);
  let existingIndex = requestedId ? list.findIndex((item) => item.id === requestedId) : -1;
  if (existingIndex < 0) existingIndex = list.findIndex((item) => item.url === normalizedUrl);

  const existing = existingIndex >= 0 ? list[existingIndex] : null;
  const next = normalizeRemoteInstance({ ...input, url: normalizedUrl }, existing);

  if (existingIndex >= 0) {
    list[existingIndex] = next;
  } else {
    if (list.length >= MAX_REMOTE_INSTANCES) {
      throw remoteInstanceError('Too many remote instances');
    }
    list.push(next);
  }

  await writeJson(stateFile(), { ...state, remoteInstances: list, updatedAt: new Date().toISOString() });
  return next;
}

async function deleteRemoteInstance(id) {
  const cleanId = normalizeRemoteInstanceId(id);
  if (!cleanId) throw remoteInstanceError('Invalid remote instance');

  const state = await readJson(stateFile(), {});
  const list = Array.isArray(state?.remoteInstances)
    ? state.remoteInstances.map((item) => normalizeRemoteInstanceForRead(item)).filter(Boolean)
    : [];
  const next = list.filter((item) => item.id !== cleanId);

  if (next.length === list.length) {
    const err = new Error('Remote instance not found');
    err.code = 'INSTANCE_NOT_FOUND';
    throw err;
  }

  await writeJson(stateFile(), { ...state, remoteInstances: next, updatedAt: new Date().toISOString() });
  return { deleted: true };
}

module.exports = {
  // Paths (shared by other modules)
  baseDir,
  cacheDir,
  stateFile,
  releasesCacheFile,
  installabilityCacheFile,

  // JSON helpers
  readJson,
  writeJson,

  // Retention policy
  readRetentionPolicy,
  writeRetentionPolicy,

  // Port preferences
  readPortPreferences,
  writePortPreferences,

  // Remote instances
  readRemoteInstances,
  writeRemoteInstance,
  deleteRemoteInstance,

  // Runtime setup resume
  readRuntimeSetupResume,
  writeRuntimeSetupResume,
  clearRuntimeSetupResume,

  // Installability cache
  readInstallabilityCache,
  writeInstallabilityCache
};
