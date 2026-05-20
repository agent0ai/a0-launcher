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

function isAllowedLocalInstanceUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
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
  return `${kind}:${id}:${url}`;
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
  makeTabsSnapshot
};
