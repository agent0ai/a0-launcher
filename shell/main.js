const { app, BrowserWindow, WebContentsView, net, ipcMain, shell, Tray, Menu, nativeImage, protocol } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dockerManager = require('./docker_manager');
const {
  normalizeHttpUrl,
  isAllowedLocalInstanceUrl,
  isAllowedRemoteInstanceUrl,
  makeTabKey,
  makeTabsSnapshot
} = require('./instance_tabs');
const { formatLauncherVersion } = require('./launcher_update');
const {
  cleanupLauncherUpdaterArtifacts,
  writeLauncherUpdaterInstallMarker
} = require('./launcher_updater_artifacts');
const { resolveLauncherUpdaterLogPath } = require('./launcher_updater_install_options');
const {
  resolveLauncherWindowsReleaseArchFallback,
  resolveLauncherDebugReleaseAssetUrl,
  resolveLauncherDebugReleaseTag,
  stageLauncherDebugRelease
} = require('./launcher_updater_debug_release');

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
const SPLASH_ENTRY_ANIMATION_MS = 1600;
const SPLASH_EXIT_ANIMATION_MS = 180;

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
let launcherUpdateDismissed = false;
let launcherAutoUpdater = null;
let launcherUpdateCheckPromise = null;
let launcherUpdateDownloadPromise = null;
let launcherUpdateState = {
  state: 'idle',
  message: '',
  progress: null,
  version: ''
};
let mainWindowMode = '';
let mainWindowCreatedAt = 0;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function isLauncherUpdateActionable(state = launcherUpdateState.state) {
  return ['update-available', 'downloading', 'downloaded', 'installing'].includes(state);
}

function publishLauncherUpdateState(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const payload = {
    ...launcherUpdateState,
    readyToContinue: contentInitialized,
    ...extra
  };

  mainWindow.webContents.send('launcher-update-status', payload);
  if (isLauncherUpdateActionable(payload.state)) {
    mainWindow.webContents.send('launcher-update-available', payload);
  }
}

function setLauncherUpdateState(patch = {}) {
  launcherUpdateState = {
    ...launcherUpdateState,
    ...patch
  };

  if (!Object.prototype.hasOwnProperty.call(patch, 'progress')) {
    launcherUpdateState.progress = null;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'version')) {
    launcherUpdateState.version = launcherUpdateState.version || '';
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'message')) {
    launcherUpdateState.message = launcherUpdateState.message || '';
  }

  publishLauncherUpdateState();
}

function shouldEnableLauncherAutoUpdate() {
  return app.isPackaged;
}

function loadLauncherAutoUpdater() {
  if (launcherAutoUpdater) return launcherAutoUpdater;

  try {
    ({ autoUpdater: launcherAutoUpdater } = require('electron-updater'));
  } catch (error) {
    console.warn('[launcher-update] electron-updater is unavailable.', error);
    launcherAutoUpdater = null;
  }

  return launcherAutoUpdater;
}

async function appendLauncherUpdaterPersistentLog(logPath, message, details = null) {
  const resolvedLogPath = String(logPath || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!resolvedLogPath || !normalizedMessage) return;

  const lines = [
    `${new Date().toISOString()} [a0-launcher/updater] ${normalizedMessage}`
  ];

  if (details && typeof details === 'object') {
    try {
      lines.push(JSON.stringify(details));
    } catch {
      // Best-effort diagnostics only.
    }
  }

  try {
    await fs.mkdir(path.dirname(resolvedLogPath), { recursive: true });
    await fs.appendFile(resolvedLogPath, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // Persistent updater logging must never block launch or install handoff.
  }
}

function resolveLauncherUpdaterLogPathForCurrentRun() {
  return resolveLauncherUpdaterLogPath({
    userDataPath: app.getPath('userData')
  });
}

function isLauncherNetworkOnline() {
  try {
    return !net || typeof net.isOnline !== 'function' || net.isOnline();
  } catch {
    return true;
  }
}

function formatLauncherUpdateError(context, error) {
  const detail = error && typeof error.message === 'string' ? error.message : String(error || 'Unknown error');
  return `${context} ${detail}`;
}

function reportLauncherUpdateFailure(context, error) {
  const message = formatLauncherUpdateError(context, error);
  console.warn('[launcher-update]', message);
  setLauncherUpdateState({
    state: 'error',
    message,
    progress: null,
    version: ''
  });
  return { summary: message };
}

function resolveLauncherDebugReinstallRequestVersion(payload = {}) {
  if (typeof payload === 'string') {
    return payload.trim();
  }

  if (payload && typeof payload === 'object') {
    return String(payload.version || '').trim();
  }

  return '';
}

async function fetchLauncherUpdateMetadataText(metadataUrl) {
  const response = await net.fetch(metadataUrl, {
    headers: {
      accept: 'text/yaml, text/x-yaml, text/plain, */*'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Could not download launcher update metadata ${metadataUrl} (${response.status} ${response.statusText || 'Unknown'}).`
    );
  }

  return await response.text();
}

async function downloadLauncherUpdateAssetToFile(assetUrl, destinationPath, { onProgress } = {}) {
  const response = await net.fetch(assetUrl, {
    headers: {
      accept: 'application/octet-stream, */*'
    }
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download launcher update asset ${assetUrl} (${response.status} ${response.statusText || 'Unknown'}).`
    );
  }

  const totalBytes = Number(response.headers.get('content-length')) || 0;
  const destinationDir = path.dirname(destinationPath);
  const temporaryPath = path.join(destinationDir, `temp-${path.basename(destinationPath)}`);
  const hash = createHash('sha512');
  let downloadedBytes = 0;

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.rm(temporaryPath, { force: true });
  await fs.rm(destinationPath, { force: true });

  const hashAndProgress = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      downloadedBytes += chunk.length;
      onProgress?.({
        downloadedBytes,
        totalBytes,
        progress: totalBytes > 0 ? downloadedBytes / totalBytes : null
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(Readable.fromWeb(response.body), hashAndProgress, fsSync.createWriteStream(temporaryPath));
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    sha512: hash.digest('base64'),
    size: downloadedBytes
  };
}

async function downloadLauncherWindowsUpdateWithArchFallback(autoUpdater) {
  if (process.platform !== 'win32') return null;

  const updateInfoAndProvider = autoUpdater?.updateInfoAndProvider;
  const updateInfo = updateInfoAndProvider?.info || null;
  const fallback = resolveLauncherWindowsReleaseArchFallback(updateInfo, process.arch);
  if (!fallback) return null;

  const publishConfig = await autoUpdater.configOnDisk.value;
  const tag = resolveLauncherDebugReleaseTag(updateInfo?.version || '');
  const installerUrl = resolveLauncherDebugReleaseAssetUrl({
    publishConfig,
    tag,
    fileName: fallback.expectedFileName
  });
  const downloadedUpdateHelper = await autoUpdater.getOrCreateDownloadHelper();
  const pendingDir = downloadedUpdateHelper.cacheDirForPendingUpdate;
  const destinationPath = path.join(pendingDir, fallback.expectedFileName);
  const logPath = resolveLauncherUpdaterLogPathForCurrentRun();

  await appendLauncherUpdaterPersistentLog(logPath, 'Windows update metadata is missing the current arch installer; using the canonical release asset fallback.', {
    actualFiles: fallback.actualFiles,
    currentArch: process.arch,
    expectedArch: fallback.expectedArch,
    expectedFileName: fallback.expectedFileName,
    installerUrl,
    targetVersion: updateInfo?.version || ''
  });

  await downloadedUpdateHelper.clear();

  setLauncherUpdateState({
    state: 'downloading',
    message: 'Downloading update...',
    progress: null,
    version: formatLauncherVersion(updateInfo?.version || '')
  });

  const downloadedFile = await downloadLauncherUpdateAssetToFile(installerUrl, destinationPath, {
    onProgress({ progress }) {
      if (!Number.isFinite(progress)) return;
      const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
      setLauncherUpdateState({
        state: 'downloading',
        message: `Downloading update ${percent}%`,
        progress,
        version: formatLauncherVersion(updateInfo?.version || '')
      });
    }
  });

  const fileInfo = {
    url: new URL(installerUrl),
    info: {
      url: fallback.expectedFileName,
      sha512: downloadedFile.sha512,
      size: String(downloadedFile.size)
    }
  };
  const normalizedUpdateInfo = {
    ...updateInfo,
    files: [fileInfo.info],
    path: fallback.expectedFileName,
    sha512: downloadedFile.sha512
  };

  await downloadedUpdateHelper.setDownloadedFile(
    destinationPath,
    null,
    normalizedUpdateInfo,
    fileInfo,
    fallback.expectedFileName,
    true
  );
  autoUpdater.updateInfoAndProvider = {
    info: normalizedUpdateInfo,
    provider: updateInfoAndProvider.provider
  };

  const version = formatLauncherVersion(normalizedUpdateInfo.version);
  setLauncherUpdateState({
    state: 'downloaded',
    message: version ? `Update ${version} is ready to install.` : 'Update ready to install.',
    progress: null,
    version
  });

  return {
    ok: true,
    status: 'downloaded',
    version
  };
}

async function checkForLauncherUpdates({ userInitiated = false } = {}) {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateCheckPromise) {
    return launcherUpdateCheckPromise;
  }

  if (!isLauncherNetworkOnline()) {
    const message = 'Update check skipped while offline.';
    setLauncherUpdateState({
      state: 'offline',
      message,
      progress: null,
      version: ''
    });
    return { ok: false, reason: 'offline', message };
  }

  launcherUpdateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = formatLauncherVersion(result?.updateInfo?.version);
      return {
        ok: true,
        status: launcherUpdateState.state || 'checked',
        version
      };
    } catch (error) {
      const formattedError = reportLauncherUpdateFailure(
        userInitiated ? 'Launcher update check failed.' : 'Launcher auto-update check failed.',
        error
      );
      return {
        ok: false,
        reason: 'error',
        message: formattedError.summary
      };
    } finally {
      launcherUpdateCheckPromise = null;
    }
  })();

  return launcherUpdateCheckPromise;
}

async function downloadLauncherUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateState.state === 'downloaded') {
    return { ok: true, status: 'downloaded', version: launcherUpdateState.version || '' };
  }

  if (launcherUpdateDownloadPromise) {
    return launcherUpdateDownloadPromise;
  }

  if (launcherUpdateState.state !== 'update-available') {
    return { ok: false, reason: 'not-ready', message: 'No launcher update is ready to download yet.' };
  }

  launcherUpdateDownloadPromise = (async () => {
    try {
      const windowsArchFallbackResult = await downloadLauncherWindowsUpdateWithArchFallback(autoUpdater);
      if (windowsArchFallbackResult) {
        return windowsArchFallbackResult;
      }

      await autoUpdater.downloadUpdate();
      return {
        ok: true,
        status: 'downloading',
        version: launcherUpdateState.version || ''
      };
    } catch (error) {
      const formattedError = reportLauncherUpdateFailure('Launcher update download failed.', error);
      return {
        ok: false,
        reason: 'error',
        message: formattedError.summary
      };
    } finally {
      launcherUpdateDownloadPromise = null;
    }
  })();

  return launcherUpdateDownloadPromise;
}

async function installLauncherUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (launcherUpdateState.state !== 'downloaded') {
    return { ok: false, reason: 'not-ready', message: 'No downloaded launcher update is ready to install yet.' };
  }

  setLauncherUpdateState({
    state: 'installing',
    message: 'Restarting to install update...',
    progress: null
  });

  const logPath = resolveLauncherUpdaterLogPathForCurrentRun();
  const useSilentWindowsInstall = process.platform === 'win32';

  try {
    await writeLauncherUpdaterInstallMarker({
      fromVersion: app.getVersion(),
      targetVersion: launcherUpdateState.version || '',
      userDataPath: app.getPath('userData')
    });
    await appendLauncherUpdaterPersistentLog(logPath, 'Updater cleanup marker written.', {
      fromVersion: app.getVersion(),
      targetVersion: launcherUpdateState.version || ''
    });
  } catch (error) {
    await appendLauncherUpdaterPersistentLog(logPath, 'Could not persist the updater cleanup marker.', {
      message: error && typeof error.message === 'string' ? error.message : String(error || 'Unknown error')
    });
  }

  await appendLauncherUpdaterPersistentLog(logPath, 'Installing downloaded launcher update with electron-updater.', {
    installerPath: autoUpdater?.installerPath || '',
    isForceRunAfter: useSilentWindowsInstall,
    isSilent: useSilentWindowsInstall,
    packagePath: autoUpdater?.downloadedUpdateHelper?.packageFile || '',
    targetVersion: launcherUpdateState.version || ''
  });

  isQuitting = true;
  setImmediate(() => {
    autoUpdater.quitAndInstall(useSilentWindowsInstall, useSilentWindowsInstall);
  });

  return { ok: true, status: 'installing', version: launcherUpdateState.version || '' };
}

async function beginLauncherUpdate() {
  if (launcherUpdateState.state === 'downloaded') {
    return installLauncherUpdate();
  }

  if (launcherUpdateState.state === 'update-available') {
    return downloadLauncherUpdate();
  }

  if (launcherUpdateState.state === 'downloading' || launcherUpdateState.state === 'installing') {
    return { ok: true, status: launcherUpdateState.state, version: launcherUpdateState.version || '' };
  }

  const checkResult = await checkForLauncherUpdates({ userInitiated: true });
  if (launcherUpdateState.state === 'update-available') {
    return downloadLauncherUpdate();
  }
  return checkResult;
}

async function stageLauncherDebugReinstall(payload = {}) {
  if (!shouldEnableLauncherAutoUpdate()) {
    return { ok: false, reason: 'unavailable' };
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return { ok: false, reason: 'unavailable' };
  }

  if (!isLauncherNetworkOnline()) {
    const message = 'Debug reinstall skipped while offline.';
    setLauncherUpdateState({
      state: 'offline',
      message,
      progress: null,
      version: ''
    });
    return { ok: false, reason: 'offline', message };
  }

  const requestedVersion = resolveLauncherDebugReinstallRequestVersion(payload);
  const currentVersion = app.getVersion();
  const requestedLabel = requestedVersion || currentVersion;

  setLauncherUpdateState({
    state: 'checking',
    message: 'Preparing debug reinstall...',
    progress: null,
    version: ''
  });

  try {
    const publishConfig = await autoUpdater.configOnDisk.value;
    const stagedRelease = await stageLauncherDebugRelease({
      requestedVersion,
      currentVersion,
      platform: process.platform,
      arch: process.arch,
      publishConfig,
      fetchText: fetchLauncherUpdateMetadataText
    });
    const targetVersion = formatLauncherVersion(stagedRelease.info?.version || stagedRelease.requestedVersion);
    const action =
      stagedRelease.comparison < 0
        ? 'downgrade'
        : stagedRelease.comparison === 0
          ? 'reinstall'
          : 'update';
    const logPath = resolveLauncherUpdaterLogPathForCurrentRun();

    autoUpdater.allowDowngrade = stagedRelease.comparison < 0;
    autoUpdater.updateInfoAndProvider = {
      info: stagedRelease.info,
      provider: stagedRelease.provider
    };

    await appendLauncherUpdaterPersistentLog(logPath, 'Prepared launcher debug reinstall staging.', {
      action,
      currentVersion,
      metadataFileName: stagedRelease.metadataFileName,
      metadataUrl: stagedRelease.metadataUrl,
      requestedVersion: requestedLabel,
      targetVersion: stagedRelease.info?.version || stagedRelease.requestedVersion,
      tag: stagedRelease.tag
    });

    setLauncherUpdateState({
      state: 'update-available',
      message: targetVersion ? `Update ${targetVersion} is available.` : 'A launcher update is available.',
      progress: null,
      version: targetVersion
    });

    const downloadResult = await downloadLauncherUpdate();
    if (!downloadResult?.ok) {
      return downloadResult;
    }

    return {
      ok: true,
      action,
      metadataUrl: stagedRelease.metadataUrl,
      status: launcherUpdateState.state,
      tag: stagedRelease.tag,
      version: launcherUpdateState.version || targetVersion
    };
  } catch (error) {
    const formattedError = reportLauncherUpdateFailure(
      `Launcher debug reinstall preparation failed for ${requestedLabel}.`,
      error
    );
    return {
      ok: false,
      reason: 'error',
      message: formattedError.summary
    };
  }
}

function configureLauncherAutoUpdate() {
  if (!shouldEnableLauncherAutoUpdate()) {
    return;
  }

  const autoUpdater = loadLauncherAutoUpdater();
  if (!autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    setLauncherUpdateState({
      state: 'checking',
      message: 'Checking for updates...',
      progress: null,
      version: ''
    });
  });

  autoUpdater.on('update-available', (info) => {
    const version = formatLauncherVersion(info?.version);
    setLauncherUpdateState({
      state: 'update-available',
      message: version ? `Update ${version} is available.` : 'A launcher update is available.',
      progress: null,
      version
    });
    console.log(version ? `Launcher update available: ${version}` : 'Launcher update available.');
  });

  autoUpdater.on('update-not-available', () => {
    setLauncherUpdateState({
      state: 'up-to-date',
      message: '',
      progress: null,
      version: ''
    });
  });

  autoUpdater.on('error', (error) => {
    reportLauncherUpdateFailure('Launcher auto-update failed.', error);
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress && progress.percent);
    if (!Number.isFinite(percent)) {
      setLauncherUpdateState({
        state: 'downloading',
        message: 'Downloading update...',
        progress: null
      });
      return;
    }

    const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    setLauncherUpdateState({
      state: 'downloading',
      message: `Downloading update ${boundedPercent}%`,
      progress: boundedPercent / 100
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = formatLauncherVersion(info?.version);
    setLauncherUpdateState({
      state: 'downloaded',
      message: version ? `Update ${version} is ready to install.` : 'Update ready to install.',
      progress: null,
      version
    });
  });
}

async function cleanupStaleLauncherUpdaterArtifacts() {
  try {
    const result = await cleanupLauncherUpdaterArtifacts({
      isPackaged: app.isPackaged,
      userDataPath: app.getPath('userData')
    });
    if (result.cleaned) {
      console.log('[launcher-update] Cleaned stale updater artifacts.');
    }
  } catch (error) {
    console.warn('[launcher-update] Could not clean stale updater artifacts.', error);
  }
}

function shouldHoldStartupForLauncherUpdate() {
  if (launcherUpdateDismissed || !isLauncherUpdateActionable()) {
    return false;
  }

  publishLauncherUpdateState({ readyToContinue: contentInitialized });
  if (launcherUpdateState.message) {
    sendStatus(launcherUpdateState.message);
  } else if (launcherUpdateState.version) {
    sendStatus(`Launcher ${launcherUpdateState.version} is available.`);
  } else {
    sendStatus('A launcher update is available.');
  }
  return true;
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
    await ensureAppWindowForContent();
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

async function continueToAppContent(options = {}) {
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Math.max(0, Number(options.delayMs)) : 0;
  if (delayMs > 0) {
    await wait(delayMs);
  }
  if (mainWindowMode === 'splash') {
    const remainingEntryMs = SPLASH_ENTRY_ANIMATION_MS - Math.max(0, Date.now() - mainWindowCreatedAt);
    if (remainingEntryMs > 0) await wait(remainingEntryMs);
  }
  await loadAppContent();
  scheduleRuntimeSetupResume();
}

/**
 * Create the main browser window
 */
function attachWindowDiagnostics(windowRef) {
  windowRef.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[did-fail-load] code=${code} desc=${desc} url=${url}`);
  });
  windowRef.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer-error] ${message}`);
  });
}

function createWindow(mode = 'splash') {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );
  const isSplash = mode === 'splash';

  const windowRef = new BrowserWindow({
    width: isSplash ? 360 : 1280,
    height: isSplash ? 300 : 800,
    minWidth: isSplash ? 360 : 800,
    minHeight: isSplash ? 300 : 600,
    title: 'A0 Launcher',
    icon: iconPath,
    show: false,
    frame: !isSplash,
    transparent: isSplash,
    resizable: !isSplash,
    maximizable: !isSplash,
    fullscreenable: !isSplash,
    hasShadow: !isSplash,
    backgroundColor: isSplash ? '#00000000' : undefined,
    skipTaskbar: isSplash,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow = windowRef;
  mainWindowMode = mode;
  mainWindowCreatedAt = Date.now();
  attachWindowDiagnostics(windowRef);

  if (isSplash) {
    windowRef.loadFile(path.join(__dirname, 'loading.html'));
  }

  windowRef.once('ready-to-show', () => {
    if (!windowRef.isDestroyed()) windowRef.show();
  });

  // With a tray present, closing the window hides it on desktop tray platforms.
  // On macOS, allow the window to close so the app can quit cleanly and avoid
  // idle Electron helper processes.
  windowRef.on('close', (e) => {
    if (isSplash) return;
    if (isQuitting) return;
    if (!tray || process.platform === 'darwin') return;
    e.preventDefault();
    windowRef.hide();
  });

  windowRef.on('closed', () => {
    if (mainWindow === windowRef) {
      if (!isSplash) cleanupInstanceTabs();
      mainWindow = null;
      mainWindowMode = '';
    }
    if (tray) scheduleTrayMenuUpdate();
  });

  const updateTrayForWindow = () => {
    if (tray) scheduleTrayMenuUpdate();
  };
  windowRef.on('show', updateTrayForWindow);
  windowRef.on('hide', updateTrayForWindow);
  windowRef.on('minimize', updateTrayForWindow);
  windowRef.on('restore', updateTrayForWindow);
}

async function playSplashExitAnimation(splashWindow) {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  try {
    splashWindow.webContents.send('launcher-opening-app');
  } catch {
    return;
  }
  await wait(SPLASH_EXIT_ANIMATION_MS);
}

async function ensureAppWindowForContent() {
  if (mainWindowMode !== 'splash') return;

  const splashWindow = mainWindow;
  await playSplashExitAnimation(splashWindow);
  createWindow('app');

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
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

ipcMain.handle('check-launcher-update', () => checkForLauncherUpdates({ userInitiated: true }));
ipcMain.handle('begin-launcher-update', () => beginLauncherUpdate());
ipcMain.handle('download-launcher-update', () => downloadLauncherUpdate());
ipcMain.handle('install-launcher-update', () => installLauncherUpdate());
ipcMain.handle('launcher-debug-reinstall', (_event, payload) => stageLauncherDebugReinstall(payload));

ipcMain.handle('continue-after-launcher-update', async () => {
  try {
    launcherUpdateDismissed = true;
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      return { ok: false, reason: 'no-content', message: 'No launcher content is available yet.' };
    }
    await continueToAppContent();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error && typeof error.message === 'string' ? error.message : 'Could not continue.'
    };
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

function sanitizeInstanceTabTitle(value, fallback = 'Agent Zero') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  return raw.replace(/\s+/g, ' ').slice(0, 80);
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
    const title = sanitizeInstanceTabTitle(remote?.name, 'Agent Zero');
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
      title: sanitizeInstanceTabTitle(request.title, 'Agent Zero'),
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
    title: sanitizeInstanceTabTitle(request.title, 'Agent Zero'),
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

function selectInstanceHome() {
  activeInstanceTabId = '';
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
    if (tab.titleLocked) return;
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
    existing.title = target.title || existing.title;
    existing.titleLocked = Boolean(target.title) || existing.titleLocked;
    existing.containerId = target.containerId || existing.containerId || '';
    existing.instanceId = target.instanceId || existing.instanceId || '';
    const nextUrl = normalizeHttpUrl(target.url);
    if (nextUrl && nextUrl !== normalizeHttpUrl(existing.url)) {
      existing.url = nextUrl;
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
    titleLocked: Boolean(target.title),
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

  const err = new Error('Docker CLI was not found. Finish Docker Setup, then try again.');
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

async function openHostFolder(folderPath) {
  const targetPath = typeof folderPath === 'string' ? folderPath.trim() : '';
  if (!targetPath) {
    return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Storage folder is not available.' });
  }
  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Storage folder is not a directory.' });
    }
    const opened = await shell.openPath(targetPath);
    if (opened) {
      return dockerManager.toErrorResponse({ code: 'OPEN_FAILED', message: opened });
    }
    return { opened: true };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return dockerManager.toErrorResponse({ code: 'WORKSPACE_FOLDER_NOT_FOUND', message: 'Storage folder was not found.' });
    }
    return dockerManager.toErrorResponse(error);
  }
}

function sanitizeDockerManagerState(state) {
  const versionsIn = Array.isArray(state?.versions) ? state.versions : [];
  const containersIn = Array.isArray(state?.containers) ? state.containers : [];
  const retainedIn = Array.isArray(state?.retainedInstances) ? state.retainedInstances : [];
  const remoteIn = Array.isArray(state?.remoteInstances) ? state.remoteInstances : [];
  const policyIn = isPlainObject(state?.retentionPolicy) ? state.retentionPolicy : {};
  const portsIn = isPlainObject(state?.portPreferences) ? state.portPreferences : {};
  const storagePrefsIn = isPlainObject(state?.storagePreferences) ? state.storagePreferences : {};
  const defaultsIn = isPlainObject(state?.instanceDefaults) ? state.instanceDefaults : {};

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

  const containers = [];
  for (const c of containersIn) {
    if (!isPlainObject(c)) continue;
    const containerId = typeof c.containerId === 'string' ? c.containerId : '';
    const containerName = typeof c.containerName === 'string' ? c.containerName : '';
    if (!containerId || !containerName) continue;
    const out = { containerId, containerName };
    if (typeof c.instanceName === 'string' || c.instanceName === null) out.instanceName = c.instanceName || null;
    if (typeof c.imageRef === 'string') out.imageRef = c.imageRef;
    if (typeof c.tag === 'string') out.tag = c.tag;
    if (typeof c.versionTag === 'string') out.versionTag = c.versionTag;
    if (typeof c.runtimeBranch === 'string' || c.runtimeBranch === null) out.runtimeBranch = c.runtimeBranch || null;
    if (typeof c.runtimeCommit === 'string' || c.runtimeCommit === null) out.runtimeCommit = c.runtimeCommit || null;
    if (typeof c.runtimeShortCommit === 'string' || c.runtimeShortCommit === null) out.runtimeShortCommit = c.runtimeShortCommit || null;
    if (isPlainObject(c.runtimeSource)) {
      const runtimeSource = {};
      if (c.runtimeSource.type === 'git') runtimeSource.type = 'git';
      if (typeof c.runtimeSource.workdir === 'string') runtimeSource.workdir = c.runtimeSource.workdir;
      if (typeof c.runtimeSource.branch === 'string' || c.runtimeSource.branch === null) runtimeSource.branch = c.runtimeSource.branch || null;
      if (typeof c.runtimeSource.commit === 'string' || c.runtimeSource.commit === null) runtimeSource.commit = c.runtimeSource.commit || null;
      if (typeof c.runtimeSource.shortCommit === 'string' || c.runtimeSource.shortCommit === null) {
        runtimeSource.shortCommit = c.runtimeSource.shortCommit || null;
      }
      if (Object.keys(runtimeSource).length) out.runtimeSource = runtimeSource;
    }
    if (typeof c.state === 'string' || c.state === null) out.state = c.state || null;
    if (typeof c.status === 'string' || c.status === null) out.status = c.status || null;
    if (Number.isFinite(Number(c.createdAt))) out.createdAt = Number(c.createdAt);
    if (typeof c.uiUrl === 'string' && isAllowedHttpUrl(c.uiUrl)) out.uiUrl = c.uiUrl;
    if (isPlainObject(c.labels)) {
      const labels = {};
      for (const [key, value] of Object.entries(c.labels)) {
        if (typeof key === 'string' && typeof value === 'string') labels[key] = value;
      }
      out.labels = labels;
    }
    if (Array.isArray(c.ports)) {
      out.ports = c.ports.map((p) => ({
        privatePort: Number.isFinite(Number(p?.privatePort)) ? Number(p.privatePort) : null,
        publicPort: Number.isFinite(Number(p?.publicPort)) ? Number(p.publicPort) : null,
        type: typeof p?.type === 'string' ? p.type : null,
        ip: typeof p?.ip === 'string' ? p.ip : null
      }));
    }
    if (isPlainObject(c.workspaceStorage)) {
      const storage = {};
      const allowedModes = new Set(['host_directory', 'named_volume', 'custom_mount', 'legacy_ephemeral', 'ephemeral']);
      if (typeof c.workspaceStorage.mode === 'string' && allowedModes.has(c.workspaceStorage.mode)) {
        storage.mode = c.workspaceStorage.mode;
      }
      if (typeof c.workspaceStorage.target === 'string') storage.target = c.workspaceStorage.target;
      if (typeof c.workspaceStorage.hostPath === 'string') storage.hostPath = c.workspaceStorage.hostPath;
      if (typeof c.workspaceStorage.volumeName === 'string') storage.volumeName = c.workspaceStorage.volumeName;
      if (typeof c.workspaceStorage.persistent === 'boolean') storage.persistent = c.workspaceStorage.persistent;
      if (typeof c.workspaceStorage.legacy === 'boolean') storage.legacy = c.workspaceStorage.legacy;
      if (typeof c.workspaceStorage.migrationAvailable === 'boolean') {
        storage.migrationAvailable = c.workspaceStorage.migrationAvailable;
      }
      if (Object.keys(storage).length) out.workspaceStorage = storage;
    }
    containers.push(out);
  }

  const keepCount = Number.isFinite(Number(policyIn.keepCount)) ? Number(policyIn.keepCount) : 1;
  const retentionPolicy = { keepCount: Math.max(0, Math.min(20, Math.floor(keepCount))) };

  const normalizePreferenceText = (value, maxLength) => String(value || '')
    .trim()
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, maxLength);
  const defaultProviders = {
    Main: 'openrouter',
    Utility: 'openrouter',
    Embedding: 'huggingface'
  };
  const sourceModels = isPlainObject(defaultsIn.models) ? defaultsIn.models : {};
  const instanceDefaults = { models: {} };
  for (const id of ['Main', 'Utility', 'Embedding']) {
    const source = isPlainObject(sourceModels[id]) ? sourceModels[id] : {};
    instanceDefaults.models[id] = {
      provider: normalizePreferenceText(source.provider, 96) || defaultProviders[id],
      model: normalizePreferenceText(source.model, 256),
      apiKey: normalizePreferenceText(source.apiKey, 4096)
    };
  }

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
    containers,
    retainedInstances,
    remoteInstances,
    retentionPolicy,
    instanceDefaults
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

  {
    const mode = storagePrefsIn.mode === 'named_volume' ? 'named_volume' : 'host_directory';
    const cleanText = (value, fallback, maxLength = 512) => {
      const text = String(value || '')
        .trim()
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, maxLength);
      return text || fallback;
    };
    outState.storagePreferences = {
      mode,
      hostRoot: cleanText(storagePrefsIn.hostRoot, '~/agent-zero'),
      volumePrefix: cleanText(storagePrefsIn.volumePrefix, 'a0-launcher', 120)
    };
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

function sanitizeContainerLogsResult(result) {
  if (!isPlainObject(result)) return { lines: [] };
  const out = {
    containerId: typeof result.containerId === 'string' ? result.containerId : '',
    containerName: typeof result.containerName === 'string' ? result.containerName : '',
    instanceName: typeof result.instanceName === 'string' ? result.instanceName : '',
    fetchedAt: typeof result.fetchedAt === 'string' ? result.fetchedAt : '',
    maxLines: Number.isFinite(Number(result.maxLines)) ? Math.max(0, Math.floor(Number(result.maxLines))) : 0,
    aborted: result.aborted === true,
    lines: []
  };

  for (const evt of Array.isArray(result.lines) ? result.lines : []) {
    if (!isPlainObject(evt)) continue;
    const stream = evt.stream === 'stderr' ? 'stderr' : 'stdout';
    const line = typeof evt.line === 'string' ? evt.line.slice(0, 12_000) : '';
    out.lines.push({
      stream,
      line,
      partial: evt.partial === true
    });
  }

  return out;
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
  if (typeof progress.canCancel === 'boolean') out.canCancel = progress.canCancel;

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
  if (isPlainObject(progress.workspaceMigration)) {
    const migration = {};
    const cleanText = (value, maxLength = 160) => String(value || '')
      .trim()
      .replace(/[^\x20-\x7E]/g, '')
      .slice(0, maxLength);
    for (const key of ['sourceName', 'sourceContainerName', 'replacementName', 'replacementContainerName', 'mountTarget']) {
      const value = cleanText(progress.workspaceMigration[key]);
      if (value) migration[key] = value;
    }
    if (Object.keys(migration).length) out.workspaceMigration = migration;
  }

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

ipcMain.handle('docker-manager:startLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.startLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Start did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:cloneLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.cloneLocalInstance(containerId);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Clone did not return an opId' });
    }
    return { opId: accepted.opId };
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:migrateLocalInstanceStorage', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const accepted = await dockerManager.migrateLocalInstanceStorage(containerId, {
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : ''
    });
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Migration did not return an opId' });
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

ipcMain.handle('docker-manager:setStoragePreferences', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const prefs = await dockerManager.setStoragePreferences({
      mode: typeof body.mode === 'string' ? body.mode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      volumePrefix: typeof body.volumePrefix === 'string' ? body.volumePrefix : ''
    });
    return sanitizeDockerManagerState({ storagePreferences: prefs }).storagePreferences;
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:setInstanceDefaults', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const defaults = await dockerManager.setInstanceDefaults({
      models: isPlainObject(body.models) ? body.models : {}
    });
    return sanitizeDockerManagerState({ instanceDefaults: defaults }).instanceDefaults;
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

ipcMain.handle('docker-manager:selectRuntimeEndpoint', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    return await dockerManager.selectRuntimeEndpoint(id);
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

ipcMain.handle('docker-manager:renameRemoteInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const id = typeof body.id === 'string' ? body.id : '';
    const name = typeof body.name === 'string' ? body.name : '';
    const saved = await dockerManager.renameRemoteInstance(id, name);
    const sanitized = sanitizeDockerManagerState({ remoteInstances: [saved] }).remoteInstances?.[0];
    return sanitized || dockerManager.toErrorResponse({ code: 'INVALID_REMOTE_INSTANCE', message: 'Invalid remote instance' });
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:renameLocalInstance', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const name = typeof body.name === 'string' ? body.name : '';
    return await dockerManager.renameLocalInstance(containerId, name);
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
      envText: typeof body.envText === 'string' ? body.envText : '',
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : ''
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

ipcMain.handle('docker-manager:runCustomImage', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const options = {
      image: typeof body.image === 'string' ? body.image : '',
      tag: typeof body.tag === 'string' ? body.tag : '',
      instanceName: typeof body.instanceName === 'string' ? body.instanceName : '',
      portMappings: typeof body.portMappings === 'string' ? body.portMappings : '',
      envText: typeof body.envText === 'string' ? body.envText : '',
      mountsText: typeof body.mountsText === 'string' ? body.mountsText : '',
      storageMode: typeof body.storageMode === 'string' ? body.storageMode : '',
      hostRoot: typeof body.hostRoot === 'string' ? body.hostRoot : '',
      volumeName: typeof body.volumeName === 'string' ? body.volumeName : '',
      pull: body.pull !== false
    };
    const accepted = await dockerManager.runCustomImage(options);
    if (!accepted || typeof accepted.opId !== 'string') {
      return dockerManager.toErrorResponse({ code: 'INTERNAL_ERROR', message: 'Custom image run did not return an opId' });
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

ipcMain.handle('docker-manager:getLocalInstanceLogs', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const maxLines = body.maxLines;
    const result = await dockerManager.getLocalInstanceLogs(containerId, { maxLines });
    return sanitizeContainerLogsResult(result);
  } catch (error) {
    return dockerManager.toErrorResponse(error);
  }
});

ipcMain.handle('docker-manager:openLocalInstanceStorageFolder', async (_event, body) => {
  try {
    if (!isPlainObject(body)) return dockerManager.toErrorResponse({ code: 'INVALID_INPUT', message: 'Invalid request' });
    const containerId = typeof body.containerId === 'string' ? body.containerId : '';
    const result = await dockerManager.getLocalInstanceStorageFolder(containerId);
    return await openHostFolder(result?.path || '');
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

ipcMain.handle('docker-manager:selectInstanceHome', async () => {
  try {
    return selectInstanceHome();
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
  await cleanupStaleLauncherUpdaterArtifacts();
  configureLauncherAutoUpdate();
  createWindow();
  createTray();

  // Wait a moment for loading screen to render
  await new Promise(resolve => setTimeout(resolve, 500));

  const launcherUpdateCheck = checkForLauncherUpdates({ userInitiated: false });

  // Initialize content
  const success = await initializeAppContent();

  if (success) {
    await launcherUpdateCheck;
    contentInitialized = true;
    if (shouldHoldStartupForLauncherUpdate()) {
      return;
    }
    // Small delay for visual feedback
    await continueToAppContent({ delayMs: 800 });
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
        if (!shouldHoldStartupForLauncherUpdate()) {
          await continueToAppContent();
        }
      } else {
        // Content was deleted - reinitialize
        contentInitialized = false;
        const success = await initializeAppContent();
        if (success) {
          contentInitialized = true;
          if (!shouldHoldStartupForLauncherUpdate()) {
            await continueToAppContent({ delayMs: 800 });
          }
        }
      }
    } else {
      // First activation or previous init failed - run full initialization
      await new Promise(resolve => setTimeout(resolve, 500));
      const success = await initializeAppContent();

      if (success) {
        contentInitialized = true;
        if (!shouldHoldStartupForLauncherUpdate()) {
          await continueToAppContent({ delayMs: 800 });
        }
      }
    }
  }
});
