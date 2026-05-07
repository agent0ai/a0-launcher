const path = require('node:path');
const fs = require('node:fs/promises');
const { app } = require('electron');

function baseDir() {
  return path.join(app.getPath('userData'), 'service_versions');
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

  // Installability cache
  readInstallabilityCache,
  writeInstallabilityCache
};
