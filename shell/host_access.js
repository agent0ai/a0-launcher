const DEFAULT_HOST_ACCESS_SCOPES = Object.freeze({
  files: true,
  file_write: true,
  code_execution: true,
  browser: false,
  computer_use: false
});

function normalizeHostAccessScopes(value, fallback = DEFAULT_HOST_ACCESS_SCOPES) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_HOST_ACCESS_SCOPES;
  const scopes = {
    files: typeof source.files === 'boolean' ? source.files : Boolean(base.files),
    file_write: typeof source.file_write === 'boolean'
      ? source.file_write
      : typeof source.files === 'boolean'
        ? source.files
        : Boolean(base.file_write ?? base.files),
    code_execution: typeof source.code_execution === 'boolean'
      ? source.code_execution
      : Boolean(base.code_execution),
    browser: typeof source.browser === 'boolean' ? source.browser : Boolean(base.browser),
    computer_use: typeof source.computer_use === 'boolean'
      ? source.computer_use
      : Boolean(base.computer_use)
  };
  if (!scopes.files) scopes.file_write = false;
  if (!scopes.file_write) scopes.code_execution = false;
  return scopes;
}

function normalizeHostFolder(value) {
  const folder = String(value || '').trim();
  if (!folder || folder.includes('\u0000') || /[\r\n]/.test(folder)) return '';
  return folder.slice(0, 4096);
}

function normalizeBrowserSelection(value) {
  const selection = String(value || '').trim().replace(/[\r\n\0]/g, '').slice(0, 512);
  try {
    const endpoint = new URL(selection);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase());
    if (
      ['ws:', 'wss:'].includes(endpoint.protocol)
      && loopback
      && /^\/devtools\/browser\/[^/]+$/i.test(endpoint.pathname)
    ) return '';
  } catch {
    // Stable browser IDs are not URLs.
  }
  return selection;
}

function validateBrowserEndpoint(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const message = 'Enter the local HTTP address shown by your browser, including its port. Do not include credentials or a DevTools WebSocket link.';
  if (!raw || raw.length > 512 || /[\s\\\u0000]/.test(raw)) throw new Error(message);
  let endpoint;
  try { endpoint = new URL(raw); } catch { throw new Error(message); }
  const port = raw.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})(?:\/|$)/i)?.[1];
  if (!['http:', 'https:'].includes(endpoint.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || !port || Number(port) < 1 || Number(port) > 65535
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !['', '/', '/json/version'].includes(endpoint.pathname)) throw new Error(message);
  return `${endpoint.protocol}//${endpoint.hostname}:${Number(port)}`;
}

function normalizeInstallationId(value) {
  const id = String(value || '').trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
}

function hostAccessInstanceKey(kind, id) {
  const type = kind === 'remote' ? 'remote' : 'local';
  const cleanId = String(id || '').trim().slice(0, 256);
  if (!cleanId || !/^[A-Za-z0-9._:-]+$/.test(cleanId)) return '';
  return `${type}:${cleanId}`;
}

function normalizeHostAccessDefaults(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const configured = typeof source.configured === 'boolean'
    ? source.configured
    : source.masterEnabled === true;
  return {
    configured,
    masterEnabled: typeof source.masterEnabled === 'boolean' ? source.masterEnabled : configured,
    folder: normalizeHostFolder(source.folder),
    scopes: normalizeHostAccessScopes(source.scopes),
    browserSelection: normalizeBrowserSelection(source.browserSelection)
  };
}

function normalizeHostAccessInstance(value, { kind = 'local', defaults = null } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallback = normalizeHostAccessDefaults(defaults);
  const local = kind !== 'remote';
  return {
    configured: typeof source.configured === 'boolean'
      ? source.configured
      : local && fallback.configured,
    masterEnabled: typeof source.masterEnabled === 'boolean'
      ? source.masterEnabled
      : fallback.masterEnabled,
    folder: normalizeHostFolder(source.folder || (local ? fallback.folder : '')),
    scopes: normalizeHostAccessScopes(source.scopes, fallback.scopes),
    browserSelection: normalizeBrowserSelection(
      source.browserSelection || (local ? fallback.browserSelection : '')
    )
  };
}

function normalizeHostAccessSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = normalizeHostAccessDefaults(source.defaults);
  const instances = {};
  const rawInstances = source.instances && typeof source.instances === 'object' && !Array.isArray(source.instances)
    ? source.instances
    : {};
  for (const [key, config] of Object.entries(rawInstances)) {
    const separator = key.indexOf(':');
    if (separator <= 0) continue;
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const normalizedKey = hostAccessInstanceKey(kind, id);
    if (!normalizedKey) continue;
    instances[normalizedKey] = normalizeHostAccessInstance(config, {
      kind: kind === 'remote' ? 'remote' : 'local',
      defaults
    });
    if (Object.keys(instances).length >= 512) break;
  }
  return {
    version: 1,
    onboardingComplete: source.onboardingComplete === true,
    installationId: normalizeInstallationId(source.installationId),
    defaults,
    instances
  };
}

function resolveInstanceHostAccess(settings, { kind = 'local', id = '', folder = '' } = {}, current = null) {
  const normalized = normalizeHostAccessSettings(settings);
  const key = hostAccessInstanceKey(kind, id);
  const saved = key ? normalized.instances[key] : null;
  const currentConfig = current && typeof current === 'object' && !Array.isArray(current) ? current : null;
  const config = normalizeHostAccessInstance(saved || currentConfig, { kind, defaults: normalized.defaults });
  const resolvedFolder = normalizeHostFolder(folder) || config.folder;
  return {
    key,
    kind: kind === 'remote' ? 'remote' : 'local',
    ...config,
    folder: resolvedFolder,
    folderSource: normalizeHostFolder(folder) ? 'instance_workspace' : config.folder ? 'configured' : ''
  };
}

function hostAccessMatchesGateway(config = {}, gateway = {}) {
  if ((config.masterEnabled !== false) !== (gateway.master_enabled !== false)) return false;
  return ['files', 'file_write', 'code_execution', 'browser', 'computer_use']
    .every((scope) => (config.scopes?.[scope] === true) === (gateway.scopes?.[scope] === true));
}

module.exports = {
  validateBrowserEndpoint,
  DEFAULT_HOST_ACCESS_SCOPES,
  normalizeHostAccessScopes,
  normalizeHostFolder,
  normalizeBrowserSelection,
  normalizeInstallationId,
  hostAccessInstanceKey,
  normalizeHostAccessDefaults,
  normalizeHostAccessInstance,
  normalizeHostAccessSettings,
  resolveInstanceHostAccess,
  hostAccessMatchesGateway
};
