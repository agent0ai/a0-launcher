const path = require('node:path');
const fs = require('node:fs/promises');
const { app, safeStorage } = require('electron');

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

const DEFAULT_STORAGE_PREFERENCES = Object.freeze({
  mode: 'host_directory',
  hostRoot: '~/agent-zero',
  hostPathMode: 'per_instance',
  volumePrefix: 'a0-launcher'
});

const MAX_REMOTE_INSTANCES = 64;
const MAX_LOCAL_INSTANCE_NAMES = 256;
const MAX_LOCAL_INSTANCE_COLORS = 256;
const MAX_LOCAL_INSTANCE_CREDENTIALS = 256;
const INSTANCE_COLOR_IDS = Object.freeze(['blue', 'green', 'rose', 'amber', 'violet', 'cyan', 'coral']);
const INSTANCE_COLOR_SET = new Set(INSTANCE_COLOR_IDS);
const LOCAL_CREDENTIALS_VERSION = 1;

const INSTANCE_DEFAULT_SLOT_IDS = Object.freeze(['Main', 'Utility', 'Embedding']);
const DEFAULT_INSTANCE_PROVIDERS = Object.freeze({
  Main: 'openrouter',
  Utility: 'openrouter',
  Embedding: 'huggingface'
});

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

function normalizePreferenceText(value, maxLength) {
  return String(value || '')
    .trim()
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, maxLength);
}

function normalizeStorageMode(value, fallback = DEFAULT_STORAGE_PREFERENCES.mode) {
  const mode = String(value || '').trim();
  if (mode === 'host_directory' || mode === 'named_volume') return mode;
  return fallback === 'named_volume' ? 'named_volume' : 'host_directory';
}

function normalizeHostRoot(value) {
  const text = normalizePreferenceText(value, 512);
  if (!text || /[\0\r\n]/.test(text)) return DEFAULT_STORAGE_PREFERENCES.hostRoot;
  return text;
}

function normalizeHostPathMode(value) {
  return String(value || '').trim() === 'exact' ? 'exact' : DEFAULT_STORAGE_PREFERENCES.hostPathMode;
}

function normalizeVolumePrefix(value) {
  const text = normalizePreferenceText(value, 120)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(text)) return text;
  return DEFAULT_STORAGE_PREFERENCES.volumePrefix;
}

function normalizeStoragePreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: normalizeStorageMode(input.mode),
    hostRoot: normalizeHostRoot(input.hostRoot),
    hostPathMode: normalizeHostPathMode(input.hostPathMode),
    volumePrefix: normalizeVolumePrefix(input.volumePrefix)
  };
}

async function readStoragePreferences() {
  const state = await readJson(stateFile(), {});
  return normalizeStoragePreferences(state?.storagePreferences);
}

async function writeStoragePreferences(storagePreferences) {
  const prefs = normalizeStoragePreferences(storagePreferences);
  const state = await readJson(stateFile(), {});
  await writeJson(stateFile(), { ...state, storagePreferences: prefs, updatedAt: new Date().toISOString() });
  return prefs;
}

function normalizeInstanceDefaults(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceModels = input.models && typeof input.models === 'object' && !Array.isArray(input.models) ? input.models : {};
  const models = {};

  for (const id of INSTANCE_DEFAULT_SLOT_IDS) {
    const source = sourceModels[id] && typeof sourceModels[id] === 'object' && !Array.isArray(sourceModels[id])
      ? sourceModels[id]
      : {};
    models[id] = {
      provider: normalizePreferenceText(source.provider, 96) || DEFAULT_INSTANCE_PROVIDERS[id],
      model: normalizePreferenceText(source.model, 256),
      apiKey: normalizePreferenceText(source.apiKey, 4096)
    };
  }

  return { models };
}

async function readInstanceDefaults() {
  const state = await readJson(stateFile(), {});
  return normalizeInstanceDefaults(state?.instanceDefaults);
}

async function writeInstanceDefaults(instanceDefaults) {
  const defaults = normalizeInstanceDefaults(instanceDefaults);
  const state = await readJson(stateFile(), {});
  await writeJson(stateFile(), { ...state, instanceDefaults: defaults, updatedAt: new Date().toISOString() });
  return defaults;
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

function normalizeRuntimeEndpointPreference(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const dockerHost = typeof value.dockerHost === 'string' ? value.dockerHost.trim() : '';
  if (!id || !dockerHost) return null;
  return {
    id,
    dockerHost,
    label: typeof value.label === 'string' ? value.label.trim() : '',
    provider: typeof value.provider === 'string' ? value.provider.trim() : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : ''
  };
}

async function readRuntimeEndpointPreference() {
  const state = await readJson(stateFile(), {});
  return normalizeRuntimeEndpointPreference(state?.runtimeEndpointPreference);
}

async function writeRuntimeEndpointPreference(runtimeEndpointPreference) {
  const input = runtimeEndpointPreference && typeof runtimeEndpointPreference === 'object' ? runtimeEndpointPreference : {};
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const dockerHost = typeof input.dockerHost === 'string' ? input.dockerHost.trim() : '';
  if (!id || !dockerHost) {
    const err = new Error('Invalid runtime endpoint');
    err.code = 'INVALID_RUNTIME_ENDPOINT';
    throw err;
  }
  const now = new Date().toISOString();
  const preference = {
    id,
    dockerHost,
    label: typeof input.label === 'string' ? input.label.trim() : '',
    provider: typeof input.provider === 'string' ? input.provider.trim() : '',
    updatedAt: now
  };
  const state = await readJson(stateFile(), {});
  await writeJson(stateFile(), { ...state, runtimeEndpointPreference: preference, updatedAt: now });
  return preference;
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

function localInstanceNameError(message = 'Invalid instance name') {
  const err = new Error(message);
  err.code = 'INVALID_INSTANCE_NAME';
  return err;
}

function localInstanceCredentialError(message, code = 'INVALID_INSTANCE_CREDENTIALS') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeInstanceColor(value) {
  const color = String(value || '').trim().toLowerCase();
  return INSTANCE_COLOR_SET.has(color) ? color : '';
}

function normalizeLocalInstanceId(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 128) return '';
  return /^[a-f0-9]+$/i.test(v) ? v : '';
}

function normalizeLocalInstanceName(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  if (!cleaned) throw localInstanceNameError('Instance name is required');
  return cleaned;
}

function normalizeCredentialText(value, maxLength, options = {}) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ');
  const trimmed = options?.trim === false ? cleaned : cleaned.trim();
  const normalized = options?.collapseWhitespace === false
    ? trimmed
    : trimmed.replace(/\s+/g, ' ');
  return normalized.slice(0, maxLength);
}

function normalizeEncryptedSecret(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 32_768) return '';
  return /^[A-Za-z0-9+/=]+$/.test(text) ? text : '';
}

function normalizeLocalInstanceNames(value) {
  const out = {};
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const [idRaw, nameRaw] of Object.entries(source)) {
    const id = normalizeLocalInstanceId(idRaw);
    if (!id) continue;
    try {
      const name = normalizeLocalInstanceName(nameRaw);
      out[id] = name;
    } catch {
      // Ignore stale invalid entries.
    }
    if (Object.keys(out).length >= MAX_LOCAL_INSTANCE_NAMES) break;
  }
  return out;
}

function normalizeLocalInstanceColors(value) {
  const out = {};
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const [idRaw, colorRaw] of Object.entries(source)) {
    const id = normalizeLocalInstanceId(idRaw);
    const color = normalizeInstanceColor(colorRaw);
    if (!id || !color) continue;
    out[id] = color;
    if (Object.keys(out).length >= MAX_LOCAL_INSTANCE_COLORS) break;
  }
  return out;
}

function normalizeLocalInstanceCredentialRecord(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const username = normalizeCredentialText(source.username, 256);
  const encryptedPassword = normalizeEncryptedSecret(source.encryptedPassword);
  if (!username || !encryptedPassword) return null;
  return {
    version: LOCAL_CREDENTIALS_VERSION,
    username,
    encryptedPassword,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : ''
  };
}

function normalizeLocalInstanceCredentials(value) {
  const out = {};
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  for (const [idRaw, recordRaw] of Object.entries(source)) {
    const id = normalizeLocalInstanceId(idRaw);
    const record = normalizeLocalInstanceCredentialRecord(recordRaw);
    if (!id || !record) continue;
    out[id] = record;
    if (Object.keys(out).length >= MAX_LOCAL_INSTANCE_CREDENTIALS) break;
  }
  return out;
}

function localInstanceCredentialMetadata(containerId, record) {
  return {
    containerId,
    saved: !!record,
    username: record?.username || '',
    updatedAt: record?.updatedAt || ''
  };
}

function requireSafeCredentialStorage() {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw localInstanceCredentialError(
      'Secure credential storage is not available in this launcher runtime.',
      'CREDENTIAL_STORAGE_UNAVAILABLE'
    );
  }
  if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) {
    throw localInstanceCredentialError(
      'Secure credential storage is not available on this system.',
      'CREDENTIAL_STORAGE_UNAVAILABLE'
    );
  }
  return safeStorage;
}

function encryptLocalInstancePassword(password) {
  const storage = requireSafeCredentialStorage();
  return storage.encryptString(password).toString('base64');
}

function decryptLocalInstancePassword(encryptedPassword) {
  const storage = requireSafeCredentialStorage();
  try {
    return storage.decryptString(Buffer.from(encryptedPassword, 'base64'));
  } catch {
    throw localInstanceCredentialError(
      'Saved credentials could not be read. Clear and save them again.',
      'CREDENTIALS_UNREADABLE'
    );
  }
}

function assertLocalInstanceCredentialStorageAvailable() {
  requireSafeCredentialStorage();
  return { available: true };
}

async function readLocalInstanceNames() {
  const state = await readJson(stateFile(), {});
  return normalizeLocalInstanceNames(state?.localInstanceNames);
}

async function readLocalInstanceColors() {
  const state = await readJson(stateFile(), {});
  return normalizeLocalInstanceColors(state?.localInstanceColors);
}

async function readLocalInstanceCredentialsMetadata() {
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceCredentials(state?.localInstanceCredentials);
  return Object.fromEntries(
    Object.entries(current).map(([containerId, record]) => [containerId, localInstanceCredentialMetadata(containerId, record)])
  );
}

async function readLocalInstanceCredentials(containerId) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) throw localInstanceCredentialError('Invalid instance');
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceCredentials(state?.localInstanceCredentials);
  const record = current[id] || null;
  if (!record) return null;
  return {
    containerId: id,
    username: record.username,
    password: decryptLocalInstancePassword(record.encryptedPassword),
    updatedAt: record.updatedAt || ''
  };
}

async function writeLocalInstanceName(containerId, name) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) throw localInstanceNameError('Invalid instance');
  const displayName = normalizeLocalInstanceName(name);
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceNames(state?.localInstanceNames);
  current[id] = displayName;
  await writeJson(stateFile(), { ...state, localInstanceNames: current, updatedAt: new Date().toISOString() });
  return { containerId: id, name: displayName };
}

async function deleteLocalInstanceName(containerId) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) return false;
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceNames(state?.localInstanceNames);
  if (!Object.prototype.hasOwnProperty.call(current, id)) return false;
  delete current[id];
  await writeJson(stateFile(), { ...state, localInstanceNames: current, updatedAt: new Date().toISOString() });
  return true;
}

async function writeLocalInstanceColor(containerId, color) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) throw localInstanceNameError('Invalid instance');
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceColors(state?.localInstanceColors);
  const cleanColor = normalizeInstanceColor(color);
  if (cleanColor) current[id] = cleanColor;
  else delete current[id];
  await writeJson(stateFile(), { ...state, localInstanceColors: current, updatedAt: new Date().toISOString() });
  return { containerId: id, color: cleanColor };
}

async function deleteLocalInstanceColor(containerId) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) return false;
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceColors(state?.localInstanceColors);
  if (!Object.prototype.hasOwnProperty.call(current, id)) return false;
  delete current[id];
  await writeJson(stateFile(), { ...state, localInstanceColors: current, updatedAt: new Date().toISOString() });
  return true;
}

async function writeLocalInstanceCredentials(containerId, credentials = {}) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) throw localInstanceCredentialError('Invalid instance');
  const username = normalizeCredentialText(credentials?.username, 256);
  const password = normalizeCredentialText(credentials?.password, 4096, { collapseWhitespace: false, trim: false });
  if (!username || !password) {
    throw localInstanceCredentialError('Username and password are required.');
  }

  const record = {
    version: LOCAL_CREDENTIALS_VERSION,
    username,
    encryptedPassword: encryptLocalInstancePassword(password),
    updatedAt: new Date().toISOString()
  };
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceCredentials(state?.localInstanceCredentials);
  current[id] = record;
  await writeJson(stateFile(), { ...state, localInstanceCredentials: current, updatedAt: new Date().toISOString() });
  return localInstanceCredentialMetadata(id, record);
}

async function deleteLocalInstanceCredentials(containerId) {
  const id = normalizeLocalInstanceId(containerId);
  if (!id) return false;
  const state = await readJson(stateFile(), {});
  const current = normalizeLocalInstanceCredentials(state?.localInstanceCredentials);
  if (!Object.prototype.hasOwnProperty.call(current, id)) return false;
  delete current[id];
  await writeJson(stateFile(), { ...state, localInstanceCredentials: current, updatedAt: new Date().toISOString() });
  return true;
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
  const hasColorInput = Object.prototype.hasOwnProperty.call(input, 'color');
  const color = normalizeInstanceColor(hasColorInput ? input.color : existing?.color);

  const out = {
    id,
    name: normalizeRemoteInstanceName(input.name ?? existing?.name, url),
    url,
    createdAt,
    updatedAt
  };
  if (color) out.color = color;
  return out;
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

  // Workspace storage preferences
  DEFAULT_STORAGE_PREFERENCES,
  normalizeStoragePreferences,
  readStoragePreferences,
  writeStoragePreferences,

  // Instance defaults
  readInstanceDefaults,
  writeInstanceDefaults,

  // Remote instances
  readRemoteInstances,
  writeRemoteInstance,
  deleteRemoteInstance,

  // Local instance display names
  readLocalInstanceNames,
  writeLocalInstanceName,
  deleteLocalInstanceName,
  readLocalInstanceColors,
  writeLocalInstanceColor,
  deleteLocalInstanceColor,
  readLocalInstanceCredentialsMetadata,
  readLocalInstanceCredentials,
  writeLocalInstanceCredentials,
  deleteLocalInstanceCredentials,
  assertLocalInstanceCredentialStorageAvailable,

  // Runtime setup resume
  readRuntimeSetupResume,
  writeRuntimeSetupResume,
  clearRuntimeSetupResume,
  readRuntimeEndpointPreference,
  writeRuntimeEndpointPreference,

  // Installability cache
  readInstallabilityCache,
  writeInstallabilityCache
};
