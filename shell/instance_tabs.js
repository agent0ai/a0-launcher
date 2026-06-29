function parseHttpUrl(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch (_error) {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  if (!url.hostname) {
    return null;
  }

  return url;
}

function normalizeHttpUrl(value) {
  const url = parseHttpUrl(value);
  return url ? url.href : '';
}

function hasAllowedLocalPort(url) {
  if (!url.port) {
    return true;
  }

  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function isAllowedLocalInstanceUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const isLocalhost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1';
  return isLocalhost && hasAllowedLocalPort(url);
}

function isAllowedRemoteInstanceUrl(value) {
  return Boolean(parseHttpUrl(value));
}

function makeTabKey(target) {
  const safeTarget = target && typeof target === 'object' ? target : {};
  const kind = typeof safeTarget.kind === 'string' ? safeTarget.kind : '';
  const idKey = kind === 'remote' ? 'instanceId' : 'containerId';
  const id = typeof safeTarget[idKey] === 'string' ? safeTarget[idKey] : '';
  const url = normalizeHttpUrl(safeTarget.url);
  if (id) return `${kind}:${id}`;
  return `${kind}:${url}`;
}

function webUiLoginRequestForTarget(target, credentials) {
  const safeTarget = target && typeof target === 'object' ? target : {};
  const safeCredentials = credentials && typeof credentials === 'object' ? credentials : {};
  if (safeTarget.kind !== 'local' || !safeTarget.containerId) return null;

  const url = parseHttpUrl(safeTarget.url);
  if (!url || !isAllowedLocalInstanceUrl(url.href)) return null;

  const username = typeof safeCredentials.username === 'string' ? safeCredentials.username.trim() : '';
  const password = typeof safeCredentials.password === 'string' ? safeCredentials.password : '';
  if (!username || !password) return null;

  const next = `${url.pathname || '/'}${url.search || ''}` || '/';
  return {
    url: new URL('/login', url).href,
    body: new URLSearchParams({ username, password, next }).toString()
  };
}

function makeTabsSnapshot(tabs, activeTabId) {
  const source = tabs instanceof Map ? tabs.values() : [];
  return {
    tabs: Array.from(source, (tab) => {
      const safeTab = tab && typeof tab === 'object' ? tab : {};
      return {
        id: typeof safeTab.id === 'string' ? safeTab.id : '',
        kind: typeof safeTab.kind === 'string' ? safeTab.kind : '',
        title: typeof safeTab.title === 'string' ? safeTab.title : '',
        url: typeof safeTab.url === 'string' ? safeTab.url : '',
        containerId: typeof safeTab.containerId === 'string' ? safeTab.containerId : '',
        instanceId: typeof safeTab.instanceId === 'string' ? safeTab.instanceId : '',
        active: safeTab.id === activeTabId,
        loading: Boolean(safeTab.loading),
        canReload: Boolean(safeTab.canReload)
      };
    }),
    activeTabId: typeof activeTabId === 'string' ? activeTabId : ''
  };
}

module.exports = {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  makeTabsSnapshot
};
