const { app, BrowserWindow, WebContentsView, net, ipcMain, shell, Tray, Menu, nativeImage, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const childProcess = require('node:child_process');
const dockerManager = require('./docker_manager');
const {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  makeTabKey,
  makeTabsSnapshot
} = require('./instance_tabs');

// Handle Squirrel.Windows startup events
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Constants
const DEFAULT_GITHUB_REPO = 'agent0ai/a0-launcher';
const BUILD_INFO_FILE = path.join(__dirname, 'build-info.json');
const GITHUB_REPO_ENV_VAR = 'A0_LAUNCHER_GITHUB_REPO';
const LOCAL_REPO_ENV_VAR = 'A0_LAUNCHER_LOCAL_REPO';
const USE_LOCAL_CONTENT_ENV_VAR = 'A0_LAUNCHER_USE_LOCAL_CONTENT';

function isTruthyEnv(value) {
  const v = (value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizeGithubRepo(value) {
  const v = (value || '').trim();
  if (!v) return '';
  const cleaned = v.endsWith('.git') ? v.slice(0, -4) : v;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) return cleaned;

  // HTTPS GitHub URL (with optional credentials and optional .git suffix)
  const httpsMatch = cleaned.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];

  // SSH GitHub URL (git@github.com:owner/repo.git)
  const sshMatch = cleaned.match(/github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];

  return '';
}

function getGithubRepo() {
  const fromEnv = normalizeGithubRepo(process.env[GITHUB_REPO_ENV_VAR]);
  if (fromEnv) return fromEnv;

  try {
    const raw = fsSync.readFileSync(BUILD_INFO_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const fromFile = normalizeGithubRepo(parsed?.githubRepo);
    if (fromFile) return fromFile;
  } catch {
    // ignore
  }

  return DEFAULT_GITHUB_REPO;
}

function defaultAppRepoArg(argv = process.argv) {
  if (!process.defaultApp) return '';
  for (const rawArg of Array.isArray(argv) ? argv.slice(1) : []) {
    const arg = String(rawArg || '').trim();
    if (!arg || arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

function isLocalRepoContentDir(dir) {
  try {
    const appIndex = path.join(dir, 'app', 'index.html');
    const pkg = path.join(dir, 'package.json');
    return fsSync.existsSync(appIndex) && fsSync.existsSync(pkg);
  } catch {
    return false;
  }
}

function resolveLocalRepoDir() {
  const rawPath = (process.env[LOCAL_REPO_ENV_VAR] || '').trim();
  const useLocalFromCwd = isTruthyEnv(process.env[USE_LOCAL_CONTENT_ENV_VAR]);
  const defaultAppPath = defaultAppRepoArg();
  const useCwdFallback = useLocalFromCwd || process.defaultApp || !app.isPackaged;

  const candidates = [];
  if (rawPath) candidates.push(path.resolve(process.cwd(), rawPath));
  if (defaultAppPath) candidates.push(path.resolve(process.cwd(), defaultAppPath));
  if (useCwdFallback) candidates.push(process.cwd());

  for (const dir of candidates) {
    if (isLocalRepoContentDir(dir)) {
      return dir;
    }
  }

  return '';
}

const LOCAL_REPO_DIR = resolveLocalRepoDir();
const USING_LOCAL_CONTENT = !!LOCAL_REPO_DIR;
const LOCAL_INDEX_FILE = USING_LOCAL_CONTENT ? path.join(LOCAL_REPO_DIR, 'app', 'index.html') : '';

const GITHUB_REPO = getGithubRepo();
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CONTENT_ASSET_NAME = 'content.json';

if (USING_LOCAL_CONTENT) {
  console.log(`Using local dev content: ${LOCAL_INDEX_FILE}`);
} else {
  console.log(`Using GitHub content repo: ${GITHUB_REPO}`);
}

// Paths
const CONTENT_DIR = path.join(app.getPath('userData'), 'app_content');
const META_FILE = path.join(app.getPath('userData'), 'content_meta.json');

let mainWindow;
let contentInitialized = false;
let tray = null;
let isQuitting = false;
let lastDockerManagerState = null;
let trayMenuUpdateTimer = null;
let instanceTabs = new Map();
let activeInstanceTabId = '';
let instanceTabBounds = null;
let instanceTabSeq = 0;

/**
 * Fetch the latest release info from GitHub
 */
async function fetchLatestRelease() {
  try {
    const response = await net.fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'A0-Launcher'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch latest release:', error);
    return null;
  }
}

/**
 * Read local content metadata
 */
async function readLocalMeta() {
  try {
    const data = await fs.readFile(META_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No local meta file found, will download content');
    } else {
      console.error('Error reading meta file:', error);
    }
    return null;
  }
}

/**
 * Write local content metadata
 */
async function writeLocalMeta(data) {
  await fs.writeFile(META_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseTimestamp(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getLocalContentTimestamp(localMeta) {
  if (localMeta?.version === 'dev-local') {
    console.log('Ignoring legacy dev-local content metadata for release updates');
    return 0;
  }

  return parseTimestamp(localMeta?.published_at);
}

function getRemoteContentTimestamp(latestRelease, contentAsset) {
  return Math.max(
    parseTimestamp(latestRelease?.published_at),
    parseTimestamp(contentAsset?.updated_at)
  );
}

function resolveContentBundlePath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
    throw new Error(`Invalid bundled content path: ${filePath}`);
  }

  if (path.isAbsolute(filePath) || path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Unsafe bundled content path: ${filePath}`);
  }

  const contentRoot = path.resolve(CONTENT_DIR);
  const fullPath = path.resolve(contentRoot, filePath);
  if (fullPath === contentRoot || !fullPath.startsWith(contentRoot + path.sep)) {
    throw new Error(`Unsafe bundled content path: ${filePath}`);
  }

  return fullPath;
}

function decodeContentBundleEntry(filePath, entry) {
  if (typeof entry === 'string') {
    return { data: entry, options: 'utf8' };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Invalid bundled content entry: ${filePath}`);
  }

  const { encoding, data } = entry;
  if (typeof data !== 'string') {
    throw new Error(`Invalid bundled content data: ${filePath}`);
  }

  if (encoding === 'utf8') {
    return { data, options: 'utf8' };
  }

  if (encoding === 'base64') {
    return { data: Buffer.from(data, 'base64') };
  }

  throw new Error(`Unsupported bundled content encoding "${encoding}" for ${filePath}`);
}

function assertValidContentBundle(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') {
    throw new Error('Invalid content bundle');
  }

  if (!contentJson.files || typeof contentJson.files !== 'object' || Array.isArray(contentJson.files)) {
    throw new Error('Invalid content bundle files');
  }
}

/**
 * Download and extract content from the release asset
 */
async function downloadContent(downloadUrl) {
  sendStatus('Downloading latest content...');

  const response = await net.fetch(downloadUrl, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentJson = await response.json();
  assertValidContentBundle(contentJson);

  // Clear existing content directory
  await fs.rm(CONTENT_DIR, { recursive: true, force: true });
  await fs.mkdir(CONTENT_DIR, { recursive: true });

  // Write each file from the JSON bundle
  sendStatus('Extracting content...');

  for (const [filePath, entry] of Object.entries(contentJson.files)) {
    const fullPath = resolveContentBundlePath(filePath);
    const dir = path.dirname(fullPath);
    const { data, options } = decodeContentBundleEntry(filePath, entry);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, data, options);
  }

  console.log(`Extracted ${Object.keys(contentJson.files).length} files`);
}

/**
 * Send status update to renderer
 */
function sendStatus(message) {
  console.log('Status:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', message);
  }
}

/**
 * Send error to renderer
 */
function sendError(message) {
  console.error('Error:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', message);
  }
}

/**
 * Initialize app content - check for updates and download if needed
 */
async function initializeAppContent() {
  if (USING_LOCAL_CONTENT) {
    sendStatus('Using local dev content');
    return true;
  }

  sendStatus('Checking for updates...');

  const latestRelease = await fetchLatestRelease();

  if (!latestRelease) {
    // Offline or API error - try to use existing content
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      sendError('Unable to fetch updates and no local content available. Please check your internet connection.');
      return false;
    }
    sendStatus('Using cached content (offline mode)');
    return true;
  }

  const contentAsset = latestRelease.assets?.find(
    asset => asset.name === CONTENT_ASSET_NAME
  );

  if (!contentAsset) {
    console.error(`No ${CONTENT_ASSET_NAME} asset found in release`);
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      sendError('Release does not contain required content bundle.');
      return false;
    }
    return true;
  }

  const localMeta = await readLocalMeta();
  const remoteTimestamp = getRemoteContentTimestamp(latestRelease, contentAsset);
  const localTimestamp = getLocalContentTimestamp(localMeta);

  if (remoteTimestamp > localTimestamp) {
    const remotePublishedAt = new Date(remoteTimestamp).toISOString();
    console.log(`Update available: ${latestRelease.tag_name} (${remotePublishedAt})`);

    try {
      await downloadContent(contentAsset.browser_download_url);

      // Save metadata
      await writeLocalMeta({
        version: latestRelease.tag_name,
        published_at: remotePublishedAt,
        release_published_at: latestRelease.published_at,
        asset_updated_at: contentAsset.updated_at,
        downloaded_at: new Date().toISOString()
      });

      sendStatus('Update complete!');
    } catch (error) {
      console.error('Download failed:', error);
      const hasContent = await checkExistingContent();
      if (!hasContent) {
        sendError(`Download failed: ${error.message}`);
        return false;
      }
      sendStatus('Using cached content (download failed)');
    }
  } else {
    console.log('Content is up to date');
    sendStatus('Content is up to date');
  }

  return true;
}

/**
 * Check if existing content is available
 */
async function checkExistingContent() {
  try {
    const indexPath = USING_LOCAL_CONTENT ? LOCAL_INDEX_FILE : path.join(CONTENT_DIR, 'index.html');
    if (!indexPath) return false;
    await fs.access(indexPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the app content into the window.
 * Uses the a0app:// custom protocol so that fetch(), URL resolution, and
 * ES module imports inside the content work exactly like a real web server.
 */
async function loadAppContent() {
  const indexPath = USING_LOCAL_CONTENT ? LOCAL_INDEX_FILE : path.join(CONTENT_DIR, 'index.html');

  try {
    await fs.access(indexPath);
    mainWindow.loadURL('a0app://content/index.html');
  } catch {
    // Fallback: show error in loading page
    if (USING_LOCAL_CONTENT) {
      sendError(`Local content not found at ${indexPath}`);
    } else {
      sendError('No content available. Please ensure a release exists with content.json.');
    }
  }
}

/**
 * Create the main browser window
 */
function createWindow() {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'A0 Launcher',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Load loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  // With a tray present, closing the window hides it on desktop tray platforms.
  // On macOS, allow the window to close so the app can quit cleanly and avoid
  // idle Electron helper processes.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    if (!tray || process.platform === 'darwin') return;
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    cleanupInstanceTabs();
    mainWindow = null;
    if (tray) scheduleTrayMenuUpdate();
  });

  const updateTrayForWindow = () => {
    if (tray) scheduleTrayMenuUpdate();
  };
  mainWindow.on('show', updateTrayForWindow);
  mainWindow.on('hide', updateTrayForWindow);
  mainWindow.on('minimize', updateTrayForWindow);
  mainWindow.on('restore', updateTrayForWindow);
}

function isWindowShown() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (!mainWindow.isVisible()) return false;
    if (typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized()) return false;
    return true;
  } catch {
    return false;
  }
}

function toggleWindow() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isWindowShown()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      if (typeof mainWindow.isMinimized === 'function' && mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  } catch {
    // ignore
  } finally {
    if (tray) scheduleTrayMenuUpdate();
  }
}

function activeRunningFromState(state) {
  const versions = Array.isArray(state?.versions) ? state.versions : [];
  const active = versions.find((v) => v && v.isActive) || null;
  if (!active) return { hasActive: false, isRunning: false };
  const s = typeof active.activeState === 'string' ? active.activeState : '';
  const running = !s || String(s).toLowerCase() === 'running';
  return { hasActive: true, isRunning: running };
}

function updateTrayMenu() {
  if (!tray) return;

  const { hasActive, isRunning } = activeRunningFromState(lastDockerManagerState);
  const op = typeof dockerManager.getCurrentOperation === 'function' ? dockerManager.getCurrentOperation() : null;
  const opRunning = !!op && typeof op === 'object' && op.status === 'running';

  const canStart = !!hasActive && !opRunning && !isRunning;
  const canStop = !!hasActive && !opRunning && isRunning;

  const showLabel = isWindowShown() ? 'Hide' : 'Show';
  const menu = Menu.buildFromTemplate([
    { label: showLabel, click: toggleWindow },
    { type: 'separator' },
    {
      label: 'Start',
      enabled: canStart,
      click: async () => {
        try {
          sendStatus('Starting Agent Zero...');
          await dockerManager.startActiveInstance();
        } catch (error) {
          sendError(error && error.message ? error.message : 'Failed to start Agent Zero');
        }
      }
    },
    {
      label: 'Stop',
      enabled: canStop,
      click: async () => {
        try {
          sendStatus('Stopping Agent Zero...');
          await dockerManager.stopActiveInstance();
        } catch (error) {
          sendError(error && error.message ? error.message : 'Failed to stop Agent Zero');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function scheduleTrayMenuUpdate() {
  if (!tray) return;
  if (trayMenuUpdateTimer) return;
  trayMenuUpdateTimer = setTimeout(() => {
    trayMenuUpdateTimer = null;
    updateTrayMenu();
  }, 150);
}

function createTray() {
  if (tray) return tray;

  try {
    const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image && !image.isEmpty() && process.platform !== 'darwin') {
      image = image.resize({ width: 16, height: 16 });
    }
    tray = new Tray(image);
    tray.setToolTip('Agent Zero');
    updateTrayMenu();
    tray.on('double-click', toggleWindow);
  } catch (error) {
    console.error('[tray] Failed to create system tray', error && error.message ? error.message : String(error));
    tray = null;
  }

  return tray;
}

// IPC Handlers
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-content-version', async () => {
  if (USING_LOCAL_CONTENT) return 'dev-local';

  try {
    const meta = await readLocalMeta();
    return meta?.version || 'unknown';
  } catch {
    return 'unknown';
  }
});

ipcMain.handle('get-shell-icon-data-url', () => {
  try {
    const iconPath = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
    const image = nativeImage.createFromPath(iconPath);
    if (!image || image.isEmpty()) return '';
    return image.resize({ width: 32, height: 32 }).toDataURL();
  } catch {
    return '';
  }
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAllowedLocalUrl(value) {
  return isAllowedLocalInstanceUrl(value);
}

function isAllowedHttpUrl(value) {
  return isAllowedRemoteInstanceUrl(value);
}

function openAgentZeroUiWindow(url, title = 'Agent Zero') {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );
  const uiWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  uiWindow.loadURL(url);
  return uiWindow;
}

function getInstanceTabsSnapshot() {
  return makeTabsSnapshot(instanceTabs, activeInstanceTabId);
}

function sendInstanceTabsEvent() {
  sendDockerManagerEvent('docker-manager:instanceTabs', getInstanceTabsSnapshot());
}

function nextInstanceTabId() {
  instanceTabSeq += 1;
  return `instance-tab-${instanceTabSeq}`;
}

function createInstanceWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true
  };
}

function sanitizeInstanceTabBounds(body) {
  const source = isPlainObject(body?.bounds) ? body.bounds : body;
  if (!isPlainObject(source)) return null;

  const readInt = (key) => {
    const value = Number(source[key]);
    if (!Number.isFinite(value)) return null;
    return Math.floor(value);
  };

  const x = readInt('x');
  const y = readInt('y');
  const width = readInt('width');
  const height = readInt('height');

  if (x === null || y === null || width === null || height === null) return null;
  if (x < 0 || y < 0 || width < 80 || height < 80) return null;
  return { x, y, width, height };
}

function hideInstanceTabView(tab) {
  try {
    tab?.view?.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch {
    // ignore
  }
}

function applyActiveInstanceTabBounds() {
  for (const tab of instanceTabs.values()) {
    if (tab.id !== activeInstanceTabId || !instanceTabBounds) {
      hideInstanceTabView(tab);
      continue;
    }
    try {
      tab.view.setBounds(instanceTabBounds);
    } catch {
      hideInstanceTabView(tab);
    }
  }
}

function destroyInstanceTab(tab) {
  if (!tab) return;

  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView && typeof mainWindow.contentView.removeChildView === 'function') {
      mainWindow.contentView.removeChildView(tab.view);
    }
  } catch {
    // ignore
  }

  try {
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.close();
  } catch {
    // ignore
  }
}

function cleanupInstanceTabs() {
  for (const tab of instanceTabs.values()) {
    destroyInstanceTab(tab);
  }
  instanceTabs = new Map();
  activeInstanceTabId = '';
  instanceTabBounds = null;
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

function isNavigationAllowedForTab(tab, url) {
  if (!tab || typeof url !== 'string') return false;
  const normalized = normalizeHttpUrl(url);
  if (!normalized) return false;
  const validator = tab.kind === 'remote' ? isAllowedRemoteInstanceUrl : isAllowedLocalInstanceUrl;
  return validator(normalized) && urlsShareOrigin(tab.url, normalized);
}

async function openExternalIfSafe(url) {
  const normalized = normalizeHttpUrl(url);
  if (!normalized || !isAllowedRemoteInstanceUrl(normalized) || isAllowedLocalInstanceUrl(normalized)) {
    return { opened: false };
  }
  await shell.openExternal(normalized);
  return { opened: true };
}

function createTabTargetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function resolveInstanceUiTarget(body) {
  const request = isPlainObject(body) ? body : {};
  const kind = typeof request.kind === 'string' && request.kind.trim() ? request.kind.trim() : 'local';

  if (kind === 'remote') {
    const instanceId = typeof request.instanceId === 'string' && request.instanceId.trim()
      ? request.instanceId.trim()
      : typeof request.id === 'string'
        ? request.id.trim()
        : '';
    const remote = await dockerManager.getRemoteInstance(instanceId);
    const url = normalizeHttpUrl(remote?.url);
    if (!url || !isAllowedRemoteInstanceUrl(url)) {
      throw createTabTargetError('INVALID_REMOTE_INSTANCE', 'Invalid remote instance');
    }
    const title = typeof remote?.name === 'string' && remote.name.trim() ? remote.name.trim() : 'Agent Zero';
    const target = {
      kind: 'remote',
      instanceId: typeof remote?.id === 'string' && remote.id ? remote.id : instanceId,
      containerId: '',
      title,
      url
    };
    target.key = makeTabKey(target);
    return target;
  }

  if (kind !== 'local') {
    throw createTabTargetError('INVALID_INPUT', 'Invalid request');
  }

  const containerId = typeof request.containerId === 'string' ? request.containerId.trim() : '';
  if (containerId) {
    const url = normalizeHttpUrl(await dockerManager.getContainerUiUrl(containerId));
    if (!url || !isAllowedLocalInstanceUrl(url)) {
      throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero UI is not reachable for this instance yet.');
    }
    const target = {
      kind: 'local',
      instanceId: '',
      containerId,
      title: 'Agent Zero',
      url
    };
    target.key = makeTabKey(target);
    return target;
  }

  const state = await dockerManager.refreshDockerManager({ forceRefresh: false });
  const url = normalizeHttpUrl(state?.uiUrl);
  if (!url) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero UI is not available. Start a version first.');
  }
  if (!isAllowedLocalInstanceUrl(url)) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Agent Zero UI URL is not available.');
  }

  const target = {
    kind: 'local',
    instanceId: '',
    containerId: '',
    title: 'Agent Zero',
    url
  };
  target.key = makeTabKey(target);
  return target;
}

function findInstanceTabByKey(key) {
  for (const tab of instanceTabs.values()) {
    if (tab.key === key) return tab;
  }
  return null;
}

function setActiveInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  if (!tabId || !instanceTabs.has(tabId)) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }
  activeInstanceTabId = tabId;
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function getInstanceTabIdFromRequest(body) {
  if (!isPlainObject(body)) return '';
  if (typeof body.tabId === 'string') return body.tabId;
  if (typeof body.id === 'string') return body.id;
  return '';
}

function attachInstanceTabEvents(tab) {
  const wc = tab.view.webContents;

  const update = () => {
    if (instanceTabs.has(tab.id)) sendInstanceTabsEvent();
  };

  const blockNavigation = (event, url) => {
    if (isNavigationAllowedForTab(tab, url)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    void openExternalIfSafe(url);
  };

  wc.setWindowOpenHandler(({ url }) => {
    if (!isNavigationAllowedForTab(tab, url)) {
      void openExternalIfSafe(url);
    }
    return { action: 'deny' };
  });

  wc.on('will-navigate', blockNavigation);
  wc.on('will-redirect', blockNavigation);
  wc.on('did-start-loading', () => {
    tab.loading = true;
    update();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    tab.canReload = true;
    update();
  });
  wc.on('did-fail-load', () => {
    tab.loading = false;
    tab.canReload = true;
    update();
  });
  wc.on('page-title-updated', (_event, title) => {
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (cleanTitle) {
      tab.title = cleanTitle;
      update();
    }
  });
  wc.on('did-navigate', (_event, url) => {
    const normalized = normalizeHttpUrl(url);
    if (normalized && isNavigationAllowedForTab(tab, normalized)) {
      tab.url = normalized;
      update();
    }
  });
  wc.on('did-navigate-in-page', (_event, url) => {
    const normalized = normalizeHttpUrl(url);
    if (normalized && isNavigationAllowedForTab(tab, normalized)) {
      tab.url = normalized;
      update();
    }
  });
  wc.once('destroyed', () => {
    if (!instanceTabs.has(tab.id)) return;
    instanceTabs.delete(tab.id);
    if (activeInstanceTabId === tab.id) {
      activeInstanceTabId = instanceTabs.keys().next().value || '';
    }
    applyActiveInstanceTabBounds();
    sendInstanceTabsEvent();
  });
}

async function openInstanceTab(target) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw createTabTargetError('UI_UNAVAILABLE', 'Launcher window is not available.');
  }

  const existing = findInstanceTabByKey(target.key);
  if (existing) {
    const nextUrl = normalizeHttpUrl(target.url);
    if (nextUrl && nextUrl !== normalizeHttpUrl(existing.url)) {
      existing.url = nextUrl;
      existing.title = target.title || existing.title;
      existing.containerId = target.containerId || existing.containerId || '';
      existing.instanceId = target.instanceId || existing.instanceId || '';
      existing.loading = true;
      sendInstanceTabsEvent();
      await existing.view?.webContents?.loadURL(nextUrl);
    }
    setActiveInstanceTab(existing.id);
    return { opened: true, tabId: existing.id, focusedExisting: true };
  }

  if (!mainWindow.contentView || typeof mainWindow.contentView.addChildView !== 'function') {
    openAgentZeroUiWindow(target.url, target.title);
    return { opened: true, detached: true };
  }

  const previousActiveTabId = activeInstanceTabId;
  const view = new WebContentsView({ webPreferences: createInstanceWebPreferences() });
  const tab = {
    id: nextInstanceTabId(),
    key: target.key,
    kind: target.kind,
    title: target.title,
    url: target.url,
    containerId: target.containerId || '',
    instanceId: target.instanceId || '',
    loading: true,
    canReload: true,
    view
  };

  instanceTabs.set(tab.id, tab);
  mainWindow.contentView.addChildView(view);
  attachInstanceTabEvents(tab);
  activeInstanceTabId = tab.id;
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();

  try {
    await view.webContents.loadURL(target.url);
  } catch (error) {
    instanceTabs.delete(tab.id);
    destroyInstanceTab(tab);
    if (activeInstanceTabId === tab.id) {
      activeInstanceTabId = instanceTabs.has(previousActiveTabId)
        ? previousActiveTabId
        : instanceTabs.keys().next().value || '';
    }
    applyActiveInstanceTabBounds();
    sendInstanceTabsEvent();
    throw error;
  }

  return { opened: true, tabId: tab.id, focusedExisting: false };
}

function closeInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }

  instanceTabs.delete(tabId);
  destroyInstanceTab(tab);
  if (activeInstanceTabId === tabId) {
    activeInstanceTabId = instanceTabs.keys().next().value || '';
  }
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return getInstanceTabsSnapshot();
}

function reloadInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }
  const wc = tab.view?.webContents;
  if (wc && !wc.isDestroyed()) wc.reload();
  return { reloaded: true, tabId };
}

function detachInstanceTab(id) {
  const tabId = typeof id === 'string' ? id : '';
  const tab = tabId ? instanceTabs.get(tabId) : null;
  if (!tab) {
    throw createTabTargetError('INSTANCE_NOT_FOUND', 'Instance tab not found.');
  }

  openAgentZeroUiWindow(tab.url, tab.title);
  instanceTabs.delete(tabId);
  destroyInstanceTab(tab);
  if (activeInstanceTabId === tabId) {
    activeInstanceTabId = instanceTabs.keys().next().value || '';
  }
  applyActiveInstanceTabBounds();
  sendInstanceTabsEvent();
  return { detached: true, tabId };
}

function shellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function powerShellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `''`)}'`;
}

function powerShellArrayLiteral(values) {
  return `@(${values.map((value) => powerShellSingleQuote(value)).join(', ')})`;
}

function appleScriptString(value) {
  return JSON.stringify(String(value || ''));
}

function existingFilePath(filePath) {
  const candidate = String(filePath || '').trim();
  if (!candidate) return '';
  try {
    return fsSync.existsSync(candidate) ? candidate : '';
  } catch {
    return '';
  }
}

function firstPathLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function findCommandOnPath(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';

  if (process.platform === 'win32') {
    try {
      const found = childProcess.spawnSync('where.exe', [cmd], {
        encoding: 'utf8',
        windowsHide: true
      });
      if (found.status === 0) return firstPathLine(found.stdout);
    } catch {
      // ignore
    }
    return '';
  }

  try {
    const found = childProcess.spawnSync('sh', ['-lc', `command -v ${shellSingleQuote(cmd)}`], {
      encoding: 'utf8'
    });
    if (found.status === 0) return firstPathLine(found.stdout);
  } catch {
    // ignore
  }
  return '';
}

function findA0CliBinary() {
  const override = existingFilePath(process.env.A0_CLI_PATH);
  if (override) return override;

  const repoRoot = path.resolve(__dirname, '..');
  const siblingConnector = path.resolve(repoRoot, '..', 'a0-connector');
  const candidates = process.platform === 'win32'
    ? [
        path.join(siblingConnector, '.venv', 'Scripts', 'a0.exe'),
        path.join(os.homedir(), '.local', 'bin', 'a0.exe')
      ]
    : [
        path.join(siblingConnector, '.venv', 'bin', 'a0'),
        '/home/eclypso/a0/a0-connector/.venv/bin/a0',
        '/opt/homebrew/bin/a0',
        '/usr/local/bin/a0',
        '/usr/bin/a0'
      ];

  for (const candidate of candidates) {
    const existing = existingFilePath(candidate);
    if (existing) return existing;
  }

  const pathCommand = findCommandOnPath('a0');
  if (pathCommand) return pathCommand;

  const err = new Error('A0 CLI was not found. Install a0-connector or add the a0 command to PATH.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function findDockerCliBinary() {
  const binary = process.platform === 'win32' ? 'docker.exe' : 'docker';
  const overrides = [
    existingFilePath(process.env.A0_DOCKER_CLI_PATH),
    existingFilePath(process.env.DOCKER_CLI_PATH)
  ].filter(Boolean);
  if (overrides.length) return overrides[0];

  const pathCommand = findCommandOnPath(binary);
  if (pathCommand) return pathCommand;

  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        path.join(process.env.ProgramW6432 || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Docker', 'resources', 'bin', 'docker.exe'),
        'C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/opt/homebrew/bin/docker',
          '/usr/local/bin/docker',
          '/usr/bin/docker',
          '/Applications/Docker.app/Contents/Resources/bin/docker',
          path.join(home, 'Applications', 'Docker.app', 'Contents', 'Resources', 'bin', 'docker')
        ]
      : [
          '/usr/bin/docker',
          '/usr/local/bin/docker',
          '/snap/bin/docker'
        ];

  for (const candidate of candidates) {
    const existing = existingFilePath(candidate);
    if (existing) return existing;
  }

  const err = new Error('Docker CLI was not found. Finish Docker setup, then try again.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function spawnDetached(command, args, options = {}) {
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    ...options
  });
  child.unref();
  return child;
}

function terminalWrapperDir() {
  const dir = path.join(app.getPath('userData'), 'terminal-wrappers');
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDockerLoginShellWrapper(dockerCli) {
  const scriptPath = path.join(terminalWrapperDir(), 'docker-login.sh');
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    'clear 2>/dev/null || true',
    'echo "Agent Zero Docker Login"',
    'echo',
    'echo "Sign in to Docker Hub so Agent Zero image downloads can continue."',
    'echo "When login succeeds, return to Agent Zero and click Retry."',
    'echo',
    `${shellSingleQuote(dockerCli)} login`,
    'code=$?',
    'echo',
    'if [ "$code" -eq 0 ]; then',
    '  echo "Docker login completed."',
    'else',
    '  echo "Docker login exited with code $code."',
    'fi',
    'echo',
    'read -r -p "Press Enter to close this window..." _',
    'exit "$code"',
    ''
  ].join('\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8', mode: 0o700 });
  try {
    fsSync.chmodSync(scriptPath, 0o700);
  } catch {
    // Best-effort on platforms that ignore POSIX modes.
  }
  return scriptPath;
}

function writeDockerLoginPowerShellWrapper(dockerCli) {
  const scriptPath = path.join(terminalWrapperDir(), 'docker-login.ps1');
  const script = [
    'Write-Host "Agent Zero Docker Login"',
    'Write-Host ""',
    'Write-Host "Sign in to Docker Hub so Agent Zero image downloads can continue."',
    'Write-Host "When login succeeds, return to Agent Zero and click Retry."',
    'Write-Host ""',
    `& ${powerShellSingleQuote(dockerCli)} login`,
    '$code = $LASTEXITCODE',
    'Write-Host ""',
    'if ($code -eq 0) {',
    '  Write-Host "Docker login completed."',
    '} else {',
    '  Write-Host "Docker login exited with code $code."',
    '}',
    'Write-Host ""',
    'Read-Host "Press Enter to close this window"',
    'exit $code',
    ''
  ].join('\r\n');
  fsSync.writeFileSync(scriptPath, script, { encoding: 'utf8' });
  return scriptPath;
}

function openA0CliTerminalWindows(host, cli) {
  const command = [
    `$env:AGENT_ZERO_HOST = ${powerShellSingleQuote(host)}`,
    `& ${powerShellSingleQuote(cli)} --host ${powerShellSingleQuote(host)} --no-docker-discovery --connect`,
    'if ($LASTEXITCODE) { Write-Host ""; Write-Host "A0 CLI exited with code $LASTEXITCODE" }'
  ].join('; ');
  const psArgs = ['-NoLogo', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command];
  const env = { ...process.env, AGENT_ZERO_HOST: host };

  if (findCommandOnPath('wt.exe')) {
    try {
      spawnDetached('wt.exe', ['new-tab', '--title', 'A0 CLI', 'powershell.exe', ...psArgs], { env });
      return { opened: true, command: 'wt.exe' };
    } catch {
      // Fall through to PowerShell's own console window.
    }
  }

  const launcherScript = [
    `$argumentList = ${powerShellArrayLiteral(psArgs)}`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WindowStyle Normal"
  ].join('; ');
  const launched = childProcess.spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    launcherScript
  ], {
    encoding: 'utf8',
    env,
    windowsHide: true
  });
  if (launched.error || launched.status !== 0) {
    const detail = launched.error?.message || launched.stderr?.trim() || `PowerShell exited with code ${launched.status}`;
    const err = new Error(`Could not open the A0 CLI terminal. ${detail}`);
    err.code = 'TERMINAL_UNAVAILABLE';
    throw err;
  }
  return { opened: true, command: 'powershell.exe' };
}

function openA0CliTerminalMac(host, cli) {
  const shellPath = process.env.SHELL || '/bin/zsh';
  const command = [
    `export AGENT_ZERO_HOST=${shellSingleQuote(host)}`,
    `${shellSingleQuote(cli)} --host ${shellSingleQuote(host)} --no-docker-discovery --connect`,
    `exec ${shellSingleQuote(shellPath)} -l`
  ].join('; ');

  spawnDetached('osascript', [
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate'
  ], {
    env: { ...process.env, AGENT_ZERO_HOST: host }
  });
  return { opened: true, command: 'Terminal.app' };
}

function openA0CliTerminalLinux(host, cli) {
  const command = `AGENT_ZERO_HOST=${shellSingleQuote(host)} ${shellSingleQuote(cli)} --host ${shellSingleQuote(host)} --no-docker-discovery --connect; exec bash`;
  const candidates = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', command]],
    ['gnome-terminal', ['--', 'bash', '-lc', command]],
    ['konsole', ['-e', 'bash', '-lc', command]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(command)}`]],
    ['xterm', ['-e', 'bash', '-lc', command]]
  ];

  let lastError = null;
  for (const [cmd, args] of candidates) {
    try {
      const found = findCommandOnPath(cmd);
      if (!found) continue;
      spawnDetached(cmd, args, {
        env: { ...process.env, AGENT_ZERO_HOST: host }
      });
      return { opened: true, command: cmd };
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message || 'No terminal emulator was found.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function openDockerLoginTerminalWindows(dockerCli) {
  const scriptPath = writeDockerLoginPowerShellWrapper(dockerCli);
  const psArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];

  if (findCommandOnPath('wt.exe')) {
    try {
      spawnDetached('wt.exe', ['new-tab', '--title', 'Docker Login', 'powershell.exe', ...psArgs], { env: process.env });
      return { opened: true, command: 'wt.exe' };
    } catch {
      // Fall through to PowerShell's own console window.
    }
  }

  const launcherScript = [
    `$argumentList = ${powerShellArrayLiteral(psArgs)}`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -WindowStyle Normal"
  ].join('; ');
  const launched = childProcess.spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    launcherScript
  ], {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true
  });
  if (launched.error || launched.status !== 0) {
    const detail = launched.error?.message || launched.stderr?.trim() || `PowerShell exited with code ${launched.status}`;
    const err = new Error(`Could not open the Docker login terminal. ${detail}`);
    err.code = 'TERMINAL_UNAVAILABLE';
    throw err;
  }
  return { opened: true, command: 'powershell.exe' };
}

function openDockerLoginTerminalMac(dockerCli) {
  const scriptPath = writeDockerLoginShellWrapper(dockerCli);
  const command = `bash ${shellSingleQuote(scriptPath)}`;

  spawnDetached('osascript', [
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate'
  ], {
    env: process.env
  });
  return { opened: true, command: 'Terminal.app' };
}

function openDockerLoginTerminalLinux(dockerCli) {
  const scriptPath = writeDockerLoginShellWrapper(dockerCli);
  const command = `bash ${shellSingleQuote(scriptPath)}`;
  const candidates = [
    ['gnome-terminal', ['--', 'bash', '-lc', command]],
    ['x-terminal-emulator', ['-e', 'bash', '-lc', command]],
    ['konsole', ['-e', 'bash', '-lc', command]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(command)}`]],
    ['xterm', ['-e', 'bash', '-lc', command]]
  ];

  let lastError = null;
  for (const [cmd, args] of candidates) {
    try {
      const found = findCommandOnPath(cmd);
      if (!found) continue;
      spawnDetached(cmd, args, { env: process.env });
      return { opened: true, command: cmd };
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message || 'No terminal emulator was found.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function openDockerLoginTerminal() {
  const dockerCli = findDockerCliBinary();
  if (process.platform === 'win32') return openDockerLoginTerminalWindows(dockerCli);
  if (process.platform === 'darwin') return openDockerLoginTerminalMac(dockerCli);
  if (process.platform === 'linux') return openDockerLoginTerminalLinux(dockerCli);

  const err = new Error('Opening the Docker login terminal is not available on this system.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function openA0CliTerminal(host) {
  const h = String(host || '').trim();
  if (!isAllowedLocalUrl(h)) {
    const err = new Error('Start an instance before opening the A0 CLI terminal.');
    err.code = 'UI_UNAVAILABLE';
    throw err;
  }

  const cli = findA0CliBinary();
  if (process.platform === 'win32') return openA0CliTerminalWindows(h, cli);
  if (process.platform === 'darwin') return openA0CliTerminalMac(h, cli);
  if (process.platform === 'linux') return openA0CliTerminalLinux(h, cli);

  const err = new Error('Opening the A0 CLI terminal is not available on this system.');
  err.code = 'TERMINAL_UNAVAILABLE';
  throw err;
}

function getDockerDesktopInstallerConfig() {
  if (process.platform === 'win32') {
    return {
      url: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
      fileName: 'Docker-Desktop-Installer.exe'
    };
  }
  if (process.platform === 'darwin') {
    const isArm = process.arch === 'arm64';
    return {
      url: isArm
        ? 'https://desktop.docker.com/mac/main/arm64/Docker.dmg'
        : 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
      fileName: 'Docker.dmg'
    };
  }
  return null;
}

async function installDockerDesktop() {
  const cfg = getDockerDesktopInstallerConfig();
  if (!cfg) {
    await shell.openExternal('https://docs.docker.com/engine/install/');
    return { started: true, openedDocs: true };
  }

  const response = await net.fetch(cfg.url, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });
  if (!response.ok) {
    throw new Error(`Docker download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const targetPath = path.join(app.getPath('downloads'), cfg.fileName);
  await fs.writeFile(targetPath, buffer);

  if (process.platform === 'darwin') {
    await shell.openPath(targetPath);
    return { started: true, installerPath: targetPath, installerType: 'dmg' };
  }

  const opened = await shell.openPath(targetPath);
  if (opened) {
    throw new Error(`Failed to open Docker installer: ${opened}`);
  }
  return { started: true, installerPath: targetPath, installerType: 'exe' };
}

function sanitizeDockerManagerState(state) {
  const versionsIn = Array.isArray(state?.versions) ? state.versions : [];
  const retainedIn = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
  const remoteIn = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  const policyIn = isPlainObject(state?.retentionPolicy) ? state.retentionPolicy : {};
  const portsIn = isPlainObject(state?.portPreferences) ? state.portPreferences : {};

  const allowedCategory = new Set(['official_release', 'local_build']);
  const allowedAvailability = new Set(['available', 'installed', 'update_available', 'installing', 'error']);
  const allowedInstallability = new Set(['unknown', 'installable', 'not_yet_available']);

  const versions = [];
  for (const v of versionsIn) {
    if (!isPlainObject(v)) continue;
    const id = typeof v.id === 'string' ? v.id : '';
    const displayVersion = typeof v.displayVersion === 'string' ? v.displayVersion : '';
    const category = typeof v.category === 'string' ? v.category : '';
    const availability = typeof v.availability === 'string' ? v.availability : '';
    const isActive = typeof v.isActive === 'boolean' ? v.isActive : false;

    if (!id || !displayVersion) continue;
    if (!allowedCategory.has(category)) continue;
    if (!allowedAvailability.has(availability)) continue;

    const out = {
      id,
      displayVersion,
      category,
      availability,
      isActive
    };

    if (Array.isArray(v.channelBadges) && v.channelBadges.every((x) => typeof x === 'string')) {
      out.channelBadges = v.channelBadges;
    }

    if (v.installability === null) {
      out.installability = null;
    } else if (typeof v.installability === 'string' && allowedInstallability.has(v.installability)) {
      out.installability = v.installability;
    }

    if (v.matchHint === null) {
      out.matchHint = null;
    } else if (typeof v.matchHint === 'string') {
      out.matchHint = v.matchHint;
    }

    if (v.digestHint === null) {
      out.digestHint = null;
    } else if (typeof v.digestHint === 'string') {
      out.digestHint = v.digestHint;
    }

    if (typeof v.differsFromPublished === 'boolean') {
      out.differsFromPublished = v.differsFromPublished;
    }

    if (v.activeState === null) {
      out.activeState = null;
    } else if (typeof v.activeState === 'string') {
      out.activeState = v.activeState;
    }

    if (v.publishedAt === null) {
      out.publishedAt = null;
    } else if (typeof v.publishedAt === 'string') {
      out.publishedAt = v.publishedAt;
    }

    if (v.sizeBytes === null) {
      out.sizeBytes = null;
    } else if (Number.isFinite(Number(v.sizeBytes))) {
      out.sizeBytes = Number(v.sizeBytes);
    }

    versions.push(out);
  }

  const retainedInstances = [];
  for (const r of retainedIn) {
    if (!isPlainObject(r)) continue;
    const containerId = typeof r.containerId === 'string' ? r.containerId : '';
    const containerName = typeof r.containerName === 'string' ? r.containerName : '';
    const versionTag = typeof r.versionTag === 'string' ? r.versionTag : '';
    const retainedAt = typeof r.retainedAt === 'string' ? r.retainedAt : '';
    if (!containerId || !containerName || !versionTag || !retainedAt) continue;
    const out = { containerId, containerName, versionTag, retainedAt };
    if (Number.isFinite(Number(r.createdAt))) out.createdAt = Number(r.createdAt);
    if (Number.isFinite(Number(r.sizeBytes))) out.sizeBytes = Number(r.sizeBytes);
    retainedInstances.push(out);
  }

  const keepCount = Number.isFinite(Number(policyIn.keepCount)) ? Number(policyIn.keepCount) : 1;
  const retentionPolicy = { keepCount: Math.max(0, Math.min(20, Math.floor(keepCount))) };

  const remoteInstances = [];
  for (const r of remoteIn) {
    if (!isPlainObject(r)) continue;
    const id = typeof r.id === 'string' ? r.id : '';
    const name = typeof r.name === 'string' ? r.name : '';
    const url = typeof r.url === 'string' ? r.url : '';
    if (!id || !name || !isAllowedHttpUrl(url)) continue;
    const out = { id, name, url };
    if (typeof r.createdAt === 'string') out.createdAt = r.createdAt;
    if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;
    remoteInstances.push(out);
  }

  const outState = {
    versions,
    retainedInstances,
    remoteInstances,
    retentionPolicy
  };

  {
    const normalizePort = (value, fallback) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const p = Math.floor(n);
      if (p <= 0 || p > 65535) return fallback;
      return p;
    };

    const prefs = {
      ui: normalizePort(portsIn.ui, 8880),
      ssh: normalizePort(portsIn.ssh, 55022)
    };
    if (prefs.ui !== prefs.ssh) {
      outState.portPreferences = prefs;
    }
  }

  if (typeof state?.lastSyncedAt === 'string') outState.lastSyncedAt = state.lastSyncedAt;
  if (typeof state?.offline === 'boolean') outState.offline = state.offline;
  if (state?.uiUrl === null) outState.uiUrl = null;
  if (typeof state?.uiUrl === 'string') outState.uiUrl = state.uiUrl;
  if (isPlainObject(state?.storage)) {
    const s = state.storage;
    const normalizeNullableInt = (value) => {
      if (value === null) return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    };

    const storage = {};

    if (s.dockerRootDir === null) {
      storage.dockerRootDir = null;
    } else if (typeof s.dockerRootDir === 'string') {
      storage.dockerRootDir = s.dockerRootDir;
    }

    if ('freeBytes' in s) storage.freeBytes = normalizeNullableInt(s.freeBytes);
    if ('usedBytes' in s) storage.usedBytes = normalizeNullableInt(s.usedBytes);
    if ('estimateAfterUpdateBytes' in s) storage.estimateAfterUpdateBytes = normalizeNullableInt(s.estimateAfterUpdateBytes);

    outState.storage = storage;
  }

  if (isPlainObject(state?.runtime)) {
    const r = state.runtime;
    const allowedRuntimeStates = new Set(['ready', 'engine_stopped', 'needs_relogin', 'needs_group_membership', 'not_provisioned', 'manual_install', 'unsupported']);
    const allowedRuntimeActions = new Set(['', 'install', 'start', 'manual', 'refresh']);
    const runtimeState = typeof r.state === 'string' && allowedRuntimeStates.has(r.state) ? r.state : 'unsupported';
    const runtime = {
      platform: typeof r.platform === 'string' ? r.platform : process.platform,
      state: runtimeState,
      detail: typeof r.detail === 'string' ? r.detail : '',
      canProvision: !!r.canProvision,
      action: typeof r.action === 'string' && allowedRuntimeActions.has(r.action) ? r.action : ''
    };
    if (typeof r.mode === 'string') runtime.mode = r.mode;
    if (typeof r.distro === 'string') runtime.distro = r.distro;
    if (typeof r.requiresAdmin === 'boolean') runtime.requiresAdmin = r.requiresAdmin;
    if (typeof r.requiresRestart === 'boolean') runtime.requiresRestart = r.requiresRestart;
    if (typeof r.setupActionLabel === 'string') runtime.setupActionLabel = r.setupActionLabel;
    if (typeof r.dockerFlavor === 'string' || r.dockerFlavor === null) runtime.dockerFlavor = r.dockerFlavor;
    if (typeof r.dockerHost === 'string' || r.dockerHost === null) runtime.dockerHost = r.dockerHost;
    if (typeof r.packageManager === 'string') runtime.packageManager = r.packageManager;
    if (Array.isArray(r.manualPackages) && r.manualPackages.every((item) => typeof item === 'string')) {
      runtime.manualPackages = r.manualPackages;
    }
    if (typeof r.manualCommand === 'string') runtime.manualCommand = r.manualCommand;
    if (typeof r.manualUrl === 'string' && /^https?:\/\//i.test(r.manualUrl)) runtime.manualUrl = r.manualUrl;
    outState.runtime = runtime;
  }

  return outState;
}

function sanitizeDockerManagerProgress(progress) {
  if (!isPlainObject(progress)) return null;
  const out = {};
  const hasNumericValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

  if (typeof progress.opId === 'string') out.opId = progress.opId;
  if (typeof progress.type === 'string') out.type = progress.type;
  if (typeof progress.status === 'string') out.status = progress.status;
  if (typeof progress.startedAt === 'string') out.startedAt = progress.startedAt;
  if (typeof progress.finishedAt === 'string') out.finishedAt = progress.finishedAt;
  if (typeof progress.targetTag === 'string') out.targetTag = progress.targetTag;

  if (hasNumericValue(progress.progress)) out.progress = Number(progress.progress);
  if (hasNumericValue(progress.downloadProgress)) out.downloadProgress = Number(progress.downloadProgress);
  if (hasNumericValue(progress.extractProgress)) out.extractProgress = Number(progress.extractProgress);
  if (typeof progress.message === 'string') out.message = progress.message;
  if (typeof progress.headline === 'string') out.headline = progress.headline;
  if (typeof progress.detail === 'string') out.detail = progress.detail;
  if (typeof progress.phase === 'string' || progress.phase === null) out.phase = progress.phase;
  if (typeof progress.indeterminate === 'boolean') out.indeterminate = progress.indeterminate;
  if (Array.isArray(progress.steps)) {
    out.steps = progress.steps
      .filter((step) => isPlainObject(step) && typeof step.label === 'string')
      .map((step) => ({
        id: typeof step.id === 'string' ? step.id : '',
        label: step.label,
        status: typeof step.status === 'string' ? step.status : 'pending'
      }));
  }
  if (typeof progress.error === 'string') out.error = progress.error;
  if (typeof progress.errorCode === 'string') out.errorCode = progress.errorCode;

  return out.opId ? out : null;
}

function sendDockerManagerEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

function scheduleRuntimeSetupResume() {
  if (typeof dockerManager.resumeRuntimeSetupIfPending !== 'function') return;
  setTimeout(() => {
    dockerManager.resumeRuntimeSetupIfPending().catch((error) => {
      console.error('[docker-manager] runtime setup resume failed', error);
    });
  }, 1500);
}

dockerManager.events.on('state', (state) => {
  lastDockerManagerState = state;
  if (tray) scheduleTrayMenuUpdate();
  try {
    sendDockerManagerEvent('docker-manager:state', sanitizeDockerManagerState(state));
  } catch {
    // ignore
  }
});

dockerManager.events.on('progress', (progress) => {
  if (tray) scheduleTrayMenuUpdate();
  const sanitized = sanitizeDockerManagerProgress(progress);
  if (sanitized) sendDockerManagerEvent('docker-manager:progress', sanitized);
});

ipcMain.handle('docker-manager:getState', async () => {
  try {
    const state = await dockerManager.getDockerManagerState();
    return sanitizeDockerManagerState(state);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:refresh', async () => {
  try {
    const state = await dockerManager.refreshDockerManager({ forceRefresh: true });
    return sanitizeDockerManagerState(state);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:install', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const accepted = await dockerManager.installOrSync(tag);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Install did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:startActive', async () => {
  try {
    const accepted = await dockerManager.startActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Start did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:stopActive', async () => {
  try {
    const accepted = await dockerManager.stopActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Stop did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:stopLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.stopLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Stop did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setRetentionPolicy', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const keepCount = body.keepCount;
    const policy = await dockerManager.setRetentionPolicy(keepCount);
    return { keepCount: policy.keepCount };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setPortPreferences', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const ui = body.ui;
    const ssh = body.ssh;
    const prefs = await dockerManager.setPortPreferences({ ui, ssh });
    return { ui: prefs.ui, ssh: prefs.ssh };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:provisionRuntime', async () => {
  try {
    const accepted = await dockerManager.provisionRuntime();
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Runtime setup did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:addRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const name = typeof body.name === 'string' ? body.name : '';
    const url = typeof body.url === 'string' ? body.url : '';
    const saved = await dockerManager.addRemoteInstance({ name, url });
    const sanitized = sanitizeDockerManagerState({ remoteInstances: [saved] }).remoteInstances?.[0];
    return sanitized || dockerManager.toErrorResponse({ code: 'INVALID_REMOTE_INSTANCE', message: 'Invalid remote instance' });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    return await dockerManager.deleteRemoteInstance(id);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.deleteLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Delete did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:deleteRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.deleteRetainedInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Delete did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:updateToLatest', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await dockerManager.updateToLatest(dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Update did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:activate', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const options = {
      instanceName: typeof body.instanceName === 'string' ? body.instanceName : '',
      portMappings: typeof body.portMappings === 'string' ? body.portMappings : '',
      envText: typeof body.envText === 'string' ? body.envText : ''
    };
    const accepted = await dockerManager.activateTag(tag, dataLossAck, options);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Activate did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:activateRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await dockerManager.activateRetainedInstance(containerId, dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Rollback did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:cancel', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const opId = typeof body.opId === 'string' ? body.opId : '';
    const result = await dockerManager.cancelOperation(opId);
    return { canceled: !!result?.canceled };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getInventory', async () => {
  try {
    return await dockerManager.getDockerInventory();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:removeVolume', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const volumeName = typeof body.volumeName === 'string' ? body.volumeName : '';
    return await dockerManager.removeVolume(volumeName);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:pruneVolumes', async () => {
  try {
    const result = await dockerManager.pruneVolumes();
    return { pruned: true, result };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:installDocker', async () => {
  try {
    return await installDockerDesktop();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:getInstanceTabs', async () => {
  try {
    return getInstanceTabsSnapshot();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setInstanceTabBounds', async (_event, body) => {
  try {
    // Bounds reporting is renderer->shell viewport telemetry. It must NOT emit
    // a tab-state event: the renderer reacts to that event by re-measuring and
    // calling setInstanceTabBounds again, which loops indefinitely.
    instanceTabBounds = sanitizeInstanceTabBounds(body);
    applyActiveInstanceTabBounds();
    return { updated: !!instanceTabBounds };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openInstanceUi', async (_event, body) => {
  try {
    const target = await resolveInstanceUiTarget(body);
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:selectInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return setActiveInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:closeInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return closeInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:reloadInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return reloadInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:detachInstanceTab', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    return detachInstanceTab(getInstanceTabIdFromRequest(body));
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openUi', async () => {
  try {
    const target = await resolveInstanceUiTarget({ kind: 'local' });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openContainerUi', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const target = await resolveInstanceUiTarget({ kind: 'local', containerId });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const target = await resolveInstanceUiTarget({ kind: 'remote', instanceId: id });
    return await openInstanceTab(target);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openHomepage', async () => {
  try {
    await shell.openExternal('https://www.agent-zero.ai/p/community/api-dashboard/');
    return { opened: true };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openCliTerminal', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const host = typeof body.host === 'string' ? body.host : '';
    return openA0CliTerminal(host);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openDockerLoginTerminal', async () => {
  try {
    return openDockerLoginTerminal();
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

// ---------------------------------------------------------------------------
// Custom protocol: a0app://
// Serves app content from disk so that fetch(), new URL(), and module imports
// work naturally (as if served by a web server). This stays in the shell layer
// and is NOT part of the A0 UI core.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{
  scheme: 'a0app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

// App lifecycle
app.whenReady().then(async () => {
  // Register the a0app:// protocol handler (must be inside whenReady).
  protocol.handle('a0app', (request) => {
    const url = new URL(request.url);
    const contentRoot = USING_LOCAL_CONTENT
      ? path.join(LOCAL_REPO_DIR, 'app')
      : CONTENT_DIR;
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.join(contentRoot, relativePath);

    // Path traversal protection
    const normalizedRoot = path.resolve(contentRoot);
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedRoot)) {
      console.log(`[a0app] BLOCKED (traversal): ${request.url} -> ${normalizedFile}`);
      return new Response('Forbidden', { status: 403 });
    }

    const fileUrl = pathToFileURL(normalizedFile).toString();
    console.log(`[a0app] ${request.url} -> ${fileUrl}`);
    return net.fetch(fileUrl);
  });
  createWindow();
  createTray();

  // DEBUG: capture renderer-side errors in terminal
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
  });
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer-error] ${message}`);
  });

  // Wait a moment for loading screen to render
  await new Promise(resolve => setTimeout(resolve, 500));

  // Initialize content
  const success = await initializeAppContent();

  if (success) {
    contentInitialized = true;
    // Small delay for visual feedback
    await new Promise(resolve => setTimeout(resolve, 800));
    await loadAppContent();
    scheduleRuntimeSetupResume();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();

    if (contentInitialized) {
      // Content already initialized - load directly without update check
      // Verify content still exists before loading
      const hasContent = await checkExistingContent();
      if (hasContent) {
        await loadAppContent();
      } else {
        // Content was deleted - reinitialize
        contentInitialized = false;
        const success = await initializeAppContent();
        if (success) {
          contentInitialized = true;
          await new Promise(resolve => setTimeout(resolve, 800));
          await loadAppContent();
        }
      }
    } else {
      // First activation or previous init failed - run full initialization
      await new Promise(resolve => setTimeout(resolve, 500));
      const success = await initializeAppContent();

      if (success) {
        contentInitialized = true;
        await new Promise(resolve => setTimeout(resolve, 800));
        await loadAppContent();
      }
    }
  }
});
