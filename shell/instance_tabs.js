const INSTANCE_COLOR_IDS = new Set(['blue', 'green', 'rose', 'amber', 'violet', 'cyan', 'coral']);
const INSTANCE_ICON_IDS = new Set([
  'language',
  'smart_toy',
  'psychology',
  'terminal',
  'rocket_launch',
  'hub',
  'science',
  'code',
  'memory',
  'explore',
  'bolt',
  'shield',
  'auto_awesome',
  'favorite'
]);

function normalizeInstanceColor(value) {
  const id = String(value || '').trim().toLowerCase();
  return INSTANCE_COLOR_IDS.has(id) || /^#[0-9a-f]{6}$/.test(id) ? id : '';
}

function normalizeInstanceIcon(value) {
  const image = normalizeInstanceFavicon(value);
  if (image) return image;
  const id = String(value || '').trim().toLowerCase();
  return INSTANCE_ICON_IDS.has(id) ? id : '';
}

const INSTANCE_FAVICON_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/x-icon', 'image/vnd.microsoft.icon'
]);
const MAX_INSTANCE_FAVICON_BYTES = 64 * 1024;

function normalizeInstanceFavicon(value) {
  if (typeof value !== 'string' || value.length > 96 * 1024) return '';
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  return match && INSTANCE_FAVICON_TYPES.has(match[1])
    && Buffer.byteLength(match[2], 'base64') <= MAX_INSTANCE_FAVICON_BYTES ? value : '';
}

async function loadInstanceFavicon(value, pageUrl, fetchImage) {
  try {
    if (typeof value !== 'string' || value.length > 96 * 1024) return '';
    const url = new URL(value);
    if (url.protocol === 'data:') {
      if (!/^data:image\//i.test(value)) return '';
    } else if (!parseHttpUrl(value) || url.origin !== new URL(pageUrl).origin) {
      return '';
    }
    // Electron's session fetch rejects data URLs; Node can decode them locally.
    const response = await (url.protocol === 'data:' ? fetch : fetchImage)(value, {
      credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || !INSTANCE_FAVICON_TYPES.has(type)) {
      await response.body?.cancel();
      return '';
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_INSTANCE_FAVICON_BYTES) return '';
      chunks.push(chunk);
    }
    return normalizeInstanceFavicon(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`);
  } catch {
    return '';
  }
}

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

function instanceUiSectionUrl(value, section) {
  const url = parseHttpUrl(value);
  if (!url) return '';
  if (String(section || '').trim() === 'self-update') {
    url.hash = 'section-self-update';
  }
  return url.href;
}

function instanceUiSectionScript(section) {
  if (String(section || '').trim() !== 'self-update') return '';
  return `(() => new Promise((resolve) => {
    let tries = 0;
    const openSelfUpdate = () => {
      const openModal = window.openModal || window.ensureModalOpen;
      if (typeof openModal === 'function') {
        openModal('settings/external/self-update-modal.html');
        resolve(true);
        return;
      }
      if (tries < 20) {
        tries += 1;
        window.setTimeout(openSelfUpdate, 100);
        return;
      }
      if (window.history && window.location) {
        window.history.replaceState(null, '', '#section-self-update');
      }
      resolve(false);
    };
    openSelfUpdate();
  }))()`;
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

function urlsShareOrigin(left, right) {
  try {
    const a = new URL(String(left || ''));
    const b = new URL(String(right || ''));
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

function isAllowedInstanceTabNavigationUrl(tab, value) {
  const safeTab = tab && typeof tab === 'object' ? tab : {};
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return false;
  const validator = safeTab.kind === 'remote' ? isAllowedRemoteInstanceUrl : isAllowedLocalInstanceUrl;
  return validator(normalized) && urlsShareOrigin(safeTab.url, normalized);
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
  const kind = typeof safeTarget.kind === 'string' ? safeTarget.kind : '';
  const hasTargetId =
    (kind === 'local' && !!safeTarget.containerId) ||
    (kind === 'remote' && !!safeTarget.instanceId);
  if (!hasTargetId) return null;

  const url = parseHttpUrl(safeTarget.url);
  if (!url) return null;
  const canPostLogin = isAllowedLocalInstanceUrl(url.href) || (kind === 'remote' && url.protocol === 'https:');
  if (!canPostLogin) return null;

  const username = typeof safeCredentials.username === 'string' ? safeCredentials.username.trim() : '';
  const password = typeof safeCredentials.password === 'string' ? safeCredentials.password : '';
  if (!username || !password) return null;

  const next = `${url.pathname || '/'}${url.search || ''}` || '/';
  return {
    url: new URL('/login', url).href,
    body: new URLSearchParams({ username, password, next }).toString()
  };
}

function loginCredentialsFromRequest(tab, details) {
  const request = details && typeof details === 'object' ? details : {};
  const loginUrl = parseHttpUrl(request.url);
  if (
    request.method !== 'POST' ||
    request.resourceType !== 'mainFrame' ||
    loginUrl?.pathname !== '/login' ||
    !cliCredentialsAllowedForTarget(tab) ||
    !isAllowedInstanceTabNavigationUrl(tab, loginUrl.href)
  ) {
    return null;
  }

  const chunks = [];
  let size = 0;
  for (const upload of Array.isArray(request.uploadData) ? request.uploadData : []) {
    if (!Buffer.isBuffer(upload?.bytes)) return null;
    size += upload.bytes.length;
    if (size > 8192) return null;
    chunks.push(upload.bytes);
  }
  if (!chunks.length) return null;

  const form = new URLSearchParams(Buffer.concat(chunks, size).toString('utf8'));
  const username = String(form.get('username') || '').trim();
  const password = String(form.get('password') || '');
  if (!username || username.length > 256 || !password || password.length > 4096) return null;
  return { username, password };
}

function instanceLoginRedirectSucceeded(tab, details) {
  const request = details && typeof details === 'object' ? details : {};
  const loginUrl = parseHttpUrl(request.url);
  const redirectUrl = parseHttpUrl(request.redirectURL);
  const statusCode = Number(request.statusCode);
  return Boolean(
    request.method === 'POST' &&
    request.resourceType === 'mainFrame' &&
    loginUrl?.pathname === '/login' &&
    statusCode >= 300 &&
    statusCode < 400 &&
    redirectUrl?.pathname !== '/login' &&
    isAllowedInstanceTabNavigationUrl(tab, redirectUrl?.href)
  );
}

function credentialSavePromptDecision(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }

  if (
    url.protocol !== 'a0-credential-prompt:' ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    return null;
  }

  if (url.hostname === 'save') return true;
  if (url.hostname === 'not-now') return false;
  return null;
}

function instanceTabLoginRecoveryTarget(tab, loginUrl) {
  const safeTab = tab && typeof tab === 'object' ? tab : {};
  const login = parseHttpUrl(loginUrl);
  if (!login || login.pathname !== '/login') return null;

  const previous = parseHttpUrl(safeTab.url);
  const returnUrl = previous && previous.origin === login.origin && previous.pathname !== '/login'
    ? previous
    : new URL('/', login);
  return { ...safeTab, url: returnUrl.href };
}

function cliCredentialsAllowedForTarget(target) {
  const safeTarget = target && typeof target === 'object' ? target : {};
  const kind = typeof safeTarget.kind === 'string' ? safeTarget.kind : '';
  const hasTargetId =
    (kind === 'local' && !!safeTarget.containerId) ||
    (kind === 'remote' && !!safeTarget.instanceId);
  if (!hasTargetId) return false;

  const url = parseHttpUrl(safeTarget.url);
  if (!url) return false;
  return isAllowedLocalInstanceUrl(url.href) || (kind === 'remote' && url.protocol === 'https:');
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
        canReload: Boolean(safeTab.canReload),
        color: normalizeInstanceColor(safeTab.color),
        icon: normalizeInstanceIcon(safeTab.icon),
        ...(normalizeInstanceFavicon(safeTab.favicon) ? { favicon: safeTab.favicon } : {}),
        ...(safeTab.detached === true ? { detached: true } : {}),
        hostAccess: safeTab.hostAccess && typeof safeTab.hostAccess === 'object'
          ? safeTab.hostAccess
          : { state: 'disconnected', connected: false }
      };
    }),
    activeTabId: typeof activeTabId === 'string' ? activeTabId : ''
  };
}

function reorderAttachedInstanceTabs(tabs, orderedIds) {
  if (!(tabs instanceof Map) || !Array.isArray(orderedIds)) return null;
  const attachedIds = Array.from(tabs, ([id, tab]) => tab?.detached === true ? null : id).filter(Boolean);
  if (
    orderedIds.length !== attachedIds.length ||
    new Set(orderedIds).size !== orderedIds.length ||
    orderedIds.some((id) => typeof id !== 'string' || !attachedIds.includes(id))
  ) {
    return null;
  }
  if (orderedIds.every((id, index) => id === attachedIds[index])) return tabs;

  let index = 0;
  const reordered = new Map();
  for (const [id, tab] of tabs) {
    if (tab?.detached === true) {
      reordered.set(id, tab);
      continue;
    }
    const nextId = orderedIds[index++];
    reordered.set(nextId, tabs.get(nextId));
  }
  return reordered;
}

function findInstanceTabByWebContents(tabs, webContents) {
  const source = tabs instanceof Map ? tabs.values() : [];
  for (const tab of source) {
    if (tab?.view?.webContents === webContents || tab?.detachedWindow?.webContents === webContents) {
      return tab;
    }
  }
  return null;
}

function instanceContextMenuActions(params) {
  const safeParams = params && typeof params === 'object' ? params : {};
  const editFlags = safeParams.editFlags && typeof safeParams.editFlags === 'object' ? safeParams.editFlags : {};
  const hasSelection = typeof safeParams.selectionText === 'string' && safeParams.selectionText.length > 0;
  const actions = [];

  if (editFlags.canUndo) actions.push('undo');
  if (editFlags.canRedo) actions.push('redo');
  if (actions.length && (editFlags.canCut || editFlags.canCopy || hasSelection || editFlags.canPaste || editFlags.canDelete)) {
    actions.push('separator');
  }
  if (editFlags.canCut) actions.push('cut');
  if (editFlags.canCopy || hasSelection) actions.push('copy');
  if (editFlags.canPaste) actions.push('paste');
  if (editFlags.canDelete) actions.push('delete');
  if (editFlags.canSelectAll && (safeParams.isEditable || hasSelection)) {
    if (actions.length) actions.push('separator');
    actions.push('selectAll');
  }

  return actions;
}

function reloadInstanceWebContents(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  webContents.reloadIgnoringCache();
  return true;
}

function isInstanceTabReloadShortcut(input) {
  return input?.type === 'keyDown' && input.key === 'F5';
}

function instanceTabShortcutTarget(input, tabs, activeTabId, platform = process.platform) {
  if (input?.type !== 'keyDown' || input.alt) return null;
  const cycle = input.key === 'Tab' && input.control && !input.meta;
  const numberModifier = platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta;
  const digit = input.code?.match(/^Digit([1-9])$/)?.[1] || input.key;
  const numbered = numberModifier && !input.shift && /^[1-9]$/.test(digit);
  if (!cycle && !numbered) return null;

  const ids = ['', ...Array.from(tabs.values()).filter((tab) => !tab.detached).map((tab) => tab.id)];
  if (ids.length === 1) return null;
  if (cycle) {
    const index = Math.max(0, ids.indexOf(activeTabId));
    return ids[(index + (input.shift ? -1 : 1) + ids.length) % ids.length];
  }
  return ids[Number(digit) - 1] ?? null;
}

function embeddedInstanceContentBounds(bounds, viewport, zoomFactor) {
  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  // DOM coordinates are CSS pixels; native view bounds use device-independent pixels.
  const x = Math.min(width, Math.max(0, Math.round(viewport.x * zoomFactor)));
  const y = Math.min(height, Math.max(0, Math.round(viewport.y * zoomFactor)));
  return { x, y, width: width - x, height: height - y };
}

function detachedInstanceContentBounds(bounds, visible = true) {
  if (!visible) return { x: 0, y: 0, width: 0, height: 0 };
  const width = Math.max(0, Math.floor(Number(bounds?.width) || 0));
  const height = Math.max(0, Math.floor(Number(bounds?.height) || 0));
  const headerHeight = Math.min(47, height);
  return { x: 0, y: headerHeight, width, height: height - headerHeight };
}

module.exports = {
  normalizeInstanceColor,
  normalizeInstanceIcon,
  normalizeInstanceFavicon,
  loadInstanceFavicon,
  normalizeHttpUrl,
  instanceUiSectionUrl,
  instanceUiSectionScript,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  isAllowedInstanceTabNavigationUrl,
  makeTabKey,
  webUiLoginRequestForTarget,
  loginCredentialsFromRequest,
  instanceLoginRedirectSucceeded,
  credentialSavePromptDecision,
  instanceTabLoginRecoveryTarget,
  cliCredentialsAllowedForTarget,
  makeTabsSnapshot,
  reorderAttachedInstanceTabs,
  findInstanceTabByWebContents,
  instanceContextMenuActions,
  reloadInstanceWebContents,
  isInstanceTabReloadShortcut,
  instanceTabShortcutTarget,
  embeddedInstanceContentBounds,
  detachedInstanceContentBounds
};
