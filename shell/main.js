const { app, BrowserWindow, net, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const serviceVersions = require('./service_versions');

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

function resolveLocalRepoDir() {
  const rawPath = (process.env[LOCAL_REPO_ENV_VAR] || '').trim();
  const useLocalFromCwd = isTruthyEnv(process.env[USE_LOCAL_CONTENT_ENV_VAR]);

  const candidates = [];
  if (rawPath) candidates.push(path.resolve(process.cwd(), rawPath));
  if (useLocalFromCwd) candidates.push(process.cwd());

  for (const dir of candidates) {
    try {
      const appIndex = path.join(dir, 'app', 'index.html');
      const pkg = path.join(dir, 'package.json');
      if (!fsSync.existsSync(appIndex)) continue;
      if (!fsSync.existsSync(pkg)) continue;
      return dir;
    } catch {
      // ignore
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
let lastServiceVersionsState = null;
let trayMenuUpdateTimer = null;

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

  // Clear existing content directory
  await fs.rm(CONTENT_DIR, { recursive: true, force: true });
  await fs.mkdir(CONTENT_DIR, { recursive: true });

  // Write each file from the JSON bundle
  sendStatus('Extracting content...');

  for (const [filePath, content] of Object.entries(contentJson.files)) {
    const fullPath = path.join(CONTENT_DIR, filePath);
    const dir = path.dirname(fullPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
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

  const localMeta = await readLocalMeta();
  const remoteTimestamp = new Date(latestRelease.published_at).getTime();
  const localTimestamp = localMeta ? new Date(localMeta.published_at).getTime() : 0;

  if (remoteTimestamp > localTimestamp) {
    console.log(`Update available: ${latestRelease.tag_name} (${latestRelease.published_at})`);

    // Find the content.json asset
    const contentAsset = latestRelease.assets.find(
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

    try {
      await downloadContent(contentAsset.browser_download_url);

      // Save metadata
      await writeLocalMeta({
        version: latestRelease.tag_name,
        published_at: latestRelease.published_at,
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
 * Load the app content into the window
 */
async function loadAppContent() {
  const indexPath = USING_LOCAL_CONTENT ? LOCAL_INDEX_FILE : path.join(CONTENT_DIR, 'index.html');

  try {
    await fs.access(indexPath);
    mainWindow.loadFile(indexPath);
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

  const { hasActive, isRunning } = activeRunningFromState(lastServiceVersionsState);
  const op = typeof serviceVersions.getCurrentOperation === 'function' ? serviceVersions.getCurrentOperation() : null;
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
          await serviceVersions.startActiveInstance();
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
          await serviceVersions.stopActiveInstance();
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
  try {
    const u = new URL(String(value));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return false;
    if (u.port) {
      const p = Number(u.port);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sanitizeServiceVersionsState(state) {
  const versionsIn = Array.isArray(state?.versions) ? state.versions : [];
  const retainedIn = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
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

  const outState = {
    versions,
    retainedInstances,
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

  return outState;
}

function sanitizeServiceVersionsProgress(progress) {
  if (!isPlainObject(progress)) return null;
  const out = {};

  if (typeof progress.opId === 'string') out.opId = progress.opId;
  if (typeof progress.type === 'string') out.type = progress.type;
  if (typeof progress.status === 'string') out.status = progress.status;
  if (typeof progress.startedAt === 'string') out.startedAt = progress.startedAt;
  if (typeof progress.finishedAt === 'string') out.finishedAt = progress.finishedAt;
  if (typeof progress.targetVersionTag === 'string') out.targetVersionTag = progress.targetVersionTag;

  if (Number.isFinite(Number(progress.progress))) out.progress = Number(progress.progress);
  if (Number.isFinite(Number(progress.downloadProgress))) out.downloadProgress = Number(progress.downloadProgress);
  if (Number.isFinite(Number(progress.extractProgress))) out.extractProgress = Number(progress.extractProgress);
  if (typeof progress.message === 'string') out.message = progress.message;
  if (typeof progress.error === 'string') out.error = progress.error;

  return out.opId ? out : null;
}

function sendServiceVersionsEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

serviceVersions.events.on('state', (state) => {
  lastServiceVersionsState = state;
  if (tray) scheduleTrayMenuUpdate();
  try {
    sendServiceVersionsEvent('service-versions:state', sanitizeServiceVersionsState(state));
  } catch {
    // ignore
  }
});

serviceVersions.events.on('progress', (progress) => {
  if (tray) scheduleTrayMenuUpdate();
  const sanitized = sanitizeServiceVersionsProgress(progress);
  if (sanitized) sendServiceVersionsEvent('service-versions:progress', sanitized);
});

ipcMain.handle('service-versions:getState', async () => {
  try {
    const state = await serviceVersions.getServiceVersionsState();
    return sanitizeServiceVersionsState(state);
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:refresh', async () => {
  try {
    const state = await serviceVersions.refreshServiceVersions({ forceRefresh: true });
    return sanitizeServiceVersionsState(state);
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:install', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const accepted = await serviceVersions.installOrSync(tag);
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Install did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:startActive', async () => {
  try {
    const accepted = await serviceVersions.startActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Start did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:stopActive', async () => {
  try {
    const accepted = await serviceVersions.stopActiveInstance();
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Stop did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:setRetentionPolicy', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const keepCount = body.keepCount;
    const policy = await serviceVersions.setRetentionPolicy(keepCount);
    return { keepCount: policy.keepCount };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:setPortPreferences', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const ui = body.ui;
    const ssh = body.ssh;
    const prefs = await serviceVersions.setPortPreferences({ ui, ssh });
    return { ui: prefs.ui, ssh: prefs.ssh };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:deleteRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await serviceVersions.deleteRetainedInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Delete did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:updateToLatest', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await serviceVersions.updateToLatest(dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Update did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:activate', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const tag = typeof body.tag === 'string' ? body.tag : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await serviceVersions.activateVersion(tag, dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Activate did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:activateRetainedInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const dataLossAck = typeof body.dataLossAck === 'string' ? body.dataLossAck : '';
    const accepted = await serviceVersions.activateRetainedInstance(containerId, dataLossAck);
    if (!accepted || typeof accepted.opId !== 'string') {
      return serviceVersions.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Rollback did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:cancel', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return serviceVersions.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const opId = typeof body.opId === 'string' ? body.opId : '';
    const result = await serviceVersions.cancelOperation(opId);
    return { canceled: !!result?.canceled };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:openUi', async () => {
  try {
    // Refresh state to compute a best-effort UI URL from the currently active container.
    const state = await serviceVersions.refreshServiceVersions({ forceRefresh: false });
    const url = typeof state?.uiUrl === 'string' ? state.uiUrl : '';
    if (!url) {
      return serviceVersions.toErrorResponse({ code: 'UI_UNAVAILABLE', message: 'Agent Zero UI is not available. Start a version first.' });
    }
    if (!isAllowedLocalUrl(url)) {
      return serviceVersions.toErrorResponse({ code: 'UI_UNAVAILABLE', message: 'Agent Zero UI URL is not available.' });
    }
    await shell.openExternal(url);
    return { opened: true };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

ipcMain.handle('service-versions:openHomepage', async () => {
  try {
    await shell.openExternal('https://agent-zero.ai/');
    return { opened: true };
  } catch (error) {
    return serviceVersions.toErrorResponse(error);
  }
});

// App lifecycle
app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Wait a moment for loading screen to render
  await new Promise(resolve => setTimeout(resolve, 500));

  // Initialize content
  const success = await initializeAppContent();

  if (success) {
    contentInitialized = true;
    // Small delay for visual feedback
    await new Promise(resolve => setTimeout(resolve, 800));
    await loadAppContent();
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
